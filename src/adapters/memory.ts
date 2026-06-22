/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { chainHash, balanceDelta, GENESIS } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { currency, SYSTEM } from '#src/accounts.ts';
import { windowedVelocity } from '#src/trust.ts';
import { fromHex, toHex } from '#src/bytes.ts';
import { metaString, metaNumber } from '#src/adapters/sql-shared.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Transaction } from '#src/contract.ts';
import type {
  Attempt,
  Checkpoint,
  CheckpointStore,
  Clock,
  Digest,
  EntitlementStore,
  IdempotencyStore,
  Leg,
  Ledger,
  Lot,
  Options,
  OutboxMessage,
  OutboxStore,
  Posting,
  PromoGrant,
  PromoStore,
  Range,
  ReplayStore,
  Saga,
  SaleStore,
  Sale,
  SagaStore,
  Statement,
  Store,
  StoredLink,
  Subscription,
  SubscriptionStore,
  TrustStore,
  Unit,
} from '#src/ports.ts';
import type { EntitlementAttrs } from '#src/contract.ts';

// --- The per-store undo log -------------------------------------------------------

// Lets a store undo its writes if a transaction fails. While a transaction is open,
// every change records a function that reverses it; with no transaction open, nothing
// is recorded, so an ordinary write costs nothing extra. To roll back, the recorded
// reversers run in last-to-first order, so the work is proportional to how many writes
// happened, not to how much data the store holds.
interface Journal {
  begin(): void;
  commit(): void;
  rollback(): void;
  recording(): boolean;
  record(undo: () => void): void;
}

function createJournal(): Journal {
  let undos: Array<() => void> | null = null;
  return {
    begin: () => {
      if (undos) {
        throw new Error('in-memory transactions do not nest');
      }
      undos = [];
    },
    commit: () => {
      undos = null;
    },
    rollback: () => {
      if (!undos) {
        return;
      }
      for (let i = undos.length - 1; i >= 0; i -= 1) {
        undos[i]!();
      }
      undos = null;
    },
    recording: () => undos !== null,
    record: (undo) => {
      undos?.push(undo);
    },
  };
}

// A store that takes part in transactions exposes its journal, so the top-level store can
// start, commit, or roll back every taking-part store together.
interface Participant {
  journal: Journal;
}

// --- Default capabilities ---------------------------------------------------------

// The default hash function: SHA-256 from the platform's built-in `crypto.subtle`. The
// same input bytes hash to the same output on every runtime, so a plain `memoryStore()`
// gives reproducible results with no random seed and no Node-specific import.
function defaultDigest(): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  };
}

// The default clock: always returns time 0. This keeps each posting's `postedAt`
// predictable in tests. Pass a real clock when actual wall-clock time matters.
function defaultClock(): Clock {
  return { now: () => 0 };
}

// The hash value a brand-new account's chain starts from, as lowercase hex. GENESIS is
// 32 zero bytes, so this string is 64 zeros.
let GENESIS_HEX = toHex(GENESIS);

// --- The ledger store -------------------------------------------------------------

// One posting (a single recorded transaction) as stored in the in-memory log. The log is
// append-only and is the source of truth that statement and timeline reads are built from.
interface StoredPosting {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
  postedAt: number;
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;
}

// Whether an account is one the ledger will accept a posting against. True for a
// registered platform account, or for a user account whose id ends in a known kind
// (`:spendable`, `:earned`, or `:promo`). Anything else is rejected upstream: `postEntry`
// raises an UNKNOWN_ACCOUNT fault. This function only reports whether the account exists.
function isKnownAccount(account: AccountRef, registered: Set<string>): boolean {
  if (registered.has(account)) {
    return true;
  }
  let colon = account.lastIndexOf(':');
  if (colon < 0) {
    return false;
  }
  let suffix = account.slice(colon + 1);
  return suffix === 'spendable' || suffix === 'earned' || suffix === 'promo';
}

// All the mutable state of one ledger store, grouped into a single object so the helper
// functions below can live at module scope (taking this state as a parameter) instead of
// being nested inside the factory function.
interface LedgerState {
  journal: Journal;

  // Every posting, in the order it was appended.
  log: StoredPosting[];

  // Each account's current balance in minor units (cents), kept up to date as postings
  // are applied so reading a balance is a single map lookup.
  balances: Map<AccountRef, bigint>;

  // Each account's postings are linked into a per-account hash chain: every posting carries a
  // hash computed from the previous posting's hash plus its own contents, so altering an old
  // posting changes every hash after it and the tampering shows up. This map holds the latest
  // hash in each account's chain (its "head") as lowercase hex. A missing entry means the
  // account has no postings yet, so its head is the genesis hash (the chain's fixed start value).
  heads: Map<AccountRef, string>;

