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

import { chainHash, balanceDelta, GENESIS, GENESIS_HEX } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { I64Column, foldColumn } from '#src/fold-column.ts';
import { baseOf, currency, SYSTEM, walletKindOf } from '#src/accounts.ts';
import { VELOCITY_CURRENCY } from '#src/trust.ts';
import { byCodeUnit, fromHex } from '#src/bytes.ts';
import { metaString, metaNumber } from '#src/meta.ts';
import { sha256Digest } from '#src/digest.ts';

import type { Amount, Currency } from '#src/money.ts';
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
  Movement,
  MovementJournal,
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
  Velocity,
} from '#src/ports.ts';
import type { EntitlementAttrs } from '#src/contract.ts';

// --- Per-store undo log -----------------------------------------------------------

// While a transaction is open, every write records a reverser; rollback runs them last-to-first.
// With no transaction open, nothing is recorded.
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

// Only for stores that replace whole rows on write; the outbox and inbox mutate rows in place
// and journal their own field-level undos.
function recordRowUndo<V>(
  journal: Journal,
  rows: Map<string, V>,
  key: string,
): void {
  const prior = rows.get(key);
  const had = rows.has(key);
  journal.record(() => (had ? rows.set(key, prior!) : rows.delete(key)));
}

// --- Default capabilities ---------------------------------------------------------

function defaultDigest(): Digest {
  return sha256Digest();
}

// Frozen at time 0; pass a real clock when wall-clock time matters.
function defaultClock(): Clock {
  return { now: () => 0 };
}

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
  return registered.has(baseOf(account)) || walletKindOf(account) !== null;
}

interface LedgerState {
  journal: Journal;

  log: StoredPosting[];

  balances: Map<AccountRef, bigint>;

  // Latest chain-head hash per account, lowercase hex. A missing entry means no postings yet, so
  // the head is the genesis hash.
  heads: Map<AccountRef, string>;

  registered: Set<string>;

  // Per-account `log` positions that raised the balance (its lots), in commit order, so `timeline`
  // walks one account's index instead of the whole shared log.
  lotIndexByAccount: Map<AccountRef, number[]>;

  // Each account's signed leg deltas as a resident i64 column per currency, in commit order. A
  // balance re-derivation folds the column instead of scanning the whole log; the fold is the win
  // on the hot platform accounts. Maintained alongside the log on commit and rollback.
  deltaColumns: Map<AccountRef, Map<Currency, I64Column>>;
}

type Link = { account: AccountRef; prevHash: string; hash: string };

/**
 * In-memory ledger plus test-only back doors (the `__` prefix). `__tamper` edits a stored
 * posting's legs without recomputing the chain head — the corruption the chain check must detect.
 */
export type MemoryLedger = Ledger &
  Participant & {
    __tamper(txnId: string, mutate: (legs: Leg[]) => void): void;
    // Plants a balance with no posting and no chain entry — a stray row the integrity checker
    // must report as drift.
    __seedBalance(account: AccountRef, amount: Amount): void;
  };

function distinctAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
  const seen = new Set<AccountRef>();
  const order: AccountRef[] = [];
  for (const leg of legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      order.push(leg.account);
    }
  }
  return order;
}

