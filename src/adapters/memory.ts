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
import { metaString, metaNumber } from '#src/meta.ts';

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
  InboxEntry,
  InboxStore,
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

// --- Per-store undo log -----------------------------------------------------------

// Undoes a store's writes when a transaction fails. While a transaction is open, every change
// records a reverser; with none open, nothing is recorded. Rollback runs the reversers
// last-to-first, so cost is proportional to writes, not to stored data.
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

// A store that joins transactions exposes its journal, so the top-level store can begin,
// commit, or roll back every participant together.
interface Participant {
  journal: Journal;
}

// --- Default capabilities ---------------------------------------------------------

// Default hash: SHA-256 via the platform `crypto.subtle`. Deterministic across runtimes, so a
// plain `memoryStore()` is reproducible with no seed and no Node-specific import.
function defaultDigest(): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  };
}

// Default clock: always returns time 0, keeping each posting's `postedAt` predictable in
// tests. Pass a real clock when wall-clock time matters.
function defaultClock(): Clock {
  return { now: () => 0 };
}

// Starting hash for a new account's chain, as lowercase hex. GENESIS is 32 zero bytes, so
// this is 64 zeros.
let GENESIS_HEX = toHex(GENESIS);

// --- Ledger store -----------------------------------------------------------------

// One posting as stored in the append-only log, the source of truth for statement and
// timeline reads.
interface StoredPosting {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
  postedAt: number;
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;
}

// Whether the ledger accepts a posting against this account: true for a registered platform
// account, or a user account whose id ends in a known kind (`:spendable`, `:earned`,
// `:promo`). Anything else is rejected upstream (`postEntry` raises UNKNOWN_ACCOUNT). Reports
// existence only.
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

// Mutable state of one ledger store, grouped so the helpers below can live at module scope
// (taking it as a parameter) rather than nested in the factory.
interface LedgerState {
  journal: Journal;

  // Every posting, in the order it was appended.
  log: StoredPosting[];

  // Balance per account in minor units (cents), kept current as postings apply so a balance
  // read is a single map lookup.
  balances: Map<AccountRef, bigint>;

  // Per-account hash chain: each posting's hash covers the previous hash plus its own
  // contents, so altering an old posting changes every later hash. Holds the latest hash (the
  // head) per account as lowercase hex; a missing entry means no postings yet, so the head is
  // the genesis hash.
  heads: Map<AccountRef, string>;

  // Platform account ids the ledger accepts directly. User accounts aren't listed; they are
  // recognized by their kind suffix.
  registered: Set<string>;
}

// One account's hash-chain step for a posting: the account, its head before (prevHash) and
// after (hash).
type Link = { account: AccountRef; prevHash: string; hash: string };

/**
 * In-memory ledger. Adds `__tamper`, a test-only back door (the `__` prefix marks it as not
 * part of the real interface): edits a stored posting's entries in place without recomputing
 * the chain head, simulating an attacker who altered stored data and left the old hash behind,
 * the corruption the chain check detects.
 */
export type MemoryLedger = Ledger &
  Participant & {
    __tamper(txnId: string, mutate: (legs: Leg[]) => void): void;
    // Plant a stored balance for an account with no posting and no chain entry. It then shows
    // up in `balanceAccounts()` but never in `heads()`, faking a stray balance row (direct DB
    // edit or half-finished write) the integrity checker must report as drift: a stored
    // balance no longer matching the sum of its entries.
    __seedBalance(account: AccountRef, amount: Amount): void;
  };

// Distinct accounts a posting touches, in first-seen order. A posting may list an account more
// than once; each is wanted once, since appending advances one chain head per distinct account.
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

// Compute the new chain-head hash for each touched account, without writing. Hashes the
// account's previous head with the posting's contents (`chainHash` in ledger.ts). The previous
// head is decoded from the stored hex, except an account's first posting, where the
// predecessor is the raw genesis bytes.
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