  // The set of platform account ids the ledger accepts directly. User accounts are not
  // listed here; they are recognized by their kind suffix instead.
  registered: Set<string>;
}

// One account's hash-chain step for a posting: the account, its head hash before this
// posting (prevHash), and its head hash after (hash).
type Link = { account: AccountRef; prevHash: string; hash: string };

/**
 * The in-memory ledger. Beyond the standard `Ledger` interface it adds `__tamper`, a
 * test-only back door (the `__` prefix marks it as not part of the real interface). It
 * edits a stored posting's entries in place but does NOT recompute the chain head, which
 * lets a test simulate an attacker who altered stored data while leaving the old hash
 * behind — exactly the corruption the chain check is meant to detect.
 */
export type MemoryLedger = Ledger &
  Participant & {
    __tamper(txnId: string, mutate: (legs: Leg[]) => void): void;
    // Plant a stored balance for an account that has no posting behind it and no entry in the
    // hash chain. The account then shows up when you list every stored balance
    // (`balanceAccounts()`) but never when you walk the accounts that have postings
    // (`heads()`). This fakes a stray balance row — one a direct database edit or a
    // half-finished write could leave behind — that the integrity checker must catch and report
    // as drift (a stored balance that no longer matches the balance its entries add up to).
    __seedBalance(account: AccountRef, amount: Amount): void;
  };

// The distinct accounts a posting touches, in first-seen order. A posting can list the
// same account more than once; we want each account once, because appending a posting
// advances exactly one chain head per distinct account.
function distinctAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
  let seen = new Set<AccountRef>();
  let order: AccountRef[] = [];
  for (let leg of legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      order.push(leg.account);
    }
  }
  return order;
}

// Compute the new chain-head hash for each account a posting touches, without yet writing
// anything. For each account, this hashes the account's previous head together with the
// posting's contents (`chainHash` in ledger.ts does the actual hashing). The previous head
// is decoded from the stored hex string, except for an account's very first posting, where
// the predecessor is the raw genesis bytes.
async function advanceChain(
  state: LedgerState,
  digest: Digest,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  let links: Link[] = [];
  for (let account of distinctAccounts(posting.legs)) {
    let prevHex = state.heads.get(account) ?? GENESIS_HEX;
    let accountPrevHash = prevHex === GENESIS_HEX ? GENESIS : fromHex(prevHex);
    let hash = await chainHash(digest, {
      accountPrevHash,
      txnId: posting.txnId,
      account,
      legs: posting.legs,
      meta: posting.meta,
    });
    links.push({ account, prevHash: prevHex, hash });
  }
  return links;
}

// Apply a posting to the ledger state: record it in the log, advance each touched
// account's chain head, and adjust each touched account's balance. Also registers an undo
// with the journal so a transaction can reverse it. The undo must delete any account this
// posting brought into existence, so that rolling back leaves no leftover zero-balance
// account (the same way a database ROLLBACK would leave no trace).
function commitPosting(state: LedgerState, stored: StoredPosting): void {
  let priorHeads = stored.links.map((link) => ({
    account: link.account,
    prev: state.heads.get(link.account),
  }));
  let created = state.journal.recording()
    ? new Set(
        stored.legs
          .filter((leg) => !state.balances.has(leg.account))
          .map((leg) => leg.account),
      )
    : null;

  state.log.push(stored);
  for (let link of stored.links) {
    state.heads.set(link.account, link.hash);
  }
  for (let leg of stored.legs) {
    let next =
      (state.balances.get(leg.account) ?? 0n) + balanceDelta(leg).minor;
    state.balances.set(leg.account, next);
  }

  state.journal.record(() => undoPosting(state, stored, priorHeads, created));
}

// The inverse of `commitPosting`: drop the posting from the log, restore each account's
// previous chain head, and undo each balance change. An account that this posting first
// created is removed (rather than left sitting at a zero balance) once its balance is back
// to zero.
function undoPosting(
  state: LedgerState,
  stored: StoredPosting,
  priorHeads: ReadonlyArray<{ account: AccountRef; prev: string | undefined }>,
  created: Set<AccountRef> | null,
): void {
  state.log.pop();
  for (let { account, prev } of priorHeads) {
    if (prev === undefined) {
      state.heads.delete(account);
    } else {
      state.heads.set(account, prev);
    }
  }
  for (let leg of stored.legs) {
    let next =
      (state.balances.get(leg.account) ?? 0n) - balanceDelta(leg).minor;
    if (next === 0n && created?.has(leg.account)) {
      state.balances.delete(leg.account);
    } else {
      state.balances.set(leg.account, next);
    }
  }
}

