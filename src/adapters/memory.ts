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
import { baseOf, currency, SYSTEM } from '#src/accounts.ts';
import { VELOCITY_CURRENCY } from '#src/trust.ts';
import { byCodeUnit, fromHex, toHex } from '#src/bytes.ts';
import { metaString, metaNumber } from '#src/meta.ts';
import { sha256Digest } from '#src/digest.ts';

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
  Velocity,
} from '#src/ports.ts';
import type { EntitlementAttrs } from '#src/contract.ts';

// --- Per-store undo log -----------------------------------------------------------

// Undoes a store's writes when a transaction fails. While a transaction is open, every change
// records a reverser. With no transaction open, nothing is recorded. Rollback runs the reversers
// last-to-first, so its cost is proportional to the number of writes, not to the amount of stored
// data.
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

// Returns the default hash, the shared SHA-256 `sha256Digest`. It is deterministic across runtimes
// (a synchronous node:crypto hash when one is available, else Web Crypto, byte-identical either way),
// so a plain `memoryStore()` stays reproducible with no seed.
function defaultDigest(): Digest {
  return sha256Digest();
}

// Returns the default clock, which always reports time 0, keeping each posting's `postedAt`
// predictable in tests. Pass a real clock when wall-clock time matters.
function defaultClock(): Clock {
  return { now: () => 0 };
}

let GENESIS_HEX = toHex(GENESIS);

// --- Ledger store -----------------------------------------------------------------

interface StoredPosting {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
  postedAt: number;
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;
}

// Whether the ledger accepts a posting against this account: a registered platform account or a
// shard of one (baseOf strips the suffix), or a user account with a known `:kind` suffix.
function isKnownAccount(account: AccountRef, registered: Set<string>): boolean {
  if (registered.has(baseOf(account))) {
    return true;
  }
  let colon = account.lastIndexOf(':');
  if (colon < 0) {
    return false;
  }
  let suffix = account.slice(colon + 1);
  return suffix === 'spendable' || suffix === 'earned' || suffix === 'promo';
}

interface LedgerState {
  journal: Journal;

  log: StoredPosting[];

  // Balance per account in minor units (cents), kept current as postings apply so a balance
  // read is a single map lookup.
  balances: Map<AccountRef, bigint>;

  // Per-account hash chain. Each posting's hash covers the previous hash plus its own contents, so
  // altering an old posting changes every later hash. This holds the latest hash (the head) per
  // account as lowercase hex. A missing entry means there are no postings yet, so the head is the
  // genesis hash.
  heads: Map<AccountRef, string>;

  // Platform account ids the ledger accepts directly. User accounts aren't listed. They are instead
  // recognized by their kind suffix.
  registered: Set<string>;

  // Per-account `log` positions that raised this account's balance (its lots), in commit order.
  // `timeline` walks one account's index instead of the whole shared log, so the maturity FIFO tail
  // costs O(this account's lots), not O(total postings). Maintained in commitPosting/undoPosting.
  lotIndexByAccount: Map<AccountRef, number[]>;
}

type Link = { account: AccountRef; prevHash: string; hash: string };

/**
 * In-memory ledger. It adds `__tamper`, a test-only back door whose `__` prefix marks it as not
 * part of the real interface. `__tamper` edits a stored posting's entries in place without
 * recomputing the chain head. This simulates an attacker who altered stored data and left the old
 * hash behind, which is the corruption the chain check is meant to detect.
 */
export type MemoryLedger = Ledger &
  Participant & {
    __tamper(txnId: string, mutate: (legs: Leg[]) => void): void;
    // Plants a stored balance for an account that has no posting and no chain entry. The account
    // then shows up in `balanceAccounts()` but never in `heads()`. This fakes a stray balance row,
    // such as a direct DB edit or a half-finished write. The integrity checker must report it as
    // drift, meaning a stored balance that no longer matches the sum of its entries.
    __seedBalance(account: AccountRef, amount: Amount): void;
  };

// Returns the distinct accounts a posting touches, in first-seen order. A posting may list an
// account more than once, but each distinct account is wanted only once, because appending
// advances one chain head per distinct account.
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