// Apply a posting: record it in the log, advance each touched account's chain head, adjust each
// touched balance. Registers an undo so a transaction can reverse it. The undo deletes any
// account this posting first created, so rollback leaves no leftover zero-balance account.
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

// Inverse of `commitPosting`: drop the posting from the log, restore each previous chain
// head, undo each balance change. An account this posting first created is removed (not left
// at zero) once its balance is back to zero.
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
    // Kept current as postings apply (`balanceDelta` from ledger.ts gives each entry's effect),
    // so a balance read is a single map lookup.
    balances: new Map(),
    heads: new Map(),
    // Seeded from the platform accounts so they're accepted immediately.
    registered: new Set<string>(Object.values(SYSTEM)),
  };

  return {
    journal: state.journal,

    hasAccount: async (account) => isKnownAccount(account, state.registered),

    // No-op: this store runs one operation at a time, so there's nothing to lock against.
    // Present so callers can issue the same `lock` against every adapter, whether or not that
    // adapter needs it.
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

    timeline: (account, options) => timelineOf(state.log, account, options),

    heads: async function* () {
      for (let [account, head] of state.heads) {
        yield [account, head] as const;
      }
    },

    // Every account with a stored balance, read from `state.balances` keys rather than from
    // postings, so an account with a balance but no posting (which walking `heads` would never
    // reach) still reaches the integrity checker, which flags it as a balance that shouldn't
    // exist. Copy the keys first so iteration is safe if `state.balances` changes underneath.
    balanceAccounts: async function* () {
      for (let account of [...state.balances.keys()]) {
        yield account;
      }
    },

    lineage: (account) => lineageOf(state.log, account),

    posting: async (txnId) => postingOf(state.log, txnId),

    list: () => listPostingsOf(state.log),

    __tamper: (txnId, mutate) => tamperPosting(state.log, txnId, mutate),

    __seedBalance: (account, amount) =>
      state.balances.set(account, amount.minor),
  };
}

// An account's statement: every entry in the range whose posting touched this account. The
// range is half-open (postedAt >= from, < to). Each amount is signed by how it changed this
// account's balance, so money into a user account reads positive. Everything fits one page, so
// the cursor is always null.
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