function createLedgerStore(deps: {
  digest: Digest;
  clock: Clock;
}): MemoryLedger {
  let state: LedgerState = {
    journal: createJournal(),
    log: [],
    // Kept up to date as postings are applied (using `balanceDelta` from ledger.ts to find
    // how each entry changes an account), so reading a balance is a single map lookup.
    balances: new Map(),
    // Per-account chain head as lowercase hex; a missing entry means genesis (no postings
    // yet).
    heads: new Map(),
    // Seeded from the list of platform accounts so they are accepted immediately. User
    // accounts are not listed here; they are recognized by their kind suffix instead.
    registered: new Set<string>(Object.values(SYSTEM)),
  };

  return {
    journal: state.journal,

    hasAccount: async (account) => isKnownAccount(account, state.registered),

    // Does nothing: this store runs one operation at a time, so there is nothing to lock
    // against. It exists only so callers can issue the same `lock` call against every adapter,
    // whether or not that adapter actually needs locking.
    lock: async () => {},

    append: async (posting) => {
      let postedAt = deps.clock.now();
      let links = await advanceChain(state, deps.digest, posting);
      let stored: StoredPosting = {
        txnId: posting.txnId,
        legs: posting.legs,
        meta: posting.meta,
        postedAt,
        links,
      };
      commitPosting(state, stored);
      return { id: stored.txnId, postedAt, legs: stored.legs, links };
    },

    balance: async (account) =>
      toAmount(currency(account), state.balances.get(account) ?? 0n),

    statement: async (account, range) =>
      buildStatement(state.log, account, range),

    timeline: (account) => timelineOf(state.log, account),

    heads: async function* () {
      for (let [account, head] of state.heads) {
        yield [account, head] as const;
      }
    },

    // Every account that has a stored balance, read from the `state.balances` keys rather than
    // from the postings — so an account that has a stored balance but no posting behind it (one
    // that walking `heads` would never reach) still gets reported to the integrity checker,
    // which flags it as a stored balance that should not exist. Copy the keys into a fresh array
    // first so iterating stays safe even if `state.balances` changes underneath us.
    balanceAccounts: async function* () {
      for (let account of [...state.balances.keys()]) {
        yield account;
      }
    },

    lineage: (account) => lineageOf(state.log, account),

    posting: async (txnId) => postingOf(state.log, txnId),

    __tamper: (txnId, mutate) => tamperPosting(state.log, txnId, mutate),

    __seedBalance: (account, amount) =>
      state.balances.set(account, amount.minor),
  };
}

// Build an account's statement: every entry in the time range whose posting touched this
// account. The range is half-open: postings at or after `from` and strictly before `to`.
// Each entry's amount is shown the way it changed this account's balance, so money coming
// into a user account reads as a positive number. This in-memory store returns everything
// in one page, so the next-page cursor is always null.
function buildStatement(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
  range: Range,
): Statement {
  let entries: Array<{ txnId: string; amount: Amount; postedAt: number }> = [];
  for (let row of log) {
    if (row.postedAt < range.from || row.postedAt >= range.to) {
      continue;
    }
    for (let leg of row.legs) {
      if (leg.account === account) {
        entries.push({
          txnId: row.txnId,
          amount: balanceDelta(leg),
          postedAt: row.postedAt,
        });
      }
    }
  }
  return { account, entries, cursor: null };
}

// Stream this account's incoming funds as lots, oldest first, for first-in-first-out
// settlement. Emit one lot for each posting entry that increased the account's balance.
// When a posting does not say where the money came from or when it becomes spendable
// (`source` / `maturesAt` in its metadata), fall back to "unknown" and "already mature
// now" — the safe defaults. The maturity rules themselves live in maturity.ts; this store
// just reports what each posting recorded.
async function* timelineOf(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
): AsyncIterable<Lot> {
  for (let row of log) {
    for (let leg of row.legs) {
      if (leg.account !== account) {
        continue;
      }
      let delta = balanceDelta(leg);
      if (delta.minor <= 0n) {
        continue;
      }
      yield {
        txnId: row.txnId,
        amount: delta,
        source: metaString(row.meta, 'source', 'unknown'),
        toppedUpAt: row.postedAt,
        maturesAt: metaNumber(row.meta, 'maturesAt', row.postedAt),
      };
    }
  }
}