async function advanceChain(
  state: LedgerState,
  digest: Digest,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  const links: Link[] = [];
  for (const account of distinctAccounts(posting.legs)) {
    const prevHex = state.heads.get(account) ?? GENESIS_HEX;
    const accountPrevHash =
      prevHex === GENESIS_HEX ? GENESIS : fromHex(prevHex);
    const hash = await chainHash(digest, {
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

function commitPosting(state: LedgerState, stored: StoredPosting): void {
  const priorHeads = stored.links.map((link) => ({
    account: link.account,
    prev: state.heads.get(link.account),
  }));
  const created = state.journal.recording()
    ? new Set(
        stored.legs
          .filter((leg) => !state.balances.has(leg.account))
          .map((leg) => leg.account),
      )
    : null;

  // Range-check every leg's running balance before touching any state. toAmount refuses any
  // balance the SQL engines' BIGINT columns would refuse; checking first means a refused posting
  // throws with nothing applied, so the recorded undo always reverses a complete commit.
  const nextBalances = new Map<AccountRef, bigint>();
  const deltas: Amount[] = [];
  for (const leg of stored.legs) {
    const delta = balanceDelta(leg);
    const prior =
      nextBalances.get(leg.account) ?? state.balances.get(leg.account) ?? 0n;
    nextBalances.set(
      leg.account,
      toAmount(leg.amount.currency, prior + delta.minor).minor,
    );
    deltas.push(delta);
  }

  state.log.push(stored);
  const index = state.log.length - 1;
  const lotted = lottedAccounts(stored.legs);
  for (const account of lotted) {
    let positions = state.lotIndexByAccount.get(account);
    if (positions === undefined) {
      positions = [];
      state.lotIndexByAccount.set(account, positions);
    }
    positions.push(index);
  }
  for (const link of stored.links) {
    state.heads.set(link.account, link.hash);
  }
  stored.legs.forEach((leg, i) => {
    state.balances.set(leg.account, nextBalances.get(leg.account)!);
    appendDelta(state, leg.account, deltas[i]!);
  });

  state.journal.record(() =>
    undoPosting(state, stored, { priorHeads, created, lotted }),
  );
}

// The distinct accounts a posting raised: those with a balance-increasing leg, the lots `timeline`
// yields. commitPosting indexes the posting under each; undoPosting removes it.
function lottedAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
  return distinctAccounts(legs.filter((leg) => balanceDelta(leg).minor > 0n));
}

// What undoPosting needs: prior chain heads, the accounts this posting first created (deleted on
// undo so rollback leaves no zero-balance stub), and the lotted accounts (lot-index entry popped).
// Bundled into one parameter to stay under the parameter-count cap.
type PostingUndo = {
  priorHeads: ReadonlyArray<{ account: AccountRef; prev: string | undefined }>;
  created: Set<AccountRef> | null;
  lotted: ReadonlyArray<AccountRef>;
};

function undoPosting(
  state: LedgerState,
  stored: StoredPosting,
  undo: PostingUndo,
): void {
  state.log.pop();

  for (const account of undo.lotted) {
    const positions = state.lotIndexByAccount.get(account);
    if (positions !== undefined) {
      positions.pop();
      if (positions.length === 0) {
        state.lotIndexByAccount.delete(account);
      }
    }
  }
  for (const { account, prev } of undo.priorHeads) {
    if (prev === undefined) {
      state.heads.delete(account);
    } else {
      state.heads.set(account, prev);
    }
  }
  for (const leg of stored.legs) {
    const next =
      (state.balances.get(leg.account) ?? 0n) - balanceDelta(leg).minor;
    if (next === 0n && undo.created?.has(leg.account)) {
      state.balances.delete(leg.account);
    } else {
      state.balances.set(leg.account, next);
    }
    popDelta(state, leg.account, leg.amount.currency);
  }
}

// Appends one leg's signed balance delta to its account's column for that currency, creating the
// per-account map and the column on first use. The column mirrors the leg the log just stored.
function appendDelta(
  state: LedgerState,
  account: AccountRef,
  delta: Amount,
): void {
  let columns = state.deltaColumns.get(account);
  if (columns === undefined) {
    columns = new Map();
    state.deltaColumns.set(account, columns);
  }
  let column = columns.get(delta.currency);
  if (column === undefined) {
    column = new I64Column();
    columns.set(delta.currency, column);
  }
  column.push(delta.minor);
}

// Removes the last delta a rolled-back posting appended for this account and currency, dropping the
// column and the account entry once empty so a fully rolled-back account leaves no trace.
function popDelta(
  state: LedgerState,
  account: AccountRef,
  cur: Currency,
): void {
  const columns = state.deltaColumns.get(account);
  if (columns === undefined) {
    return;
  }
  const column = columns.get(cur);
  if (column === undefined) {
    return;
  }
  column.pop();
  if (column.length === 0) {
    columns.delete(cur);
    if (columns.size === 0) {
      state.deltaColumns.delete(account);
    }
  }
}

// Rebuilds every column from the log. Only the test-only `__tamper` needs it: that back door edits
// stored legs in place, so the columns derived at commit time must be replayed to reflect the edit,
// the way a SQL SUM re-reads the mutated rows.
function rebuildColumns(state: LedgerState): void {
  state.deltaColumns.clear();
  for (const row of state.log) {
    for (const leg of row.legs) {
      appendDelta(state, leg.account, balanceDelta(leg));
    }
  }
}

function createLedgerStore(deps: {
  digest: Digest;
  clock: Clock;
}): MemoryLedger {
  const state: LedgerState = {
    journal: createJournal(),
    log: [],

    balances: new Map(),
    heads: new Map(),
    registered: new Set<string>(Object.values(SYSTEM)),
    lotIndexByAccount: new Map(),
    deltaColumns: new Map(),
  };

  return {
    journal: state.journal,

    hasAccount: async (account) => isKnownAccount(account, state.registered),

    // No-op: single-threaded, nothing to lock against; present so callers can issue the same
    // `lock` against every adapter.
    lock: async () => {},

    append: async (posting) => {
      const postedAt = deps.clock.now();
      const links = await advanceChain(state, deps.digest, posting);
      const stored: StoredPosting = {
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

    derivedBalances: async (account) =>
      derivedBalancesOf(state.deltaColumns.get(account)),

    timeline: (account, options) => timelineOf(state, account, options),

    heads: async function* () {
      for (const [account, head] of sortedHeads(state.heads)) {
        yield [account, head] as const;
      }
    },

    // Heads paired with each account's raw signed leg sum, for the v2 checkpoint's sum leaves.
    // Raw means as posted (debit positive), not the account's natural side, so all accounts
    // together net to zero.
    headSums: async function* () {
      const raw = new Map<AccountRef, bigint>();
      for (const row of state.log) {
        for (const leg of row.legs) {
          raw.set(leg.account, (raw.get(leg.account) ?? 0n) + leg.amount.minor);
        }
      }
      for (const [account, head] of sortedHeads(state.heads)) {
        yield [account, head, raw.get(account) ?? 0n] as const;
      }
    },

    // Reads `state.balances` keys, not heads, so a balance with no posting still reaches the
    // integrity checker. Sorted by code unit so every engine lists accounts in the same order.
    balanceAccounts: async function* () {
      for (const account of [...state.balances.keys()].sort(byCodeUnit)) {
        yield account;
      }
    },

    lineage: (account) => lineageOf(state.log, account),

    posting: async (txnId) => postingOf(state.log, txnId),

    list: () => listPostingsOf(state.log),

    __tamper: (txnId, mutate) => tamperPosting(state, txnId, mutate),

    __seedBalance: (account, amount) =>
      state.balances.set(account, amount.minor),
  };
}

// The chain heads in code-unit account order rather than Map insertion order, so every engine
// lists accounts identically.
function sortedHeads(
  heads: Map<AccountRef, string>,
): Array<[AccountRef, string]> {
  return [...heads].sort((a, b) => byCodeUnit(a[0], b[0]));
}

// Entries are signed by how they changed this account's balance (money in reads positive).
// Everything fits one page, so the cursor is always null.
function buildStatement(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
  range: Range,
): Statement {
  const entries: Array<{ txnId: string; amount: Amount; postedAt: number }> =
    [];
  for (const row of log) {
    if (row.postedAt < range.from || row.postedAt >= range.to) {
      continue;
    }
    for (const leg of row.legs) {
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

// Re-derives the balance by folding each currency's resident column, so the integrity prover can
// compare it against the maintained one without re-scanning the log. Sorted by currency so every
// engine returns the same order.
function derivedBalancesOf(
  columns: Map<Currency, I64Column> | undefined,
): Amount[] {
  if (columns === undefined) {
    return [];
  }
  return [...columns]
    .map(([cur, column]) => toAmount(cur, foldColumn(column)))
    .sort((a, b) => byCodeUnit(a.currency, b.currency));
}

// Streams this account's balance-raising legs as lots for FIFO settlement. `options` mirrors the
// SQL engines: 'asc' (default) is commit order, 'desc' newest-first, with `offset`/`limit` paging.
async function* timelineOf(
  state: LedgerState,
  account: AccountRef,
  options?: { order?: 'asc' | 'desc'; limit?: number; offset?: number },
): AsyncIterable<Lot> {
  const order = options?.order ?? 'asc';
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? Infinity;

  const positions = state.lotIndexByAccount.get(account) ?? [];
  const step = order === 'desc' ? -1 : 1;
  const start = order === 'desc' ? positions.length - 1 : 0;
  let skipped = 0;
  let yielded = 0;
  for (let n = 0; n < positions.length && yielded < limit; n += 1) {
    const row = state.log[positions[start + step * n]!]!;
    for (const lot of lotsOfPosting(row, account)) {
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

// A balance-lowering leg is not a lot, so it is skipped. `source`/`maturesAt` fall back to
// "unknown" and mature-now when the metadata omits them.
function* lotsOfPosting(
  row: StoredPosting,
  account: AccountRef,
): Generator<Lot> {
  for (const leg of row.legs) {
    if (leg.account !== account) {
      continue;
    }
    const delta = balanceDelta(leg);
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

// Every posting that touched this account, in order, with the prevHash/hash pair the chain
// verifier recomputes against.
async function* lineageOf(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
): AsyncIterable<StoredLink> {
  for (const row of log) {
    const link = row.links.find((entry) => entry.account === account);
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

function postingOf(
  log: ReadonlyArray<StoredPosting>,
  txnId: string,
): Posting | null {
  const row = log.find((entry) => entry.txnId === txnId);
  if (!row) {
    return null;
  }
  return { txnId: row.txnId, legs: row.legs, meta: row.meta };
}

// Newest commit first (see Ledger.list). The `log` index is the in-memory analogue of the SQL
// engines' `seq`, so a reversed snapshot matches `order by seq desc`.
async function* listPostingsOf(
  log: ReadonlyArray<StoredPosting>,
): AsyncIterable<Posting> {
  const snapshot = [...log].reverse();
  for (const posting of snapshot) {
    yield { txnId: posting.txnId, legs: posting.legs, meta: posting.meta };
  }
}

// Test-only. Implements `__tamper`; see the MemoryLedger type JSDoc for why this is the
// corruption the chain check detects. Rebuilds the columns so a re-derivation reflects the edited
// legs, the way a SQL SUM would re-read the mutated rows.
function tamperPosting(
  state: LedgerState,
  txnId: string,
  mutate: (legs: Leg[]) => void,
): void {
  const row = state.log.find((entry) => entry.txnId === txnId);
  if (row) {
    mutate(row.legs as Leg[]);
    rebuildColumns(state);
  }
}

// --- Idempotency store ------------------------------------------------------------

// A new key is marked pending through the journal, so a rollback returns it to unused and a
// failed attempt never permanently consumes the key.
function createIdempotencyStore(): IdempotencyStore & Participant {
  const journal = createJournal();
  const committed = new Map<string, Transaction>();
  const pending = new Set<string>();

  return {
    journal,

    claim: async (key, _options?: Options) => {
      const prior = committed.get(key);
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
  const journal = createJournal();
  const rows = new Map<string, Sale>();
  return {
    journal,
    put: async (sale, _options?: Options) => {
      recordRowUndo(journal, rows, sale.orderId);
      rows.set(sale.orderId, sale);
    },
    get: async (orderId, _options?: Options) => rows.get(orderId) ?? null,
  };
}

// --- Outbox store -----------------------------------------------------------------

// Transactional outbox: events are saved in the money move's transaction and relayed later, at
// least once.
function createOutboxStore(): OutboxStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, OutboxMessage>();
  const order: string[] = [];

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
      const batch: OutboxMessage[] = [];
      for (const id of order) {
        if (batch.length >= limit) {
          break;
        }
        const message = rows.get(id);
        if (message && message.status === 'pending') {
          batch.push({ ...message });
        }
      }
      return batch;
    },
    markRelayed: async (ids, _options?: Options) => {
      for (const id of ids) {
        const message = rows.get(id);
        if (message && message.status === 'pending') {
          const prior = message.status;
          journal.record(() => {
            message.status = prior;
          });
          message.status = 'relayed';
        }
      }
    },
    recordFailure: async (id, _options?: Options) => {
      const message = rows.get(id);
      if (!message || message.status !== 'pending') {
        return;
      }
      const prior = message.attempts;
      journal.record(() => {
        message.attempts = prior;
      });
      message.attempts += 1;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      const message = rows.get(id);
      if (!message || message.status !== 'pending') {
        return;
      }
      const prior = { ...message };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...message, status: 'dead', reason });
    },
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox: verified provider events, already mapped to operations, saved
// in the webhook ingress transaction. Enqueue dedupes on `key` (the provider event id), returning
// the existing row for a redelivery.
function createInboxStore(): InboxStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, InboxEntry>();
  const order: string[] = [];
  const byKey = new Map<string, string>();

  return {
    journal,
    enqueueInbound: async (entry, _options?: Options) => {
      const existingId = byKey.get(entry.key);
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
      // Oldest `receivedAt` first across the whole table, then the `limit` cap. `input.now` is
      // unused: the inbox has no due-time gate.
      const pending: InboxEntry[] = [];
      for (const id of order) {
        const entry = rows.get(id);
        if (entry && entry.status === 'pending') {
          pending.push({ ...entry });
        }
      }
      pending.sort((a, b) => a.receivedAt - b.receivedAt);
      return pending.slice(0, input.limit);
    },
    markApplied: async (id, _options?: Options) => {
      const entry = rows.get(id);
      if (!entry || entry.status !== 'pending') {
        return;
      }
      const prior = entry.status;
      journal.record(() => {
        entry.status = prior;
      });
      entry.status = 'applied';
    },
    bumpAttempt: async (id, _options?: Options) => {
      const entry = rows.get(id);
      if (!entry || entry.status !== 'pending') {
        return;
      }
      const prior = entry.attempts;
      journal.record(() => {
        entry.attempts = prior;
      });
      entry.attempts += 1;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      const entry = rows.get(id);

      if (!entry || entry.status !== 'pending') {
        return;
      }
      const prior = { ...entry };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...entry, status: 'dead', reason });
    },
  };
}

// --- Saga store -------------------------------------------------------------------

// Newest `updatedAt` first (see SagaStore.list), matching the SQL engines' `order by updated_at
// desc`; a stable sort leaves ties in insertion order.
async function* listSagasOf(rows: Map<string, Saga>): AsyncIterable<Saga> {
  const snapshot = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const saga of snapshot) {
    yield { ...saga };
  }
}

// The inbound-webhook lookup (see SagaStore.findByProviderRef). On a duplicated ref the newest
// `updatedAt` wins, matching the SQL engines' `order by updated_at desc limit 1`.
async function findSagaByRef(
  rows: Map<string, Saga>,
  providerRef: string,
): Promise<Saga | null> {
  let best: Saga | null = null;
  for (const saga of rows.values()) {
    if (saga.providerRef !== providerRef) {
      continue;
    }
    if (best === null || saga.updatedAt > best.updatedAt) {
      best = saga;
    }
  }
  return best === null ? null : { ...best };
}

// `advance` changes a saga only if it is still in the expected `from` state, so two overlapping
// background runs can't advance it twice.
function createSagaStore(): SagaStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, Saga>();
  // Max `updatedAt` per user, so `lastPayoutAt` needs no scan. `updatedAt` only increases, so the
  // index only rises on a write and is restored on rollback.
  const lastByUser = new Map<string, number>();

  const bumpLast = (userId: string, updatedAt: number): void => {
    const prior = lastByUser.get(userId);
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
      recordRowUndo(journal, rows, saga.id);
      rows.set(saga.id, { ...saga });
      bumpLast(saga.userId, saga.updatedAt);
    },
    load: async (id, _options?: Options) => {
      const saga = rows.get(id);
      return saga ? { ...saga } : null;
    },
    findByProviderRef: (providerRef, _options?: Options) =>
      findSagaByRef(rows, providerRef),
    list: () => listSagasOf(rows),
    claimDue: async (now, limit, _options?: Options) => {
      const due: Saga[] = [];
      for (const saga of rows.values()) {
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
    // Drops the trailing `options?` of SagaStore.advance: keeping it would trip the repo's
    // four-parameter cap, and TS lets an implementation omit trailing params.
    advance: async (id, from, to, patch) => {
      const saga = rows.get(id);
      if (!saga || saga.state !== from) {
        return false;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...saga, ...patch, state: to });
      bumpLast(saga.userId, patch.updatedAt ?? saga.updatedAt);
      return true;
    },
    lastPayoutAt: async (userId, _options?: Options) => {
      return lastByUser.get(userId) ?? null;
    },
    deadLetter: async (id, reason, _options?: Options) => {
      const saga = rows.get(id);
      if (!saga) {
        return;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...saga, state: 'FAILED', reason });
    },
  };
}

// --- Entitlement store ------------------------------------------------------------

interface EntitlementRow {
  attrs: EntitlementAttrs;
  revoked: boolean;
}

// Plain ownership records, not money movements. `revoke` is a soft delete (the row survives for
// auditing), and `owns` also checks `expiresAt`, so an expired rental stops counting as owned.
function createEntitlementStore(deps: {
  clock: Clock;
}): EntitlementStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, EntitlementRow>();
  const keyOf = (userId: string, sku: string): string => `${userId}::${sku}`;

  return {
    journal,
    grant: async (userId, sku, attrs, _options?: Options) => {
      // Overwriting clears any earlier revoke, so re-buying after a refund restores ownership.
      const key = keyOf(userId, sku);
      recordRowUndo(journal, rows, key);
      rows.set(key, { attrs: { ...attrs }, revoked: false });
    },
    revoke: async (userId, sku, _options?: Options) => {
      const key = keyOf(userId, sku);
      const row = rows.get(key);
      if (!row || row.revoked) {
        return;
      }
      recordRowUndo(journal, rows, key);
      rows.set(key, { ...row, revoked: true });
    },
    owns: async (userId, sku, _options?: Options) => {
      // Expiry check is inclusive of `expiresAt`; null `expiresAt` never expires.
      const row = rows.get(keyOf(userId, sku));
      if (!row || row.revoked) {
        return false;
      }
      const expiresAt = row.attrs.expiresAt;
      return expiresAt == null || deps.clock.now() <= expiresAt;
    },
    list: async function* (userId, _options?: Options) {
      const prefix = `${userId}::`;
      // noinspection JSMismatchedCollectionQueryUpdate
      const grants: Array<{ sku: string; expiresAt: number | null }> = [];
      for (const [key, row] of rows) {
        if (!key.startsWith(prefix) || row.revoked) {
          continue;
        }
        grants.push({
          sku: key.slice(prefix.length),
          expiresAt: row.attrs.expiresAt ?? null,
        });
      }
      grants.sort((a, b) => byCodeUnit(a.sku, b.sku));
      yield* grants;
    },
  };
}

// --- Subscription store -----------------------------------------------------------

function createSubscriptionStore(): SubscriptionStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, Subscription>();

  return {
    journal,
    open: async (sub, _options?: Options) => {
      recordRowUndo(journal, rows, sub.id);
      rows.set(sub.id, { ...sub });
    },
    load: async (id, _options?: Options) => {
      const sub = rows.get(id);
      return sub ? { ...sub } : null;
    },
    activeFor: async (userId, sku, sellerId, _options?: Options) => {
      for (const sub of rows.values()) {
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
      const sub = rows.get(id);
      if (!sub) {
        return;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...sub, state: 'CANCELED' });
    },
    claimDue: async (now, limit, _options?: Options) => {
      const due: Subscription[] = [];
      for (const sub of rows.values()) {
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
      // Compare-and-set on `expectedDueAt`: if an overlapping sweep already moved `nextDueAt`,
      // this one returns false and changes nothing, so a billing period is charged at most once.
      const sub = rows.get(id);
      if (!sub || sub.nextDueAt !== expectedDueAt) {
        return false;
      }
      recordRowUndo(journal, rows, id);
      // Renewal resets `attempts`, so recovered transient failures don't count toward the lapse cap.
      rows.set(id, { ...sub, nextDueAt, period: sub.period + 1, attempts: 0 });
      return true;
    },
    markLapsed: async (id, _options?: Options) => {
      const sub = rows.get(id);
      if (!sub) {
        return;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...sub, state: 'LAPSED' });
    },
  };
}

// --- Promo store ------------------------------------------------------------------

// Tracks promo grants so the expiry sweep can reverse the unspent remainder once the grant
// expires, and never twice.
function createPromoStore(): PromoStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, PromoGrant>();

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
      // Oldest `expiresAt` first across the whole table, then the `limit` cap.
      const due: PromoGrant[] = [];
      for (const grant of rows.values()) {
        if (grant.reversed === false && grant.expiresAt <= now) {
          due.push({ ...grant });
        }
      }
      due.sort((a, b) => a.expiresAt - b.expiresAt);
      return due.slice(0, limit);
    },
    markReversed: async (id, _options?: Options) => {
      const grant = rows.get(id);
      if (!grant || grant.reversed) {
        return;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...grant, reversed: true });
    },
  };
}

// --- Trust store ------------------------------------------------------------------

// Velocity counters for rate/abuse limiting. `bump` dedupes a repeat attempt by idempotency key,
// so a retry isn't counted twice. The windowed total is kept incrementally (a running `sumMinor`
// over the live tail) and reproduces the SQL adapters' windowed `SUM(amount) WHERE at > cutoff`
// exactly — same boundary, same windowStart.

// `sumMinor` = sum of the live tail `attempts[head..]`; entries before `head` have aged out and been
// subtracted.
type TrustWindow = { attempts: Attempt[]; head: number; sumMinor: bigint };

function createTrustStore(
  clock: Clock,
  windowMs: number,
): TrustStore & Participant {
  const bySubject = new Map<string, TrustWindow>();
  const seenAttempts = new Set<string>();
  const journal = createJournal();

  // The journal's undo for `insert`. Splicing keeps the window ordered by `at`. The sum only
  // covers the live tail, so it is corrected when the attempt was still there; an attempt that
  // had already aged out moves the head back instead.
  const remove = (subject: string, attempt: Attempt): void => {
    seenAttempts.delete(attempt.idempotencyKey);
    const window = bySubject.get(subject);
    if (window === undefined) {
      return;
    }
    const i = window.attempts.findIndex(
      (a) => a.idempotencyKey === attempt.idempotencyKey,
    );
    if (i < 0) {
      return;
    }
    window.attempts.splice(i, 1);
    if (i >= window.head) {
      window.sumMinor -= attempt.amount.minor;
    } else {
      window.head -= 1;
    }
  };

  // `at` comes from the clock (only moves forward), so the appended attempt is the newest and the
  // window stays ordered by `at` — which `measure`'s prefix-pruning relies on. A dedup-skipped
  // repeat changed nothing, so it records no undo.
  const insert = (subject: string, attempt: Attempt): void => {
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
    journal.record(() => remove(subject, attempt));
  };

  // Expired attempts are always a prefix (ordered by `at`), so advance `head` past just those and
  // never scan the live tail; compact the consumed prefix once it dominates so memory stays bounded.
  const measure = (subject: string, now: number): Velocity => {
    const window = bySubject.get(subject);
    const cutoff = now - windowMs;
    if (window !== undefined) {
      const attempts = window.attempts;
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
    const live =
      window === undefined ? 0 : window.attempts.length - window.head;
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
    // No `await` between the insert and the windowing, so two concurrent same-subject `record`
    // calls can't interleave — the atomicity `TrustStore.record` requires (ports.ts).
    record: async (subject, attempt, _options?: Options) => {
      insert(subject, attempt);
      return measure(subject, clock.now());
    },
    journal,
  };
}

// --- Movement journal ---------------------------------------------------------------

// Append-only and never part of a money transaction (see MovementJournal in ports.ts). The batch
// is validated in full before any row lands, so a conflict rejects all of it — the in-process
// mirror of the SQL engines' single-statement multi-row INSERT.
function createMovementJournal(): MovementJournal {
  const log: Movement[] = [];
  const idemKeys = new Set<string>();
  const positions = new Set<string>();
  return {
    append: async (movements) => {
      for (const movement of movements) {
        if (idemKeys.has(movement.idempotencyKey)) {
          throw new Error(
            `duplicate movement idempotency key: ${movement.idempotencyKey}`,
          );
        }
        if (positions.has(`${movement.sessionId}::${movement.seq}`)) {
          throw new Error(
            `duplicate movement position: ${movement.sessionId}::${movement.seq}`,
          );
        }
      }
      for (const movement of movements) {
        idemKeys.add(movement.idempotencyKey);
        positions.add(`${movement.sessionId}::${movement.seq}`);
        log.push({
          ...movement,
          legs: movement.legs.map((leg) => ({ ...leg })),
        });
      }
    },
    bySession: async function* (sessionId) {
      const own = log.filter((row) => row.sessionId === sessionId);
      own.sort((a, b) => a.seq - b.seq);
      yield* own;
    },
  };
}

// --- Checkpoint store -------------------------------------------------------------

// Append-only and never part of a money transaction, so a rollback can't delete a recorded checkpoint.
function createCheckpointStore(): CheckpointStore {
  const rows: Checkpoint[] = [];
  return {
    put: async (checkpoint, _options?: Options) => {
      rows.push({ ...checkpoint });
    },
    latest: async (_options?: Options) => {
      const last = rows[rows.length - 1];
      return last ? { ...last } : null;
    },
  };
}

// --- Replay store -----------------------------------------------------------------

// Drops duplicate provider webhooks by event id (a separate id space from callers' idempotency
// keys). Claimed outside any money transaction, so this store registers no undo.
function createReplayStore(): ReplayStore {
  const seen = new Set<string>();
  return {
    claim: async (eventId, _options?: Options) => {
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
 * others. The checkpoint store is written outside transactions and isn't rolled back. The hash
 * function and clock default to deterministic versions, so a plain `memoryStore()` is
 * reproducible.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the store ports this adapter implements.
 */
export function memoryStore(deps?: {
  digest?: Digest;
  clock?: Clock;
  velocityWindowMs?: number;
}): Store {
  const digest = deps?.digest ?? defaultDigest();
  const clock = deps?.clock ?? defaultClock();

  const velocityWindowMs = deps?.velocityWindowMs ?? 60 * 60_000;

  const ledger = createLedgerStore({ digest, clock });
  const idempotency = createIdempotencyStore();
  const sales = createSaleStore();
  const outbox = createOutboxStore();
  const inbox = createInboxStore();
  const sagas = createSagaStore();
  const entitlements = createEntitlementStore({ clock });
  const subscriptions = createSubscriptionStore();
  const promos = createPromoStore();
  const trust = createTrustStore(clock, velocityWindowMs);
  const checkpoints = createCheckpointStore();
  const movements = createMovementJournal();
  const replay = createReplayStore();

  const unit = {
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
  };
  const participants: Participant[] = Object.values(unit);

  return {
    ...unit,
    checkpoints,
    movements,
    replay,
    transaction: async (work) => {
      let begun = 0;
      try {
        for (const participant of participants) {
          participant.journal.begin();
          begun += 1;
        }
        const result = await work(unit);
        for (const participant of participants) {
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

// Rolls back only the stores that started this transaction — the first `begun` of them, newest
// first. A leftover open transaction could corrupt the next one, so one failing rollback must not
// stop the rest.
function rollbackAll(participants: Participant[], begun: number): void {
  for (let i = begun - 1; i >= 0; i -= 1) {
    try {
      participants[i]!.journal.rollback();
    } catch {
      // Best effort: ignore this one's failure and keep rolling back the others.
    }
  }
}