// Stream this account's incoming funds as lots for FIFO settlement. One lot per posting entry
// that increased the balance. When a posting's metadata omits `source` or `maturesAt`, fall back
// to "unknown" and mature-now. Maturity rules live in maturity.ts; this store reports what each
// posting recorded.
//
// `options` mirrors the SQL engines: 'asc' (default) yields oldest-first like the log's commit
// order; 'desc' yields newest-first. `offset`/`limit` page that order so the maturity tail can
// pull just the newest run instead of the whole history. The log array index is the in-memory
// analogue of the SQL `seq`, so reversing it gives the same total order `order by seq desc` does,
// and `limit` is honoured by stopping early rather than materializing every lot.
async function* timelineOf(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
  options?: { order?: 'asc' | 'desc'; limit?: number; offset?: number },
): AsyncIterable<Lot> {
  let order = options?.order ?? 'asc';
  let offset = options?.offset ?? 0;
  let limit = options?.limit ?? Infinity;

  // Walk the log in the requested direction; the log is already in commit (asc) order.
  let indices =
    order === 'desc'
      ? rangeDown(log.length - 1, 0)
      : rangeUp(0, log.length - 1);

  let skipped = 0;
  let yielded = 0;
  for (let i of indices) {
    if (yielded >= limit) {
      break;
    }
    let row = log[i]!;
    for (let leg of row.legs) {
      if (leg.account !== account) {
        continue;
      }
      let delta = balanceDelta(leg);
      if (delta.minor <= 0n) {
        continue;
      }
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (yielded >= limit) {
        break;
      }
      yielded += 1;
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

// Ascending index walk [lo..hi]; empty when hi < lo. Kept as a generator so timelineOf can stop
// early without building an index array.
function* rangeUp(lo: number, hi: number): Generator<number> {
  for (let i = lo; i <= hi; i += 1) {
    yield i;
  }
}

// Descending index walk [hi..lo]; empty when hi < lo.
function* rangeDown(hi: number, lo: number): Generator<number> {
  for (let i = hi; i >= lo; i -= 1) {
    yield i;
  }
}

// Stream every posting that touched this account, in order, with the data the chain verifier
// needs to recompute and check each head hash: the entries and metadata as appended, plus the
// head before (prevHash) and after (hash). These are the inputs `chainHash` was fed, so if
// `__tamper` alters the stored entries, the recomputed hash no longer matches the stored one.
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

// Look up a whole posting by transaction id and return all its entries (unlike `lineage`,
// not narrowed to one account). `reverse` uses this to build the opposite of an earlier
// posting. Returns null when no posting has that id.
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

// Whole ledger, newest commit first (see Ledger.list). The append-only `log` already holds postings
// in commit order (its array index is the in-memory analogue of the SQL engines' `seq`), so reverse
// a snapshot rather than sort — the same total order `order by seq desc` gives, with no tie to break.
// Snapshot first so iteration is safe if `log` changes underneath, and copy each posting's fields so
// a consumer can't mutate stored state. Module-level (like postingOf) to keep createLedgerStore short.
async function* listPostingsOf(
  log: ReadonlyArray<StoredPosting>,
): AsyncIterable<Posting> {
  let snapshot = [...log].reverse();
  for (let posting of snapshot) {
    yield { txnId: posting.txnId, legs: posting.legs, meta: posting.meta };
  }
}

// Test-only. Implements `__tamper`; see the MemoryLedger type JSDoc for why this is the
// corruption the chain check detects.
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
// right to proceed or replays a prior identical request's result. A new key is marked pending
// through the journal, so a rollback returns it to unused and a later retry can still succeed; a
// failed attempt never permanently consumes the key. Single-threaded, so pending is the only
// "claimed but not finished" state; `record` turns a pending key into a committed result on
// success.
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

// Records each completed sale, keyed by order id (separate from the idempotency key), so a
// later refund can reverse what the original purchase posted.
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

// Holds outgoing events so they're saved in the same transaction as the money movement that
// produced them; if it rolls back, the event is never sent. A separate relay picks up pending
// messages (`claimBatch`) and marks them sent (`markRelayed`); the receiver drops duplicates
// by message id, so each event is delivered at least once but acted on once.
function createOutboxStore(): OutboxStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, OutboxMessage>();
  let order: string[] = [];

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
        // Only 'pending' rows are handed back; 'relayed' and 'failed' are terminal, both
        // excluded by this `=== 'pending'` test.
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
      // No-op on a missing or already-terminal row; only a still-'pending' message gets its
      // attempt counted. Doesn't change status (deadLetter's job), only bumps the retry counter
      // so the next sweep can try again.
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
      // No-op on a missing or already-terminal row, mirroring the saga store. Flipping status
      // to 'failed' keeps `claimBatch` from handing this poison message back again.
      if (!message || message.status !== 'pending') {
        return;
      }
      let prior = { ...message };
      journal.record(() => rows.set(id, prior));
      // Flip to 'failed' and record the failure reason on the message itself, so the dead-letter
      // outcome travels with the row instead of a side map.
      rows.set(id, { ...message, status: 'failed', reason });
    },
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox: holds verified provider events (each already mapped to the
// operation it applies) so they're saved in the same transaction as the webhook ingress that
// claimed them; a separate apply worker picks up pending rows (`claimInbound`), submits each
// operation, and marks them applied (`markApplied`). Dedupes on `key` (the provider event id) at
// enqueue, returning the existing row for a redelivered event so it's applied at most once.
function createInboxStore(): InboxStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, InboxEntry>();
  let order: string[] = [];
  // Maps a provider event id (`key`) to the row id it was first enqueued under, so a redelivered
  // event resolves to the existing row instead of inserting a duplicate.
  let byKey = new Map<string, string>();

  return {
    journal,
    enqueueInbound: async (entry, _options?: Options) => {
      // Dedupe on the provider event id: a duplicate is a no-op that returns the row already
      // stored under that key, so a redelivered event is applied at most once. Only a first
      // sighting inserts and records an undo.
      let existingId = byKey.get(entry.key);
      if (existingId !== undefined) {
        return { ...rows.get(existingId)! };
      }
      rows.set(entry.id, { ...entry });
      order.push(entry.id);
      byKey.set(entry.key, entry.id);
      journal.record(() => {
        rows.delete(entry.id);
        order.pop();
        byKey.delete(entry.key);
      });
      return { ...entry };
    },
    claimInbound: async (input, _options?: Options) => {
      // Pending rows oldest `receivedAt` first, sorted across the whole table before the `limit`
      // cap so oldest-first holds globally rather than in insertion order. Only 'pending' rows are
      // handed back; 'applied' and 'dead' are terminal, both excluded by this `=== 'pending'`
      // test. `input.now` is accepted for parity with the saga/relay claim; the inbox has no
      // due-time gate, so every pending row is immediately claimable.
      let pending: InboxEntry[] = [];
      for (let id of order) {
        let entry = rows.get(id);
        if (entry && entry.status === 'pending') {
          pending.push({ ...entry });
        }
      }
      pending.sort((a, b) => a.receivedAt - b.receivedAt);
      return pending.slice(0, input.limit);
    },
    markApplied: async (id, _options?: Options) => {
      let entry = rows.get(id);
      // No-op on a missing or already-terminal row; only a still-'pending' row flips to 'applied',
      // so `claimInbound` never hands it back again.
      if (!entry || entry.status !== 'pending') {
        return;
      }
      let prior = entry.status;
      journal.record(() => {
        entry.status = prior;
      });
      entry.status = 'applied';
    },
    bumpAttempt: async (id, _options?: Options) => {
      let entry = rows.get(id);
      // No-op on a missing or already-terminal row; only a still-'pending' row gets its attempt
      // counted. Doesn't change status (deadLetter's job), only bumps the retry counter so the
      // next sweep can try again.
      if (!entry || entry.status !== 'pending') {
        return;
      }
      let prior = entry.attempts;
      journal.record(() => {
        entry.attempts = prior;
      });
      entry.attempts += 1;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      let entry = rows.get(id);
      // No-op on a missing or already-terminal row, mirroring the outbox and saga stores. Flipping
      // status to 'dead' keeps `claimInbound` from handing this poison event back again.
      if (!entry || entry.status !== 'pending') {
        return;
      }
      let prior = { ...entry };
      journal.record(() => rows.set(id, prior));
      // Flip to 'dead' and record the failure reason on the row itself, so the dead-letter outcome
      // travels with the row instead of a side map.
      rows.set(id, { ...entry, status: 'dead', reason });
    },
  };
}

// --- Saga store -------------------------------------------------------------------

// Whole board, newest `updatedAt` first (see SagaStore.list). Snapshot the values first so
// iteration is safe if `rows` changes underneath, sort to match the SQL engines' `order by
// updated_at desc` (a stable sort leaves ties in insertion order), and copy each saga so a consumer
// can't mutate stored state. Module-level (like lineageOf) to keep createSagaStore short.
async function* listSagasOf(rows: Map<string, Saga>): AsyncIterable<Saga> {
  let snapshot = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (let saga of snapshot) {
    yield { ...saga };
  }
}

// Tracks each multi-step payout through its states. `advance` changes a saga only if it's still
// in the expected state (`from`); otherwise returns false and changes nothing, guarding against
// two background runs advancing the same saga twice.
function createSagaStore(): SagaStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, Saga>();

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
    list: () => listSagasOf(rows),
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
    // Omits the 5th `options?` param of SagaStore.advance: a 4-param implementation still
    // structurally satisfies the interface (TS lets an implementation drop trailing params), and
    // adding it would trip the repo's four-parameter cap. The other sub-store methods take four
    // params or fewer, so they keep `options?` for signature parity.
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
      // Largest `updatedAt` across this user's sagas in any state (`updatedAt` is the request
      // time at open() and only moves forward), or null when the user has no sagas, so their
      // first request is always allowed. Read-only, records no journal undo.
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
      journal.record(() => rows.set(id, prior));
      // Flip to FAILED and record the failure reason on the saga itself, so the terminal outcome
      // travels with the record instead of a side map.
      rows.set(id, { ...saga, state: 'FAILED', reason });
    },
  };
}