// Stream every posting that touched this account, in order, with the exact data the chain
// verifier needs to recompute and check each chain-head hash. For each posting it yields
// the entries and metadata as originally appended, plus the head hash before (prevHash)
// and after (hash) that posting. Those are precisely the inputs `chainHash` was fed, so if
// `__tamper` later alters the stored entries, recomputing the hash from this data no longer
// matches the stored one — which is how tampering is caught.
async function* lineageOf(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
): AsyncIterable<StoredLink> {
  for (let row of log) {
    let link = row.links.find((entry) => entry.account === account);
    if (link) {
      yield {
        txnId: row.txnId,
        legs: row.legs,
        meta: row.meta,
        prevHash: link.prevHash,
        hash: link.hash,
      };
    }
  }
}

// Look up a whole posting by its transaction id and return all of its entries — unlike
// `lineage`, this is not narrowed to one account. The `reverse` operation uses this to
// build the exact opposite of an earlier posting. Returns null when no posting has that id,
// so the caller can fail cleanly instead of guessing.
function postingOf(
  log: ReadonlyArray<StoredPosting>,
  txnId: string,
): Posting | null {
  let row = log.find((entry) => entry.txnId === txnId);
  if (!row) {
    return null;
  }
  return { txnId: row.txnId, legs: row.legs, meta: row.meta };
}

// Test-only; never call this in production. It edits a stored posting's entries in place
// but leaves the recorded chain links (and their stored hashes) unchanged. Recomputing the
// hash from the altered entries then no longer matches the stored hash — the exact kind of
// corruption the chain check is designed to catch.
function tamperPosting(
  log: ReadonlyArray<StoredPosting>,
  txnId: string,
  mutate: (legs: Leg[]) => void,
): void {
  let row = log.find((entry) => entry.txnId === txnId);
  if (row) {
    mutate(row.legs as Leg[]);
  }
}

// --- Idempotency store ------------------------------------------------------------

// Makes a repeated request safe to run once. `claim` either grants a first-time caller the
// right to proceed, or replays the result of a previous identical request. A brand-new
// key is marked "pending" through the journal, so if the operation rolls back, the key
// goes back to unused and a later retry can still succeed — a failed attempt never
// permanently consumes the key. Because this store is single-threaded, "pending" is the
// whole notion of "claimed but not yet finished"; `record` turns a pending key into a
// committed result once the operation succeeds.
function createIdempotencyStore(): IdempotencyStore & Participant {
  let journal = createJournal();
  let committed = new Map<string, Transaction>();
  let pending = new Set<string>();

  return {
    journal,

    claim: async (key, _options?: Options) => {
      let prior = committed.get(key);
      if (prior) {
        return { claimed: false, transaction: prior };
      }
      pending.add(key);
      journal.record(() => pending.delete(key));
      return { claimed: true };
    },

    record: async (key, transaction, _options?: Options) => {
      committed.set(key, transaction);
      pending.delete(key);
      journal.record(() => {
        committed.delete(key);
        pending.add(key);
      });
    },
  };
}

// --- Sale store -------------------------------------------------------------------

// Records each completed sale, keyed by its order id (a separate key from the idempotency
// key). Keeping the sale lets a later refund reverse exactly what the original purchase
// posted.
function createSaleStore(): SaleStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, Sale>();
  return {
    journal,
    put: async (sale, _options?: Options) => {
      let prior = rows.get(sale.orderId);
      let had = rows.has(sale.orderId);
      rows.set(sale.orderId, sale);
      journal.record(() =>
        had ? rows.set(sale.orderId, prior!) : rows.delete(sale.orderId),
      );
    },
    get: async (orderId, _options?: Options) => rows.get(orderId) ?? null,
  };
}

// --- Outbox store -----------------------------------------------------------------