// Computes the new chain-head hash for each touched account, without writing anything. It hashes
// the account's previous head together with the posting's contents (via `chainHash` in ledger.ts).
// The previous head is decoded from the stored hex. For an account's first posting, the predecessor
// is instead the raw genesis bytes.
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

// Applies a posting. It records the posting in the log, advances each touched account's chain head,
// and adjusts each touched balance. It also registers an undo so a transaction can reverse the
// posting. The undo deletes any account this posting first created, so rollback leaves no leftover
// zero-balance account.
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
  // Index this posting under each account it raised (its lots), so `timeline` reads them directly
  // rather than scanning the whole log. One entry per distinct raised account, at the just-pushed
  // log position; undoPosting removes the same set.
  let index = state.log.length - 1;
  let lotted = lottedAccounts(stored.legs);
  for (let account of lotted) {
    let positions = state.lotIndexByAccount.get(account);
    if (positions === undefined) {
      positions = [];
      state.lotIndexByAccount.set(account, positions);
    }
    positions.push(index);
  }
  for (let link of stored.links) {
    state.heads.set(link.account, link.hash);
  }
  for (let leg of stored.legs) {
    let next =
      (state.balances.get(leg.account) ?? 0n) + balanceDelta(leg).minor;
    state.balances.set(leg.account, next);
  }

  state.journal.record(() =>
    undoPosting(state, stored, { priorHeads, created, lotted }),
  );
}

// The distinct accounts a posting raised: those with a balance-increasing leg, the lots `timeline`
// yields. commitPosting indexes the posting under each; undoPosting removes it.
function lottedAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
  let seen = new Set<AccountRef>();
  let order: AccountRef[] = [];
  for (let leg of legs) {
    if (balanceDelta(leg).minor > 0n && !seen.has(leg.account)) {
      seen.add(leg.account);
      order.push(leg.account);
    }
  }
  return order;
}

// What undoPosting needs to reverse one commit: each touched account's previous chain head, the
// accounts this posting first created (deleted on undo once their balance returns to zero), and the
// accounts it lotted (whose lot-index entry is popped). Bundled into one parameter to stay under the
// parameter-count cap.
type PostingUndo = {
  priorHeads: ReadonlyArray<{ account: AccountRef; prev: string | undefined }>;
  created: Set<AccountRef> | null;
  lotted: ReadonlyArray<AccountRef>;
};