// --- Entitlement store ------------------------------------------------------------

// One ownership row: the grant's attributes plus a `revoked` flag. Revoke is a soft delete
// (keep the row, set the flag), so the history of who owned what survives auditing after a
// refund or clawback.
interface EntitlementRow {
  attrs: EntitlementAttrs;
  revoked: boolean;
}

// Tracks who owns what (e.g. which user owns which item): plain ownership records, not money
// movements. `revoke` soft-deletes (keep the row, set `revoked`), so `owns` reports false
// while the row survives for auditing. `owns` also checks `expiresAt` against the clock, so an
// expired rental or trial stops counting as owned.
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
      // Insert or overwrite, clearing any earlier revoke (`revoked: false`), so re-buying after
      // a refund makes the user own the item again.
      let key = keyOf(userId, sku);
      recordUndo(key);
      rows.set(key, { attrs: { ...attrs }, revoked: false });
    },
    revoke: async (userId, sku, _options?: Options) => {
      // Soft delete: keep the row, flip `revoked`. No-op (and no undo) on an absent or
      // already-revoked row, so refund/clawback can call it idempotently.
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
      // inclusive of `expiresAt`: still owned exactly at that time, no longer owned once the
      // clock is past it. A row with no `expiresAt` never expires. Read-only; no auto-purge of
      // expired rows.
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
// canceled by the user or lapsed (a renewal couldn't be funded). `claimDue` finds the active
// subscriptions whose next charge is due, for the recurring billing sweep.
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
      // Advance only if the current `nextDueAt` still equals the `expectedDueAt` the billing
      // sweep saw when it picked this row up; otherwise return false and change nothing. If two
      // sweeps overlap and both grab the same due date, the first to run moves `nextDueAt`
      // forward, so the second no longer matches and bails out, charging a billing period at most
      // once. SagaStore.advance guards itself the same way (check the expected state, then
      // update).
      let sub = rows.get(id);
      if (!sub || sub.nextDueAt !== expectedDueAt) {
        return false;
      }
      let prior = { ...sub };
      journal.record(() => rows.set(id, prior));
      // A successful renewal resets the retryable-failure counter to 0, so a subscription that
      // recovered after a few transient failures doesn't carry old failures toward the lapse cap.
      // markLapsed leaves attempts as-is.
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
      // Opening the same grant twice does nothing the second time, never overwriting the first
      // row. SagaStore.open and SubscriptionStore.open replace an existing row with the same id,
      // but here the grant id equals its posting's transaction id, so re-opening must leave the
      // existing grant untouched.
      if (rows.has(grant.id)) {
        return;
      }
      journal.record(() => rows.delete(grant.id));
      rows.set(grant.id, { ...grant });
    },
    claimDue: async (now, limit, _options?: Options) => {
      // Every still-live grant whose `expiresAt` has passed, sorted oldest first across the whole
      // table before the `limit` cap, so oldest-first holds globally rather than in map-iteration
      // order. Read-only, records no journal undo.
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
// writes sit outside the money transaction, so even a rejected attempt counts toward the limit
// (a rollback must not erase the attempt). `bump` ignores a repeat of an attempt it has already
// seen (matched by idempotency key), so a retry isn't counted twice.
//
// Attempts are kept as a per-subject list, not a single running total, so `read` can apply the
// sliding window: it sums only the attempts inside the last `windowMs` (via `windowedVelocity`),
// the same rolling window the SQL adapters get from `SUM(amount) WHERE at > cutoff`. An earlier
// grow-forever running total never aged out, so the limit stuck once first hit.
function createTrustStore(clock: Clock, windowMs: number): TrustStore {
  let attemptsBySubject = new Map<string, Attempt[]>();
  let seenAttempts = new Set<string>();

  // Append an attempt to its subject's list, deduplicated on idempotency key so a genuine retry
  // isn't counted twice. Both `bump` and `record` use it to apply the write.
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
    // Record-and-measure in one step. JS being single-threaded, the dedup-insert and the
    // windowing below run with no `await` between them, so two concurrent same-subject `record`
    // calls can't interleave: each sees its own attempt already in the list when it measures.
    // That atomicity closes the velocity-limit TOCTOU the old separate read+bump left open.
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

// Stores checkpoints (periodic signed snapshots of the ledger's state). Append-only and never
// part of a money transaction, so a rollback can't delete a checkpoint that was already
// recorded.
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

// Drops duplicate incoming webhooks from a payment provider, matching each by the event id the
// provider assigned. Separate id space from the idempotency keys our own callers send. When a
// webhook arrives, the handler records its event id here as the final check (after verifying the
// signature and that the event is recent), outside any money transaction. Being outside the
// transaction, this store registers no undo steps and is never rolled back. In SQL adapters this
// is the `seen_webhooks` table; here a Set.
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

// --- Assembled store --------------------------------------------------------------

/**
 * Build an in-memory {@link Store} with working transaction rollback, for tests and
 * development. If the work inside a `transaction` throws, every store that joined the
 * transaction is rolled back, each independently so one store's failing rollback can't stop the
 * others. The trust and checkpoint stores are written outside transactions and aren't rolled
 * back. The hash function and clock default to deterministic versions, so a plain
 * `memoryStore()` is reproducible.
 */
export function memoryStore(deps?: {
  digest?: Digest;
  clock?: Clock;
  velocityWindowMs?: number;
}): Store {
  let digest = deps?.digest ?? defaultDigest();
  let clock = deps?.clock ?? defaultClock();
  // Rolling window the trust store applies when summing a subject's recent attempts. Defaults to
  // one hour (matching config's default); the real composition passes config.velocityWindowMs.
  let velocityWindowMs = deps?.velocityWindowMs ?? 60 * 60_000;

  let ledger = createLedgerStore({ digest, clock });
  let idempotency = createIdempotencyStore();
  let sales = createSaleStore();
  let outbox = createOutboxStore();
  let inbox = createInboxStore();
  let sagas = createSagaStore();
  let entitlements = createEntitlementStore({ clock });
  let subscriptions = createSubscriptionStore();
  let promos = createPromoStore();
  let trust = createTrustStore(clock, velocityWindowMs);
  let checkpoints = createCheckpointStore();
  // The webhook duplicate check runs outside any money transaction (the final check when a
  // webhook arrives), so it takes no part in rollback and isn't handed to operation handlers; it
  // lives only on the top-level store.
  let replay = createReplayStore();

  // Stores a handler may use inside a transaction. The trust and checkpoint stores are left out
  // because they are written outside transactions.
  let unit: Unit = {
    ledger,
    idempotency,
    sales,
    outbox,
    inbox,
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
    inbox,
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
    inbox,
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

// Roll back only the stores that started this transaction (the first `begun` of them), newest
// first. Each rollback is wrapped so that if one throws, the rest still roll back; otherwise a
// leftover open transaction could corrupt the next one.
function rollbackAll(participants: Participant[], begun: number): void {
  for (let i = begun - 1; i >= 0; i -= 1) {
    try {
      participants[i]!.journal.rollback();
    } catch {
      // Best effort: ignore this one's failure and keep rolling back the others.
    }
  }
}