// Holds outgoing events so they are saved in the same transaction as the money movement
// that produced them — if that transaction rolls back, the event is never sent. A separate
// relay later picks up pending messages (`claimBatch`) and marks them sent (`markRelayed`);
// the receiver drops duplicates by message id, so each event is delivered at least once but
// acted on once.
function createOutboxStore(): OutboxStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, OutboxMessage>();
  let order: string[] = [];
  // Why a message was dead-lettered (given up on after too many delivery attempts),
  // stored separately because the outbox row itself has no field for it — the same
  // pattern the saga store uses for its dead-letter reasons.
  let reasons = new Map<string, string>();

  return {
    journal,
    enqueue: async (message, _options?: Options) => {
      rows.set(message.id, message);
      order.push(message.id);
      journal.record(() => {
        rows.delete(message.id);
        order.pop();
      });
    },
    claimBatch: async (limit, _options?: Options) => {
      let batch: OutboxMessage[] = [];
      for (let id of order) {
        if (batch.length >= limit) {
          break;
        }
        let message = rows.get(id);
        // Only 'pending' rows are ever handed back: a 'relayed' or 'failed' row is
        // terminal, so this `=== 'pending'` test is what excludes both of them.
        if (message && message.status === 'pending') {
          batch.push({ ...message });
        }
      }
      return batch;
    },
    markRelayed: async (ids, _options?: Options) => {
      for (let id of ids) {
        let message = rows.get(id);
        if (message && message.status === 'pending') {
          let prior = message.status;
          journal.record(() => {
            message.status = prior;
          });
          message.status = 'relayed';
        }
      }
    },
    recordFailure: async (id, _options?: Options) => {
      let message = rows.get(id);
      // No-op on a missing or already-terminal row: only a still-'pending' message
      // gets its attempt counted. This never changes the status — that is deadLetter's
      // job — it only bumps the retry counter so the next sweep can try again.
      if (!message || message.status !== 'pending') {
        return;
      }
      let prior = message.attempts;
      journal.record(() => {
        message.attempts = prior;
      });
      message.attempts += 1;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      let message = rows.get(id);
      // No-op on a missing or already-terminal row, mirroring the saga store. Flipping
      // the status to 'failed' is what keeps `claimBatch` from ever handing this poison
      // message back again.
      if (!message || message.status !== 'pending') {
        return;
      }
      let priorStatus = message.status;
      let hadReason = reasons.has(id);
      let priorReason = reasons.get(id);
      journal.record(() => {
        message.status = priorStatus;
        if (hadReason) {
          reasons.set(id, priorReason!);
        } else {
          reasons.delete(id);
        }
      });
      message.status = 'failed';
      reasons.set(id, reason);
    },
  };
}

// --- Saga store -------------------------------------------------------------------

// Tracks each multi-step payout as it moves through its states. `advance` only changes a
// saga if it is still in the state the caller expected (`from`); otherwise it returns false
// and changes nothing. This guards against two background runs advancing the same saga
// twice.
function createSagaStore(): SagaStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, Saga>();
  // The reason a saga was given up on (dead-lettered), stored separately because the saga
  // record itself has no field for it.
  let reasons = new Map<string, string>();

  return {
    journal,
    open: async (saga, _options?: Options) => {
      let prior = rows.get(saga.id);
      let had = rows.has(saga.id);
      rows.set(saga.id, { ...saga });
      journal.record(() =>
        had ? rows.set(saga.id, prior!) : rows.delete(saga.id),
      );
    },
    load: async (id, _options?: Options) => {
      let saga = rows.get(id);
      return saga ? { ...saga } : null;
    },
    claimDue: async (now, limit, _options?: Options) => {
      let due: Saga[] = [];
      for (let saga of rows.values()) {
        if (due.length >= limit) {
          break;
        }
        if (
          saga.dueAt <= now &&
          saga.state !== 'SETTLED' &&
          saga.state !== 'FAILED'
        ) {
          due.push({ ...saga });
        }
      }
      return due;
    },
    // The `options?` 5th param from the SagaStore.advance signature is intentionally
    // omitted here: a 4-param implementation still structurally satisfies the interface
    // (TypeScript lets an implementation ignore trailing params), and adding it would trip
    // the repo's lint rule that caps any function at four parameters. The other sub-store
    // methods, which each take four parameters or fewer, carry their `options?` for
    // signature parity.
    advance: async (id, from, to, patch) => {
      let saga = rows.get(id);
      if (!saga || saga.state !== from) {
        return false;
      }
      let prior = { ...saga };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...saga, ...patch, state: to });
      return true;
    },
    lastPayoutAt: async (userId, _options?: Options) => {
      // The largest `updatedAt` across ALL of this user's sagas in any state (a saga's
      // `updatedAt` is its request time at open() and only moves forward), or null when
      // the user has no sagas at all so their first request is always allowed. Read-only,
      // so it records no journal undo.
      let max: number | null = null;
      for (let saga of rows.values()) {
        if (saga.userId === userId) {
          max = max === null ? saga.updatedAt : Math.max(max, saga.updatedAt);
        }
      }
      return max;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      let saga = rows.get(id);
      if (!saga) {
        return;
      }
      let prior = { ...saga };
      let hadReason = reasons.has(id);
      let priorReason = reasons.get(id);
      journal.record(() => {
        rows.set(id, prior);
        if (hadReason) {
          reasons.set(id, priorReason!);
        } else {
          reasons.delete(id);
        }
      });
      rows.set(id, { ...saga, state: 'FAILED' });
      reasons.set(id, reason);
    },
  };
}

// --- Entitlement store ------------------------------------------------------------

// One stored ownership row: the attributes the grant carried, plus a `revoked` flag. When
// ownership is revoked the row is kept and the flag is set instead of deleting the row (a
// soft delete), so the history of who owned what survives for auditing after a refund or
// clawback.
interface EntitlementRow {
  attrs: EntitlementAttrs;
  revoked: boolean;
}