// Reverses `commitPosting`: drops the posting from the log, removes its lot-index entries, restores
// each previous chain head, and undoes each balance change. An account this posting first created is
// removed once its balance is back to zero, rather than left at zero.
function undoPosting(
  state: LedgerState,
  stored: StoredPosting,
  undo: PostingUndo,
): void {
  state.log.pop();

  for (let account of undo.lotted) {
    let positions = state.lotIndexByAccount.get(account);
    if (positions !== undefined) {
      positions.pop();
      if (positions.length === 0) {
        state.lotIndexByAccount.delete(account);
      }
    }
  }
  for (let { account, prev } of undo.priorHeads) {
    if (prev === undefined) {
      state.heads.delete(account);
    } else {
      state.heads.set(account, prev);
    }
  }
  for (let leg of stored.legs) {
    let next =
      (state.balances.get(leg.account) ?? 0n) - balanceDelta(leg).minor;
    if (next === 0n && undo.created?.has(leg.account)) {
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

    balances: new Map(),
    heads: new Map(),
    // Seeded from the platform accounts so they're accepted immediately.
    registered: new Set<string>(Object.values(SYSTEM)),
    lotIndexByAccount: new Map(),
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

    timeline: (account, options) => timelineOf(state, account, options),

    heads: async function* () {
      // Yields in code-unit order rather than Map insertion order, so every engine lists accounts
      // identically.
      for (let [account, head] of [...state.heads].sort((a, b) =>
        byCodeUnit(a[0], b[0]),
      )) {
        yield [account, head] as const;
      }
    },

    // Yields every account with a stored balance, reading from `state.balances` keys rather than
    // postings: that way a balance with no posting still reaches the integrity checker (which flags it
    // as a balance that shouldn't exist), whereas walking `heads` never would. Copy the keys first for
    // safe iteration, then sort by code unit so every engine lists accounts in the same order.
    balanceAccounts: async function* () {
      for (let account of [...state.balances.keys()].sort(byCodeUnit)) {
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

// Builds an account's statement. It includes every entry in the range whose posting touched this
// account. The range is half-open, covering postedAt >= from and < to. Each amount is signed by how
// it changed this account's balance, so money into a user account reads positive. Everything fits
// one page, so the cursor is always null.
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

// Streams this account's incoming funds as lots for FIFO settlement, one lot per posting entry that
// increased the balance, with `source`/`maturesAt` falling back to "unknown" and mature-now when the
// metadata omits them (maturity rules live in maturity.ts).
//
// `options` mirrors the SQL engines: 'asc' (default) is commit order, 'desc' newest-first, with
// `offset`/`limit` paging so the maturity tail pulls just the newest run. The log array index is the
// in-memory analogue of SQL `seq`, so reversing it matches `order by seq desc`.
async function* timelineOf(
  state: LedgerState,
  account: AccountRef,
  options?: { order?: 'asc' | 'desc'; limit?: number; offset?: number },
): AsyncIterable<Lot> {
  let order = options?.order ?? 'asc';
  let offset = options?.offset ?? 0;
  let limit = options?.limit ?? Infinity;

  // Walk only this account's lots, via its lot index, rather than scanning the whole log. The index
  // holds its log positions in commit (asc) order; 'desc' walks it newest-first. A log position is
  // the in-memory analogue of SQL `seq`, so reversing matches `order by seq desc`.
  let positions = state.lotIndexByAccount.get(account) ?? [];
  let step = order === 'desc' ? -1 : 1;
  let start = order === 'desc' ? positions.length - 1 : 0;
  let skipped = 0;
  let yielded = 0;
  for (let n = 0; n < positions.length && yielded < limit; n += 1) {
    let row = state.log[positions[start + step * n]!]!;
    for (let lot of lotsOfPosting(row, account)) {
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (yielded >= limit) {
        break;
      }
      yielded += 1;
      yield lot;
    }
  }
}

// Yields each balance-increasing leg of one posting as a Lot. A posting can raise an account in more
// than one leg, so this may yield several; a balance-lowering leg is skipped (a spend is not a lot).
// `source`/`maturesAt` fall back to "unknown" and mature-now when the metadata omits them.
function* lotsOfPosting(
  row: StoredPosting,
  account: AccountRef,
): Generator<Lot> {
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

// Streams every posting that touched this account, in order, with the data the chain verifier needs
// to recompute and check each head hash. That data is the entries and metadata as appended, plus the
// head before the posting (prevHash) and after it (hash). These are the same inputs `chainHash` was
// fed, so if `__tamper` alters the stored entries, the recomputed hash no longer matches the stored
// one.
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

// Looks up a whole posting by transaction id and returns all its entries. Unlike `lineage`, the
// result is not narrowed to one account. `reverse` uses this to build the opposite of an earlier
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

// Streams the whole ledger, newest commit first (see Ledger.list). The `log` index is the in-memory
// analogue of the SQL engines' `seq`, so reversing a snapshot matches `order by seq desc` with no tie
// to break. Snapshot first so iteration survives concurrent writes, and copy each posting's fields so
// a consumer can't mutate stored state.
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

// Makes a repeated request safe to run once. `claim` either grants a first-time caller the right to
// proceed or replays the result of a prior identical request. A new key is marked pending through
// the journal, so a rollback returns it to unused and a later retry can still succeed. A failed
// attempt therefore never permanently consumes the key. Because this store is single-threaded,
// pending is the only "claimed but not finished" state. On success, `record` turns a pending key
// into a committed result.
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

// Holds outgoing events so they are saved in the same transaction as the money movement that
// produced them. If that transaction rolls back, the event is never sent. A separate relay picks up
// pending messages (`claimBatch`) and marks them sent (`markRelayed`). The receiver drops duplicates
// by message id, so each event is delivered at least once but acted on only once.
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
        // Only 'pending' rows are handed back. The 'relayed' and 'failed' states are terminal, and
        // this `=== 'pending'` test excludes both.
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
      // Does nothing for a missing or already-terminal row. Only a still-'pending' message gets its
      // attempt counted. This does not change the status, which is deadLetter's job. It only bumps
      // the retry counter so the next sweep can try again.
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
      // Does nothing for a missing or already-terminal row, mirroring the saga store. Flipping the
      // status to 'failed' keeps `claimBatch` from handing this poison message back again.
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

// The inbound mirror of the outbox. It holds verified provider events, each already mapped to the
// operation it applies, so they are saved in the same transaction as the webhook ingress that
// claimed them. A separate apply worker picks up pending rows (`claimInbound`), submits each
// operation, and marks them applied (`markApplied`). At enqueue it dedupes on `key`, the provider
// event id, returning the existing row for a redelivered event so it is applied at most once.
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
      // Dedupes on the provider event id. A duplicate does nothing and returns the row already
      // stored under that key, so a redelivered event is applied at most once. Only a first sighting
      // inserts a row and records an undo.
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
      // Returns pending rows with the oldest `receivedAt` first. It sorts across the whole table
      // before applying the `limit` cap, so oldest-first holds globally rather than in insertion
      // order. Only 'pending' rows are handed back. The 'applied' and 'dead' states are terminal,
      // and this `=== 'pending'` test excludes both. `input.now` is accepted for parity with the
      // saga and relay claims. The inbox has no due-time gate, so every pending row is immediately
      // claimable.
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
      // Does nothing for a missing or already-terminal row. Only a still-'pending' row flips to
      // 'applied', so `claimInbound` never hands it back again.
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
      // Does nothing for a missing or already-terminal row. Only a still-'pending' row gets its
      // attempt counted. This does not change the status, which is deadLetter's job. It only bumps
      // the retry counter so the next sweep can try again.
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

// Streams the whole board, newest `updatedAt` first (see SagaStore.list). It snapshots the values
// first so iteration is safe if `rows` changes underneath. It then sorts to match the SQL engines'
// `order by updated_at desc`, and a stable sort leaves ties in insertion order. It copies each saga
// so a consumer can't mutate stored state. Defined at module level (like lineageOf) to keep
// createSagaStore short.
async function* listSagasOf(rows: Map<string, Saga>): AsyncIterable<Saga> {
  let snapshot = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (let saga of snapshot) {
    yield { ...saga };
  }
}

// Tracks each multi-step payout through its states. `advance` changes a saga only if it is still in
// the expected state (`from`). Otherwise it returns false and changes nothing. This guards against
// two background runs advancing the same saga twice.
function createSagaStore(): SagaStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, Saga>();
  // Maintained max `updatedAt` per user, so `lastPayoutAt` is an O(1) read, not a scan over every
  // saga. Sagas are only added or moved forward (never deleted outside rollback) and `updatedAt`
  // only increases, so this index only rises on a write and is restored on rollback.
  let lastByUser = new Map<string, number>();

  // Raises a user's most-recent-payout time and records the undo. Only ever raises, so a rolled-back
  // saga write restores the prior max (or clears it when this was the user's first saga).
  let bumpLast = (userId: string, updatedAt: number): void => {
    let prior = lastByUser.get(userId);
    if (prior !== undefined && prior >= updatedAt) {
      return;
    }
    lastByUser.set(userId, updatedAt);
    journal.record(() =>
      prior === undefined
        ? lastByUser.delete(userId)
        : lastByUser.set(userId, prior),
    );
  };

  return {
    journal,
    open: async (saga, _options?: Options) => {
      let prior = rows.get(saga.id);
      let had = rows.has(saga.id);
      rows.set(saga.id, { ...saga });
      journal.record(() =>
        had ? rows.set(saga.id, prior!) : rows.delete(saga.id),
      );
      bumpLast(saga.userId, saga.updatedAt);
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
    // Omits the 5th `options?` param of SagaStore.advance. A four-param implementation still
    // structurally satisfies the interface, because TS lets an implementation drop trailing params.
    // Keeping the param would trip the repo's four-parameter cap. The other sub-store methods take
    // four params or fewer, so they keep `options?` for signature parity.
    advance: async (id, from, to, patch) => {
      let saga = rows.get(id);
      if (!saga || saga.state !== from) {
        return false;
      }
      let prior = { ...saga };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...saga, ...patch, state: to });
      bumpLast(saga.userId, patch.updatedAt ?? saga.updatedAt);
      return true;
    },
    lastPayoutAt: async (userId, _options?: Options) => {
      // The largest `updatedAt` across this user's sagas in any state, read from the `lastByUser`
      // index (kept by bumpLast on open/advance) instead of scanning every saga. Null when the user
      // has no sagas, so their first request is always allowed. Read-only.
      return lastByUser.get(userId) ?? null;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      let saga = rows.get(id);
      if (!saga) {
        return;
      }
      let prior = { ...saga };
      journal.record(() => rows.set(id, prior));

      rows.set(id, { ...saga, state: 'FAILED', reason });
    },
  };
}

// --- Entitlement store ------------------------------------------------------------

// One ownership row, holding the grant's attributes plus a `revoked` flag. Revoke is a soft delete
// that keeps the row and sets the flag, so the row survives for auditing.
interface EntitlementRow {
  attrs: EntitlementAttrs;
  revoked: boolean;
}

// Tracks who owns what, for example which user owns which item. These are plain ownership records,
// not money movements. `revoke` soft-deletes by keeping the row and setting `revoked`, so `owns`
// reports false while the row survives for auditing. `owns` also checks `expiresAt` against the
// clock, so an expired rental or trial stops counting as owned.
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
      // Inserts or overwrites the row, clearing any earlier revoke by setting `revoked: false`, so
      // re-buying after a refund makes the user own the item again.
      let key = keyOf(userId, sku);
      recordUndo(key);
      rows.set(key, { attrs: { ...attrs }, revoked: false });
    },
    revoke: async (userId, sku, _options?: Options) => {
      let key = keyOf(userId, sku);
      let row = rows.get(key);
      if (!row || row.revoked) {
        return;
      }
      recordUndo(key);
      rows.set(key, { ...row, revoked: true });
    },
    owns: async (userId, sku, _options?: Options) => {
      // Expiry check is inclusive of `expiresAt`; null `expiresAt` never expires.
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

// Tracks each subscription through its life. It starts active, then bills period after period,
// until the user cancels it or it lapses because a renewal couldn't be funded. `claimDue` finds the
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
      // Advances only if the current `nextDueAt` still equals the `expectedDueAt` the billing sweep
      // saw when it picked this row up. Otherwise it returns false and changes nothing. If two
      // sweeps overlap and both grab the same due date, the first to run moves `nextDueAt` forward.
      // The second then no longer matches and bails out, so a billing period is charged at most
      // once. SagaStore.advance guards itself the same way: it checks the expected state, then
      // updates.
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

// Tracks each marketing promo grant so the background promo-expiry sweep can later reverse whatever
// the user hasn't spent once the grant expires. `grantPromo` records the grant here in the same
// transaction as the credit posting. The sweep claims due grants oldest first, meaning those whose
// `expiresAt` has passed and that are not yet reversed. It reverses the unspent remainder, then
// marks each one reversed so it is never reversed twice.
function createPromoStore(): PromoStore & Participant {
  let journal = createJournal();
  let rows = new Map<string, PromoGrant>();

  return {
    journal,
    open: async (grant, _options?: Options) => {
      // Grant id equals its posting's txnId, so re-opening must leave the first row untouched (unlike
      // SagaStore/SubscriptionStore.open, which replace).
      if (rows.has(grant.id)) {
        return;
      }
      journal.record(() => rows.delete(grant.id));
      rows.set(grant.id, { ...grant });
    },
    claimDue: async (now, limit, _options?: Options) => {
      // Returns every still-live grant whose `expiresAt` has passed. It sorts oldest first across
      // the whole table before applying the `limit` cap, so oldest-first holds globally rather than
      // in map-iteration order. Read-only, so it records no journal undo.
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
// (a rollback must not erase the attempt). `bump` dedupes a repeat attempt by idempotency key, so a
// retry isn't counted twice.
//
// The windowed total is kept incrementally, not re-summed: each subject holds its in-window attempts
// plus a running `sumMinor`, so read/record stays O(1) amortized as history grows. An earlier version
// re-scanned every attempt (O(attempts)), so one hot subject's throughput fell off as it accrued
// history. Still mirrors the SQL adapters' windowed `SUM(amount) WHERE at > cutoff` and reproduces
// `windowedVelocity` exactly — same boundary, same windowStart.

// `sumMinor` = sum of the live tail `attempts[head..]`; entries before `head` have aged out and been
// subtracted.
type TrustWindow = { attempts: Attempt[]; head: number; sumMinor: bigint };

function createTrustStore(clock: Clock, windowMs: number): TrustStore {
  let bySubject = new Map<string, TrustWindow>();
  let seenAttempts = new Set<string>();

  // `at` comes from the clock (only moves forward), so the appended attempt is the newest and the
  // window stays ordered by `at` — which `measure`'s prefix-pruning relies on.
  let insert = (subject: string, attempt: Attempt): void => {
    if (seenAttempts.has(attempt.idempotencyKey)) {
      return;
    }
    seenAttempts.add(attempt.idempotencyKey);
    let window = bySubject.get(subject);
    if (window === undefined) {
      window = { attempts: [], head: 0, sumMinor: 0n };
      bySubject.set(subject, window);
    }
    window.attempts.push(attempt);
    window.sumMinor += attempt.amount.minor;
  };

  // Expired attempts are always a prefix (ordered by `at`), so advance `head` past just those and
  // never scan the live tail; compact the consumed prefix once it dominates so memory stays bounded.
  let measure = (subject: string, now: number): Velocity => {
    let window = bySubject.get(subject);
    let cutoff = now - windowMs;
    if (window !== undefined) {
      let attempts = window.attempts;
      while (
        window.head < attempts.length &&
        attempts[window.head]!.at <= cutoff
      ) {
        window.sumMinor -= attempts[window.head]!.amount.minor;
        window.head += 1;
      }
      if (window.head > 0 && window.head * 2 >= attempts.length) {
        window.attempts = attempts.slice(window.head);
        window.head = 0;
      }
    }
    let live = window === undefined ? 0 : window.attempts.length - window.head;
    return {
      subject,
      windowStart: live > 0 ? window!.attempts[window!.head]!.at : 0,
      spent: toAmount(VELOCITY_CURRENCY, window?.sumMinor ?? 0n),
      attempts: live,
    };
  };

  return {
    read: async (subject, _options?: Options) => measure(subject, clock.now()),
    bump: async (subject, attempt, _options?: Options) =>
      insert(subject, attempt),
    // Records and measures in one step. Because JS is single-threaded, the dedup-insert and the
    // windowing below run with no `await` between them. Two concurrent same-subject `record` calls
    // therefore can't interleave, and each sees its own attempt already counted when it measures —
    // the atomicity that closes the velocity-limit TOCTOU the old separate read+bump left open.
    record: async (subject, attempt, _options?: Options) => {
      insert(subject, attempt);
      return measure(subject, clock.now());
    },
  };
}

// --- Checkpoint store -------------------------------------------------------------

// Append-only and never part of a money transaction, so a rollback can't delete a recorded checkpoint.
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

// Drops duplicate incoming provider webhooks, matched by the provider's event id (a separate id space
// from our callers' idempotency keys). The handler claims the id here as its final check, after
// signature + recency, outside any money transaction, so this store registers no undo and is never
// rolled back. SQL adapters back it with the `seen_webhooks` table; here it is a Set.
function createReplayStore(): ReplayStore {
  let seen = new Set<string>();
  return {
    claim: async (eventId, _options?: Options) => {
      // Atomic insert-if-absent. The first sighting of an id wins and returns `claimed: true`. Every
      // later sighting is a duplicate and returns `claimed: false`, so a redelivered webhook is
      // processed at most once.
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
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for the store ports this adapter implements.
 */
export function memoryStore(deps?: {
  digest?: Digest;
  clock?: Clock;
  velocityWindowMs?: number;
}): Store {
  let digest = deps?.digest ?? defaultDigest();
  let clock = deps?.clock ?? defaultClock();

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

// Rolls back only the stores that started this transaction, which are the first `begun` of them,
// newest first. Each rollback is wrapped so that if one throws, the rest still roll back. Otherwise
// a leftover open transaction could corrupt the next one.
function rollbackAll(participants: Participant[], begun: number): void {
  for (let i = begun - 1; i >= 0; i -= 1) {
    try {
      participants[i]!.journal.rollback();
    } catch {
      // Best effort: ignore this one's failure and keep rolling back the others.
    }
  }
}