// Tracks who owns what (for example, which user owns which item) — plain ownership records,
// not money movements. `revoke` does a soft delete: it keeps the row and sets its `revoked`
// flag, so `owns` reports false while the row still survives for auditing. `owns` also checks
// the grant's `expiresAt` against the clock, so a rental or trial that has passed its expiry
// stops counting as owned.
function createEntitlementStore(deps: {
  clock: Clock;
}): EntitlementStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, EntitlementRow>();
  let keyOf = (userId: string, sku: string): string => `${userId}::${sku}`;

  function recordUndo(key: string): void {
    let prior = rows.get(key);
    let had = rows.has(key);
    journal.record(() => (had ? rows.set(key, prior!) : rows.delete(key)));
  }

  return {
    journal,
    grant: async (userId, sku, attrs, _options?: Options) => {
      // Insert or overwrite the row, clearing any earlier revoke (`revoked: false`), so buying
      // the same item again after a refund makes the user own it once more.
      let key = keyOf(userId, sku);
      recordUndo(key);
      rows.set(key, { attrs: { ...attrs }, revoked: false });
    },
    revoke: async (userId, sku, _options?: Options) => {
      // Soft delete: keep the row, flip `revoked`. A no-op (and never an undo) on an absent
      // or already-revoked row, so refund/clawback can call it idempotently.
      let key = keyOf(userId, sku);
      let row = rows.get(key);
      if (!row || row.revoked) {
        return;
      }
      recordUndo(key);
      rows.set(key, { ...row, revoked: true });
    },
    owns: async (userId, sku, _options?: Options) => {
      // Ownership requires a live (non-revoked) row that has not expired. The expiry check is
      // inclusive of `expiresAt`: still owned exactly AT that time, no longer owned once the clock
      // is past it. A row with no `expiresAt` never expires. Read-only — no auto-purge of expired
      // rows.
      let row = rows.get(keyOf(userId, sku));
      if (!row || row.revoked) {
        return false;
      }
      let expiresAt = row.attrs.expiresAt;
      return expiresAt == null || deps.clock.now() <= expiresAt;
    },
  };
}

// --- Subscription store -----------------------------------------------------------

// Tracks each subscription through its life: active, then billed period after period, until
// it is canceled by the user or lapses (a renewal couldn't be funded). `claimDue` finds the
// active subscriptions whose next charge is due, for the recurring billing sweep.
function createSubscriptionStore(): SubscriptionStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, Subscription>();

  return {
    journal,
    open: async (sub, _options?: Options) => {
      let prior = rows.get(sub.id);
      let had = rows.has(sub.id);
      rows.set(sub.id, { ...sub });
      journal.record(() =>
        had ? rows.set(sub.id, prior!) : rows.delete(sub.id),
      );
    },
    load: async (id, _options?: Options) => {
      let sub = rows.get(id);
      return sub ? { ...sub } : null;
    },
    activeFor: async (userId, sku, sellerId, _options?: Options) => {
      for (let sub of rows.values()) {
        if (
          sub.userId === userId &&
          sub.sku === sku &&
          sub.sellerId === sellerId &&
          sub.state === 'ACTIVE'
        ) {
          return { ...sub };
        }
      }
      return null;
    },
    cancel: async (id, _options?: Options) => {
      let sub = rows.get(id);
      if (!sub) {
        return;
      }
      let prior = { ...sub };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...sub, state: 'CANCELED' });
    },
    claimDue: async (now, limit, _options?: Options) => {
      let due: Subscription[] = [];
      for (let sub of rows.values()) {
        if (due.length >= limit) {
          break;
        }
        if (sub.state === 'ACTIVE' && sub.nextDueAt <= now) {
          due.push({ ...sub });
        }
      }
      return due;
    },
    markBilled: async (id, nextDueAt, expectedDueAt, _options?: Options) => {
      // Only advance the subscription if its current `nextDueAt` still equals the `expectedDueAt`
      // the billing sweep saw when it picked this row up; otherwise return false and change
      // nothing. If two billing sweeps overlap and both grab the same due date, the first one to
      // run moves `nextDueAt` forward, so the second one no longer matches and bails out — which
      // is how a single billing period gets charged at most once. SagaStore.advance guards itself
      // the same way (check the expected state, then update).
      let sub = rows.get(id);
      if (!sub || sub.nextDueAt !== expectedDueAt) {
        return false;
      }
      let prior = { ...sub };
      journal.record(() => rows.set(id, prior));
      // A successful renewal resets the retryable-failure counter to 0, so a
      // subscription that recovered after a few transient failures starts fresh and
      // doesn't carry old failures toward the lapse cap. markLapsed leaves attempts as-is.
      rows.set(id, { ...sub, nextDueAt, period: sub.period + 1, attempts: 0 });
      return true;
    },
    markLapsed: async (id, _options?: Options) => {
      let sub = rows.get(id);
      if (!sub) {
        return;
      }
      let prior = { ...sub };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...sub, state: 'LAPSED' });
    },
  };
}

// --- Promo store ------------------------------------------------------------------

// Tracks each marketing promo grant so the background promo-expiry sweep can later reverse
// whatever the user hasn't spent once the grant expires. `grantPromo` records the grant
// here in the same transaction as the credit posting; the sweep claims due grants
// (`expiresAt` passed, not yet reversed) oldest first, reverses the unspent remainder, then
// marks each reversed so it is never reversed twice.
function createPromoStore(): PromoStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, PromoGrant>();

  return {
    journal,
    open: async (grant, _options?: Options) => {
      // Opening the same grant twice does nothing the second time and never overwrites the
      // first row. SagaStore.open and SubscriptionStore.open instead replace an existing row
      // with the same id, but here the grant id is the same as its posting's transaction id, so
      // re-opening must leave the existing grant untouched.
      if (rows.has(grant.id)) {
        return;
      }
      journal.record(() => rows.delete(grant.id));
      rows.set(grant.id, { ...grant });
    },
    claimDue: async (now, limit, _options?: Options) => {
      // Every still-live grant whose `expiresAt` has passed, sorted oldest first ACROSS the
      // whole table before the `limit` cap, so "oldest first" holds globally rather than in
      // map-iteration order. Read-only, so it records no journal undo.
      let due: PromoGrant[] = [];
      for (let grant of rows.values()) {
        if (grant.reversed === false && grant.expiresAt <= now) {
          due.push({ ...grant });
        }
      }
      due.sort((a, b) => a.expiresAt - b.expiresAt);
      return due.slice(0, limit);
    },
    markReversed: async (id, _options?: Options) => {
      // No-op on a missing or already-reversed row (the same read-modify guard the saga and
      // outbox dead-letters use), so re-running the sweep over one grant is harmless.
      let grant = rows.get(id);
      if (!grant || grant.reversed) {
        return;
      }
      let prior = { ...grant };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...grant, reversed: true });
    },
  };
}

// --- Trust store (written outside transactions) -----------------------------------

// Counts how much a subject has spent and tried to spend recently, for rate/abuse limiting. Its
// writes deliberately sit OUTSIDE the money transaction, so even a rejected attempt still counts
// toward the limit (a rollback must not erase the attempt). `bump` ignores a repeat of an attempt
// it has already seen (matched by idempotency key), so a retry never gets counted twice.
//
// Attempts are kept as a per-subject list, not a single running total, so `read` can apply the
// sliding window: it sums only the attempts inside the last `windowMs` (via `windowedVelocity`),
// the same rolling window the SQL adapters get from `SUM(amount) WHERE at > cutoff`. The store
// once kept a grow-forever running total that never aged out, so the limit stuck once first hit.
function createTrustStore(clock: Clock, windowMs: number): TrustStore {
  let attemptsBySubject = new Map<string, Attempt[]>();
  let seenAttempts = new Set<string>();

  // Append an attempt to its subject's list, deduplicated on idempotency key so a genuine retry
  // is never counted twice. Returns nothing — both `bump` and `record` use it to apply the write.
  let insert = (subject: string, attempt: Attempt): void => {
    if (seenAttempts.has(attempt.idempotencyKey)) {
      return;
    }
    seenAttempts.add(attempt.idempotencyKey);
    let list = attemptsBySubject.get(subject);
    if (list === undefined) {
      list = [];
      attemptsBySubject.set(subject, list);
    }
    list.push(attempt);
  };

  return {
    read: async (subject, _options?: Options) =>
      windowedVelocity(
        subject,
        attemptsBySubject.get(subject) ?? [],
        clock.now(),
        windowMs,
      ),
    bump: async (subject, attempt, _options?: Options) =>
      insert(subject, attempt),
    // Record-and-measure in one step. Because JS is single-threaded, the dedup-insert and the
    // windowing below run with no `await` between them, so two concurrent same-subject `record`
    // calls can't interleave: each one sees its own attempt already in the list when it measures.
    // That atomicity is what closes the velocity-limit TOCTOU the old separate read+bump left open.
    record: async (subject, attempt, _options?: Options) => {
      insert(subject, attempt);
      return windowedVelocity(
        subject,
        attemptsBySubject.get(subject) ?? [],
        clock.now(),
        windowMs,
      );
    },
  };
}

// --- Checkpoint store -------------------------------------------------------------

// Stores checkpoints (periodic signed snapshots of the ledger's state). It is append-only
// and never takes part in a money transaction, so rolling back a transaction can never
// delete a checkpoint that was already recorded.
function createCheckpointStore(): CheckpointStore {
  let rows: Checkpoint[] = [];
  return {
    put: async (checkpoint, _options?: Options) => {
      rows.push({ ...checkpoint });
    },
    latest: async (_options?: Options) => {
      let last = rows[rows.length - 1];
      return last ? { ...last } : null;
    },
  };
}

// --- Replay store -----------------------------------------------------------------

// Drops duplicate incoming webhooks from a payment provider, matching each one by the event id
// the provider assigned. This is a separate id space from the idempotency keys our own callers
// send (the value that makes a retried request run at most once). When a webhook arrives, the
// handler records its event id here as the final check — after it has verified the signature and
// that the event is recent — and does so on its own, not inside a money transaction. Because it
// is outside the transaction, this store does not register undo steps and is never rolled back.
// In SQL adapters this is the `seen_webhooks` table; here it is just a Set.
function createReplayStore(): ReplayStore {
  let seen = new Set<string>();
  return {
    claim: async (eventId, _options?: Options) => {
      // Atomic insert-if-absent: the first sighting of an id wins (`claimed: true`); every later
      // sighting is a duplicate (`claimed: false`), so a redelivered webhook is processed at most
      // once.
      if (seen.has(eventId)) {
        return { claimed: false };
      }
      seen.add(eventId);
      return { claimed: true };
    },
  };
}

// --- The assembled store ----------------------------------------------------------

/**
 * Build an in-memory {@link Store} with working transaction rollback, suitable for tests
 * and development. If the work inside a `transaction` throws, every store that joined the
 * transaction is rolled back, each independently so that one store's failing rollback can't
 * stop the others from rolling back. The trust and checkpoint stores are written outside
 * transactions and so are not rolled back. The hash function and clock default to
 * deterministic versions, so a plain `memoryStore()` produces reproducible results.
 */
export function memoryStore(deps?: {
  digest?: Digest;
  clock?: Clock;
  velocityWindowMs?: number;
}): Store {
  let digest = deps?.digest ?? defaultDigest();
  let clock = deps?.clock ?? defaultClock();
  // The rolling window the trust store applies when it sums a subject's recent attempts. Defaults
  // to one hour (matching config's default); the real composition passes config.velocityWindowMs.
  let velocityWindowMs = deps?.velocityWindowMs ?? 60 * 60_000;

  let ledger = createLedgerStore({ digest, clock });
  let idempotency = createIdempotencyStore();
  let sales = createSaleStore();
  let outbox = createOutboxStore();
  let sagas = createSagaStore();
  let entitlements = createEntitlementStore({ clock });
  let subscriptions = createSubscriptionStore();
  let promos = createPromoStore();
  let trust = createTrustStore(clock, velocityWindowMs);
  let checkpoints = createCheckpointStore();
  // The webhook duplicate check runs outside any money transaction (it is the final check when a
  // webhook arrives), so it does not take part in rollback and is not handed to operation
  // handlers — it lives only on the top-level store.
  let replay = createReplayStore();

  // The set of stores a handler is allowed to use inside a transaction. The trust and
  // checkpoint stores are deliberately left out, because they are written outside
  // transactions.
  let unit: Unit = {
    ledger,
    idempotency,
    sales,
    outbox,
    sagas,
    entitlements,
    subscriptions,
    promos,
  };
  let participants: Participant[] = [
    ledger,
    idempotency,
    sales,
    outbox,
    sagas,
    entitlements,
    subscriptions,
    promos,
  ];

  return {
    ledger,
    idempotency,
    sales,
    outbox,
    sagas,
    entitlements,
    subscriptions,
    promos,
    trust,
    checkpoints,
    replay,
    transaction: async (work) => {
      let begun = 0;
      try {
        for (let participant of participants) {
          participant.journal.begin();
          begun += 1;
        }
        let result = await work(unit);
        for (let participant of participants) {
          participant.journal.commit();
        }
        return result;
      } catch (error) {
        rollbackAll(participants, begun);
        throw error;
      }
    },
    close: async () => {},
  };
}

// Roll back only the stores that actually started this transaction (the first `begun` of
// them), newest first. Each rollback is wrapped so that if one throws, the rest still roll
// back — otherwise a leftover open transaction could corrupt the next one.
function rollbackAll(participants: Participant[], begun: number): void {
  for (let i = begun - 1; i >= 0; i -= 1) {
    try {
      participants[i]!.journal.rollback();
    } catch {
      // Best effort: ignore this one's failure and keep rolling back the others.
    }
  }
}
