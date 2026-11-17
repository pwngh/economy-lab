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
import { collapseEntitlementGrants } from '#src/entitlements.ts';
import { metaString, metaNumber, holdReleaseLotFields } from '#src/meta.ts';
import { sha256Digest } from '#src/digest.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Transaction } from '#src/contract.ts';
import type {
  AccrualRow,
  AccrualRowKey,
  AccrualStore,
  ArchivedPosting,
  Attempt,
  BatchSlot,
  Checkpoint,
  CheckpointStore,
  Clock,
  Digest,
  EntitlementRevokeOptions,
  EntitlementStore,
  IdempotencyStore,
  InboxMessage,
  InboxStore,
  Leg,
  Ledger,
  LinkPage,
  Lot,
  CallOptions,
  Movement,
  MovementJournal,
  ReservationStore,
  ArchiveState,
  OutboxMessage,
  OutboxStore,
  Posting,
  PromoGrant,
  PromoStore,
  Range,
  ReplayStore,
  Reproof,
  Saga,
  SaleStore,
  Sale,
  SagaStore,
  Statement,
  Store,
  StoredLink,
  Subscription,
  SubscriptionStore,
  TableSizes,
  TrustStore,
  Unit,
  Velocity,
} from '#src/ports.ts';
import type { EntitlementAttributes } from '#src/contract.ts';
import type { EntitlementRowRef } from '#src/entitlements.ts';

// --- Per-store undo log -----------------------------------------------------------

// While a transaction is open, every write records a reverser. Rollback runs the reversers
// last-to-first. With no transaction open, nothing is recorded. `mark`/`rollbackTo` are the
// savepoint pair batchTransaction uses: a mark names a point in the undo log, and rolling back to
// it reverses only the writes recorded past it.
interface Journal {
  begin(): void;
  commit(): void;
  rollback(): void;
  recording(): boolean;
  record(undo: () => void): void;
  mark(): number;
  rollbackTo(mark: number): void;
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
    mark: () => undos?.length ?? 0,
    rollbackTo: (mark) => {
      if (!undos) {
        return;
      }
      while (undos.length > mark) {
        undos.pop()!();
      }
    },
  };
}

// A store that joins transactions exposes its journal, so the top-level store can begin,
// commit, or roll back every participant together.
interface Participant {
  journal: Journal;
}

// This helper serves only stores that replace whole rows on write. The outbox and inbox mutate
// rows in place and journal their own field-level undos.
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

// The default clock is frozen at time 0. Pass a real clock when wall-clock time matters.
function defaultClock(): Clock {
  return { now: () => 0 };
}

// --- Ledger store -----------------------------------------------------------------

interface StoredPosting {
  txnId: string;
  legs: ReadonlyArray<Leg>;
  meta: Record<string, unknown>;
  postedAt: number;
  // `seq` is the stable commit sequence, the in-memory analogue of the SQL engines' postings.seq.
  // Page cursors key on it, so archival pruning (which shifts log indices) never moves a cursor.
  // The value is monotonic and never reused — a rolled-back append burns its value, exactly like
  // a sequence.
  seq: number;
  links: ReadonlyArray<{ account: AccountRef; prevHash: string; hash: string }>;
}

// Decides whether the ledger accepts a posting against this account. The ledger accepts a
// registered platform account or a shard of one (baseOf strips the suffix), or a user account
// with a known `:kind` suffix.
function isKnownAccount(account: AccountRef, registered: Set<string>): boolean {
  return registered.has(baseOf(account)) || walletKindOf(account) !== null;
}

interface LedgerState {
  journal: Journal;

  log: StoredPosting[];

  /** The last assigned commit sequence; see StoredPosting.seq. */
  seq: number;

  balances: Map<AccountRef, bigint>;

  // `heads` holds the latest chain-head hash per account, in lowercase hex. A missing entry
  // means no postings yet, so the head is the genesis hash.
  heads: Map<AccountRef, string>;

  registered: Set<string>;

  // This index lists each account's `log` positions that raised the balance (its lots), in
  // commit order. `timeline` walks one account's index instead of the whole shared log.
  lotIndexByAccount: Map<AccountRef, number[]>;

  // `deltaColumns` keeps each account's signed leg deltas as a resident i64 column per currency,
  // in commit order. A balance re-derivation folds the column instead of scanning the whole log.
  // The fold is the win on the hot platform accounts. Commit and rollback maintain the columns
  // alongside the log.
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
  // balance the SQL engines' BIGINT columns would refuse. Because the check runs first, a refused
  // posting throws with nothing applied, so the recorded undo always reverses a complete commit.
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

// Returns the distinct accounts a posting raised: those with a balance-increasing leg.
// commitPosting indexes the posting under each. undoPosting removes it. The index selects
// postings, not legs, so a posting that both raises and lowers one account is indexed under it and
// reaches lotsOfPosting with both legs.
function lottedAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
  return distinctAccounts(legs.filter((leg) => balanceDelta(leg).minor > 0n));
}

// This bundle carries what undoPosting needs: prior chain heads, the accounts this posting first
// created (undo deletes them so rollback leaves no zero-balance stub), and the lotted accounts
// (undo pops their lot-index entry). One parameter keeps the function under the parameter-count
// cap.
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
    seq: 0,

    balances: new Map(),
    heads: new Map(),
    registered: new Set<string>(Object.values(SYSTEM)),
    lotIndexByAccount: new Map(),
    deltaColumns: new Map(),
  };

  return {
    journal: state.journal,

    hasAccount: async (account) => isKnownAccount(account, state.registered),

    // The store is single-threaded, so there is nothing to lock against and this is a no-op. It
    // exists so callers can issue the same `lock` against every adapter.
    lock: async () => {},

    append: async (posting) => {
      const postedAt = deps.clock.now();
      const links = await advanceChain(state, deps.digest, posting);
      state.seq += 1;
      const stored: StoredPosting = {
        txnId: posting.txnId,
        legs: posting.legs,
        meta: posting.meta,
        postedAt,
        seq: state.seq,
        links,
      };
      commitPosting(state, stored);
      return {
        id: stored.txnId,
        postedAt,
        legs: stored.legs,
        links,
        meta: stored.meta,
      };
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

    headSums: () => headSumsOf(state),

    // Reads `state.balances` keys, not heads, so a balance with no posting still reaches the
    // integrity checker. Code-unit sorting makes every engine list accounts in the same order.
    balanceAccounts: async function* () {
      for (const account of [...state.balances.keys()].sort(byCodeUnit)) {
        yield account;
      }
    },

    lineage: (account, options) =>
      lineageOf(state.log, account, options?.sinceHash),

    posting: async (txnId) => postingOf(state.log, txnId),

    links: async (txnId) => {
      const row = state.log.find((entry) => entry.txnId === txnId);
      return row === undefined ? [] : row.links.map((link) => ({ ...link }));
    },

    linksPage: async (cursor, limit) => linksPageOf(state.log, cursor, limit),

    historySize: async () =>
      state.log.length === 0 ? 0 : state.log[state.log.length - 1]!.seq,

    archivePage: async (cursor, limit) =>
      archivePageOf(state.log, cursor, limit),

    prune: async (txnIds) => pruneFromLog(state, txnIds),

    list: () => listPostingsOf(state.log),

    __tamper: (txnId, mutate) => tamperPosting(state, txnId, mutate),

    __seedBalance: (account, amount) =>
      state.balances.set(account, amount.minor),
  };
}

// Yields heads paired with each account's raw signed leg sum, for the v2 checkpoint's sum leaves.
// Raw means as posted (debit positive), not the account's natural side, so all accounts
// together net to zero.
async function* headSumsOf(
  state: LedgerState,
): AsyncGenerator<readonly [AccountRef, string, bigint]> {
  const raw = new Map<AccountRef, bigint>();
  for (const row of state.log) {
    for (const leg of row.legs) {
      raw.set(leg.account, (raw.get(leg.account) ?? 0n) + leg.amount.minor);
    }
  }
  for (const [account, head] of sortedHeads(state.heads)) {
    yield [account, head, raw.get(account) ?? 0n] as const;
  }
}

// Serves the mover's page read: whole postings in commit order. The cursor is the last consumed
// posting's seq, stable under archival pruning.
function archivePageOf(
  log: ReadonlyArray<StoredPosting>,
  cursor: number | null,
  limit: number,
): { postings: ArchivedPosting[]; cursor: number | null } {
  const eligible = log.filter((row) => cursor === null || row.seq > cursor);
  const page = eligible.slice(0, limit);
  return {
    postings: page.map((row) => ({
      txnId: row.txnId,
      seq: row.seq,
      postedAt: row.postedAt,
      meta: row.meta,
      legs: [...row.legs],
      links: row.links.map((link) => ({ ...link })),
    })),
    cursor: page.length < eligible.length ? page[page.length - 1]!.seq : null,
  };
}

// Pages hold whole postings so links never split. The cursor is the last consumed posting's seq.
function linksPageOf(
  log: ReadonlyArray<StoredPosting>,
  cursor: number | null,
  limit: number,
): LinkPage {
  const eligible = log.filter((row) => cursor === null || row.seq > cursor);
  const page = eligible.slice(0, limit);
  const links: Array<{ account: AccountRef } & StoredLink> = [];
  for (const row of page) {
    for (const link of row.links) {
      links.push({
        account: link.account,
        txnId: row.txnId,
        legs: row.legs,
        meta: row.meta,
        prevHash: link.prevHash,
        hash: link.hash,
      });
    }
  }
  return {
    links,
    cursor: page.length < eligible.length ? page[page.length - 1]!.seq : null,
  };
}

// Implements the mover's delete half. It removes whole postings from the log and rebuilds every
// log-derived structure — the index-coupled lot positions and the per-account delta columns —
// from the kept rows. `derivedBalances` and `timeline` then see remaining history only, exactly
// as the SQL engines' row deletes leave them. The journal records the change, so a rolled-back
// transaction restores all of it. Balances and chain heads stay, because pruning removes history,
// never money state.
function pruneFromLog(state: LedgerState, txnIds: ReadonlyArray<string>): void {
  const doomed = new Set(txnIds);
  const priorLog = state.log;
  const priorLots = state.lotIndexByAccount;
  const priorDeltas = state.deltaColumns;
  const kept = priorLog.filter((row) => !doomed.has(row.txnId));
  if (kept.length === priorLog.length) {
    return;
  }
  const lots = new Map<AccountRef, number[]>();
  kept.forEach((row, index) => {
    for (const account of lottedAccounts(row.legs)) {
      const positions = lots.get(account) ?? [];
      positions.push(index);
      lots.set(account, positions);
    }
  });
  state.log = kept;
  state.lotIndexByAccount = lots;
  state.deltaColumns = new Map();
  for (const row of kept) {
    for (const leg of row.legs) {
      appendDelta(state, leg.account, balanceDelta(leg));
    }
  }
  state.journal.record(() => {
    state.log = priorLog;
    state.lotIndexByAccount = priorLots;
    state.deltaColumns = priorDeltas;
  });
}

// Returns the chain heads in code-unit account order rather than Map insertion order, so every
// engine lists accounts identically.
function sortedHeads(
  heads: Map<AccountRef, string>,
): Array<[AccountRef, string]> {
  return [...heads].sort((a, b) => byCodeUnit(a[0], b[0]));
}

// Entries are signed by how they changed this account's balance (money in reads positive).
// Everything fits one page, so the cursor is always null.
//
// `log` is append-only, so walking it is the commit order the Ledger.statement contract fixes, and
// walking each posting's legs in place holds the order the caller wrote them. `postedAt` selects
// the rows and never orders them: it comes from the injected Clock, and nothing makes it rise.
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
// compare it against the maintained one without re-scanning the log. Currency sorting makes every
// engine return the same order.
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

// A balance-lowering leg is not a lot, so it is skipped. This is the only per-leg sign filter on
// the path, because `lottedAccounts` selects postings. The SQL engines filter legs in the query
// and keep this check only against a drifted schema; here it is the filter.
// `source`/`maturesAt` fall back to "unknown" and mature-now when the metadata omits them.
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
      ...holdReleaseLotFields(account, row.meta),
    };
  }
}

// Yields every posting that touched this account, in order, with the prevHash/hash pair the
// chain verifier recomputes against. With `sinceHash`, it yields only links recorded after the
// one carrying that head. An unknown hash yields nothing (see Ledger.lineage).
async function* lineageOf(
  log: ReadonlyArray<StoredPosting>,
  account: AccountRef,
  sinceHash?: string,
): AsyncIterable<StoredLink> {
  let started = sinceHash === undefined;
  for (const row of log) {
    const link = row.links.find((entry) => entry.account === account);
    if (!link) {
      continue;
    }
    if (!started) {
      if (link.hash === sinceHash) {
        started = true;
      }
      continue;
    }
    yield {
      txnId: row.txnId,
      legs: row.legs,
      meta: row.meta,
      prevHash: link.prevHash,
      hash: link.hash,
    };
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

// Test-only. Implements `__tamper`. See the MemoryLedger type JSDoc for why this is the
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

// `claim` never writes `committed` and `record`'s journal undo removes what it wrote, so a
// rolled-back attempt leaves the key unused rather than replaying a transaction that never landed.
// `claim` reads `committed` alone: this store runs one transaction at a time, so no key is ever in
// flight when a second claim arrives.
function createIdempotencyStore(deps: {
  clock: Clock;
}): IdempotencyStore & Participant & { size(): number } {
  const journal = createJournal();
  const committed = new Map<string, Transaction>();
  // `at` records each row's birth time (claim or first record), the SQL twins' created_at.
  const at = new Map<string, number>();

  return {
    journal,

    claim: async (key, _options?: CallOptions) => {
      const prior = committed.get(key);
      if (prior) {
        return { claimed: false, transaction: prior };
      }
      const hadAt = at.has(key);
      if (!hadAt) {
        at.set(key, deps.clock.now());
        journal.record(() => at.delete(key));
      }
      return { claimed: true };
    },

    record: async (key, transaction, _options?: CallOptions) => {
      committed.set(key, transaction);
      const hadAt = at.has(key);
      if (!hadAt) {
        at.set(key, deps.clock.now());
      }
      journal.record(() => {
        committed.delete(key);
        if (!hadAt) {
          at.delete(key);
        }
      });
    },

    deleteOlderThan: async (cutoffMs, limit, _options?: CallOptions) => {
      const due = [...at.entries()]
        .filter(([, bornAt]) => bornAt < cutoffMs)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit);
      for (const [key] of due) {
        at.delete(key);
        committed.delete(key);
      }
      return due.length;
    },

    size: () => at.size,
  };
}

// --- Sale store -------------------------------------------------------------------

// Records each completed sale, keyed by order id (separate from the idempotency key), so a
// later refund can reverse what the original purchase posted.
function createSaleStore(): SaleStore & Participant & { size(): number } {
  const journal = createJournal();
  const rows = new Map<string, Sale>();
  return {
    journal,
    size: () => rows.size,
    put: async (sale, _options?: CallOptions) => {
      recordRowUndo(journal, rows, sale.orderId);
      rows.set(sale.orderId, sale);
    },
    get: async (orderId, _options?: CallOptions) => rows.get(orderId) ?? null,
  };
}

// --- Outbox store -----------------------------------------------------------------

// This is the transactional outbox. Events are saved in the money move's transaction and relayed
// later, at least once. The clock stamps enqueue times so `stats` can age the backlog.
function createOutboxStore(deps: {
  clock: Clock;
}): OutboxStore & Participant & { size(): number } {
  const journal = createJournal();
  const rows = new Map<string, OutboxMessage>();
  const order: string[] = [];
  const enqueuedAt = new Map<string, number>();

  return {
    journal,
    size: () => rows.size,
    enqueue: async (message, _options?: CallOptions) => {
      rows.set(message.id, message);
      order.push(message.id);
      enqueuedAt.set(message.id, deps.clock.now());
      journal.record(() => {
        rows.delete(message.id);
        order.pop();
        enqueuedAt.delete(message.id);
      });
    },
    claimBatch: async (limit, _options?: CallOptions) => {
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
    markRelayed: async (ids, _options?: CallOptions) => {
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
    bumpAttempt: async (id, _options?: CallOptions) => {
      const message = rows.get(id);
      if (!message || message.status !== 'pending') {
        return 0;
      }
      const prior = message.attempts;
      journal.record(() => {
        message.attempts = prior;
      });
      message.attempts += 1;
      return message.attempts;
    },
    deadLetter: async (id, reason, _options?: CallOptions) => {
      const message = rows.get(id);
      if (!message || message.status !== 'pending') {
        return;
      }
      const prior = { ...message };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...message, status: 'dead', reason });
    },
    stats: async (_options?: CallOptions) =>
      outboxStatsOf(rows, enqueuedAt, deps.clock),
  };
}

function outboxStatsOf(
  rows: ReadonlyMap<string, OutboxMessage>,
  enqueuedAt: ReadonlyMap<string, number>,
  clock: Clock,
): { pending: number; oldestPendingAgeMs: number | null } {
  let pending = 0;
  let oldestAt: number | null = null;
  for (const [id, message] of rows) {
    if (message.status !== 'pending') {
      continue;
    }
    pending += 1;
    const at = enqueuedAt.get(id);
    if (at !== undefined && (oldestAt === null || at < oldestAt)) {
      oldestAt = at;
    }
  }
  return {
    pending,
    oldestPendingAgeMs: oldestAt === null ? null : clock.now() - oldestAt,
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbox mirrors the outbox for the inbound direction. It holds verified provider events,
// already mapped to operations, saved in the webhook ingress transaction. Enqueue dedupes on
// `key` (the provider event id), returning the existing row for a redelivery.
function createInboxStore(): InboxStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, InboxMessage>();
  const order: string[] = [];
  const byKey = new Map<string, string>();

  return {
    journal,
    enqueueInbound: async (entry, _options?: CallOptions) => {
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
    claimInbound: async (input, _options?: CallOptions) => {
      // Claims the oldest `receivedAt` rows across the whole table, then applies the `limit`
      // cap. `input.now` is unused: the inbox has no due-time gate.
      const pending: InboxMessage[] = [];
      for (const id of order) {
        const entry = rows.get(id);
        if (entry && entry.status === 'pending') {
          pending.push({ ...entry });
        }
      }
      pending.sort((a, b) => a.receivedAt - b.receivedAt);
      return pending.slice(0, input.limit);
    },
    markApplied: async (id, _options?: CallOptions) => {
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
    bumpAttempt: async (id, _options?: CallOptions) => {
      const entry = rows.get(id);
      if (!entry || entry.status !== 'pending') {
        return 0;
      }
      const prior = entry.attempts;
      journal.record(() => {
        entry.attempts = prior;
      });
      entry.attempts += 1;
      return entry.attempts;
    },
    deadLetter: async (id, reason, _options?: CallOptions) => {
      const entry = rows.get(id);

      if (!entry || entry.status !== 'pending') {
        return;
      }
      const prior = { ...entry };
      journal.record(() => rows.set(id, prior));
      rows.set(id, { ...entry, status: 'dead', reason });
    },
    reviveDead: async (limit, _options?: CallOptions) =>
      reviveDeadRows(journal, rows, limit),
  };
}

// Revives the oldest receivedAt rows first, mirroring the SQL engines' `order by received_at`.
function reviveDeadRows(
  journal: Journal,
  rows: Map<string, InboxMessage>,
  limit: number,
): InboxMessage[] {
  const dead: InboxMessage[] = [];
  for (const entry of rows.values()) {
    if (entry.status === 'dead') {
      dead.push(entry);
    }
  }
  dead.sort((a, b) => a.receivedAt - b.receivedAt);
  const revived: InboxMessage[] = [];
  for (const entry of dead.slice(0, Math.max(0, limit))) {
    const prior = { ...entry };
    journal.record(() => rows.set(entry.id, prior));
    const next: InboxMessage = {
      ...entry,
      status: 'pending',
      attempts: 0,
      reason: null,
    };
    rows.set(entry.id, next);
    revived.push({ ...next });
  }
  return revived;
}

// --- Saga store -------------------------------------------------------------------

// Lists newest `updatedAt` first, with ties by `id` descending (see SagaStore.list), matching
// the SQL engines' `order by updated_at desc, id desc`.
async function* listSubscriptionsOf(
  rows: Map<string, Subscription>,
  userId: string,
): AsyncIterable<Subscription> {
  const snapshot = [...rows.values()]
    .filter((sub) => sub.userId === userId)
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
    );
  for (const sub of snapshot) {
    yield { ...sub };
  }
}

async function* listSagasOf(
  rows: Map<string, Saga>,
  states?: readonly Saga['state'][],
  userId?: string,
): AsyncIterable<Saga> {
  const wanted = states === undefined ? null : new Set(states);
  const snapshot = [...rows.values()]
    .filter((saga) => wanted === null || wanted.has(saga.state))
    .filter((saga) => userId === undefined || saga.userId === userId)
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
    );
  for (const saga of snapshot) {
    yield { ...saga };
  }
}

// Implements the inbound-webhook lookup (see SagaStore.findByProviderRef). On a duplicated ref
// the newest `updatedAt` wins, matching the SQL engines' `order by updated_at desc limit 1`.
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
function createSagaStore(): SagaStore & Participant & { size(): number } {
  const journal = createJournal();
  const rows = new Map<string, Saga>();
  // `lastByUser` tracks the max `updatedAt` per user, so `lastPayoutAt` needs no scan.
  // `updatedAt` only increases, so the index only rises on a write and is restored on rollback.
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
    size: () => rows.size,
    open: async (saga, _options?: CallOptions) => {
      recordRowUndo(journal, rows, saga.id);
      rows.set(saga.id, { ...saga });
      bumpLast(saga.userId, saga.updatedAt);
    },
    load: async (id, _options?: CallOptions) => {
      const saga = rows.get(id);
      return saga ? { ...saga } : null;
    },
    findByProviderRef: (providerRef, _options?: CallOptions) =>
      findSagaByRef(rows, providerRef),
    list: (options) => listSagasOf(rows, options?.states, options?.userId),
    // Claims only RESERVED and SUBMITTED rows, matching the SQL engines' claim queries. A row
    // still in REQUESTED means its opening step crashed partway, so the claim skips it on purpose.
    claimDue: async (now, limit, _options?: CallOptions) => {
      const due: Saga[] = [];
      for (const saga of rows.values()) {
        if (due.length >= limit) {
          break;
        }
        if (
          saga.dueAt <= now &&
          (saga.state === 'RESERVED' || saga.state === 'SUBMITTED')
        ) {
          due.push({ ...saga });
        }
      }
      return due;
    },
    // The five parameters of SagaStore.advance arrive as a tuple: naming them all would trip the
    // repo's four-parameter cap.
    advance: async (...args) => {
      const [id, from, to, patch, options] = args;
      const saga = rows.get(id);
      if (!saga || saga.state !== from) {
        return false;
      }
      if (
        options?.expectAttempts !== undefined &&
        saga.attempts !== options.expectAttempts
      ) {
        return false;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...saga, ...patch, state: to });
      bumpLast(saga.userId, patch.updatedAt ?? saga.updatedAt);
      return true;
    },
    lastPayoutAt: async (userId, _options?: CallOptions) => {
      return lastByUser.get(userId) ?? null;
    },
    deadLetter: async (id, reason, _options?: CallOptions) => {
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
  userId: string;
  sku: string;
  source: string;
  attrs: EntitlementAttributes;
  revoked: boolean;
}

// The store holds plain ownership records, not money movements. One row per (userId, sku, source),
// so a refund drops the grant its own order made and leaves the rest. `revoke` is a soft delete
// (the row survives for auditing), and `owns` also checks `expiresAt`, so an expired rental stops
// counting as owned.
function createEntitlementStore(deps: {
  clock: Clock;
}): EntitlementStore & Participant & { size(): number } {
  const journal = createJournal();
  const rows = new Map<string, EntitlementRow>();
  const keyOf = (userId: string, sku: string, source: string): string =>
    `${userId}::${sku}::${source}`;
  const live = (row: EntitlementRow, userId: string, sku: string): boolean =>
    !row.revoked && row.userId === userId && row.sku === sku;

  return {
    journal,
    // Revoked rows count: they still occupy the table, which is what the capacity gauge reads.
    size: () => rows.size,
    grant: async (userId, sku, attrs, _options?: CallOptions) => {
      // Overwriting clears this source's earlier revoke, so re-buying restores ownership.
      const source = attrs.source ?? '';
      const key = keyOf(userId, sku, source);
      recordRowUndo(journal, rows, key);
      rows.set(key, {
        userId,
        sku,
        source,
        attrs: { ...attrs },
        revoked: false,
      });
    },
    revoke: async (userId, sku, options?: EntitlementRevokeOptions) => {
      for (const [key, row] of rows) {
        if (!live(row, userId, sku)) {
          continue;
        }
        if (options?.source !== undefined && row.source !== options.source) {
          continue;
        }
        recordRowUndo(journal, rows, key);
        rows.set(key, { ...row, revoked: true });
      }
    },
    owns: async (userId, sku, _options?: CallOptions) => {
      // The expiry check is inclusive of `expiresAt`. A null `expiresAt` never expires. Any one
      // live grant owns the sku.
      const now = deps.clock.now();
      for (const row of rows.values()) {
        if (!live(row, userId, sku)) {
          continue;
        }
        const expiresAt = row.attrs.expiresAt;
        if (expiresAt == null || now <= expiresAt) {
          return true;
        }
      }
      return false;
    },
    list: async function* (userId, _options?: CallOptions) {
      const held: EntitlementRowRef[] = [];
      for (const row of rows.values()) {
        if (!row.revoked && row.userId === userId) {
          held.push({
            sku: row.sku,
            source: row.source,
            expiresAt: row.attrs.expiresAt ?? null,
          });
        }
      }
      yield* collapseEntitlementGrants(held);
    },
  };
}

// --- Subscription store -----------------------------------------------------------

function createSubscriptionStore(): SubscriptionStore & Participant {
  const journal = createJournal();
  const rows = new Map<string, Subscription>();

  return {
    journal,
    open: async (sub, _options?: CallOptions) => {
      recordRowUndo(journal, rows, sub.id);
      rows.set(sub.id, { ...sub });
    },
    load: async (id, _options?: CallOptions) => {
      const sub = rows.get(id);
      return sub ? { ...sub } : null;
    },
    activeFor: async (userId, sku, sellerId, _options?: CallOptions) => {
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
    listFor: (userId, _options?: CallOptions) =>
      listSubscriptionsOf(rows, userId),
    cancel: async (id, _options?: CallOptions) => {
      const sub = rows.get(id);
      if (!sub) {
        return;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...sub, state: 'CANCELED' });
    },
    claimDue: async (now, limit, _options?: CallOptions) => {
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
    markBilled: async (
      id,
      nextDueAt,
      expectedDueAt,
      _options?: CallOptions,
    ) => {
      // The write is a compare-and-set on `expectedDueAt`. If an overlapping sweep already moved
      // `nextDueAt`, this one returns false and changes nothing, so a billing period is charged
      // at most once.
      const sub = rows.get(id);
      if (!sub || sub.nextDueAt !== expectedDueAt) {
        return false;
      }
      recordRowUndo(journal, rows, id);
      // Renewal resets `attempts`, so recovered transient failures don't count toward the lapse cap.
      rows.set(id, { ...sub, nextDueAt, period: sub.period + 1, attempts: 0 });
      return true;
    },
    markLapsed: async (id, _options?: CallOptions) => {
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
    open: async (grant, _options?: CallOptions) => {
      // Grant id equals its posting's txnId, so re-opening must leave the first row untouched (unlike
      // SagaStore/SubscriptionStore.open, which replace).
      if (rows.has(grant.id)) {
        return;
      }
      journal.record(() => rows.delete(grant.id));
      rows.set(grant.id, { ...grant });
    },
    claimDue: async (now, limit, _options?: CallOptions) => {
      // Claims the oldest `expiresAt` grants across the whole table, then applies the `limit` cap.
      const due: PromoGrant[] = [];
      for (const grant of rows.values()) {
        if (grant.reversed === false && grant.expiresAt <= now) {
          due.push({ ...grant });
        }
      }
      due.sort((a, b) => a.expiresAt - b.expiresAt);
      return due.slice(0, limit);
    },
    liveFor: async (userId, _options?: CallOptions) => {
      const live: PromoGrant[] = [];
      for (const grant of rows.values()) {
        if (grant.userId === userId && grant.reversed === false) {
          live.push({ ...grant });
        }
      }
      return live;
    },
    holders: async function* (_options?: CallOptions) {
      const seen = new Set<string>();
      for (const grant of rows.values()) {
        if (seen.has(grant.userId)) {
          continue;
        }
        seen.add(grant.userId);
        yield grant.userId;
      }
    },
    markReversed: async (id, _options?: CallOptions) => {
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

// The store keeps velocity counters for rate/abuse limiting. `bump` dedupes a repeat attempt by
// idempotency key, so a retry isn't counted twice. The windowed total is kept incrementally (a
// running `sumMinor` over the live tail) and reproduces the SQL adapters' windowed `SUM(amount)
// WHERE at > cutoff` exactly — same boundary, same windowStart.

// `sumMinor` holds the sum of the live tail `attempts[head..]`. Entries before `head` have aged
// out and been subtracted.
type TrustWindow = { attempts: Attempt[]; head: number; sumMinor: bigint };

function createTrustStore(
  clock: Clock,
  windowMs: number,
): TrustStore & Participant {
  const bySubject = new Map<string, TrustWindow>();
  const seenAttempts = new Set<string>();
  const journal = createJournal();

  // `remove` is the journal's undo for `insert`. Splicing keeps the window ordered by `at`. The
  // sum only covers the live tail, so it is corrected when the attempt was still there. An
  // attempt that had already aged out moves the head back instead.
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

  // Expired attempts are always a prefix (ordered by `at`), so advance `head` past just those
  // and never scan the live tail. Compact the consumed prefix once it dominates so memory stays
  // bounded.
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
      // Compaction runs at >= 50% consumed. The copy amortizes to O(1) per attempt, and the
      // array never holds more than 2x the live entries.
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
    read: async (subject, _options?: CallOptions) =>
      measure(subject, clock.now()),
    bump: async (subject, attempt, _options?: CallOptions) =>
      insert(subject, attempt),
    // There is no `await` between the insert and the windowing, so two concurrent same-subject
    // `record` calls can't interleave — the atomicity `TrustStore.record` requires (ports.ts).
    record: async (subject, attempt, _options?: CallOptions) => {
      insert(subject, attempt);
      return measure(subject, clock.now());
    },
    journal,
  };
}

// --- Accrual store ----------------------------------------------------------------

// The store parks seller shares under the accrual split. The store is single-threaded, so the
// SQL engines' row locks reduce to the store's one-writer transaction queue. The journal undoes
// puts and marks the way it undoes every other row write.
function createAccrualStore(deps: {
  clock: Clock;
}): AccrualStore & Participant & { size(): number } {
  const journal = createJournal();
  const rows = new Map<string, AccrualRow>();
  const order: string[] = [];
  const keyOf = (key: AccrualRowKey): string =>
    `${key.orderId}::${key.sellerId}::${key.seq}`;

  const mark = (
    keys: ReadonlyArray<AccrualRowKey>,
    status: 'drained' | 'refunded',
    settledTxnId: string,
  ): void => {
    for (const key of keys) {
      const id = keyOf(key);
      const row = rows.get(id);
      if (!row || row.status !== 'pending') {
        continue;
      }
      recordRowUndo(journal, rows, id);
      rows.set(id, { ...row, status, settledTxnId });
    }
  };

  return {
    journal,
    size: () => rows.size,
    put: async (batch, _options?: CallOptions) => {
      for (const row of batch) {
        const id = keyOf(row);
        if (rows.has(id)) {
          throw new Error(`duplicate accrual row: ${id}`);
        }
        rows.set(id, { ...row });
        order.push(id);
        journal.record(() => {
          rows.delete(id);
          order.pop();
        });
      }
    },
    claimByOrder: async (orderId, _options?: CallOptions) =>
      selectAccruals(rows, order, (row) => row.orderId === orderId),
    pendingSellers: async (limit, _options?: CallOptions) => {
      const sellers: string[] = [];
      for (const id of order) {
        const row = rows.get(id);
        if (
          row &&
          row.status === 'pending' &&
          !sellers.includes(row.sellerId)
        ) {
          sellers.push(row.sellerId);
          if (sellers.length >= limit) {
            break;
          }
        }
      }
      return sellers;
    },
    claimPendingBySeller: async (sellerId, limit, _options?: CallOptions) =>
      claimSellerPending(rows, order, sellerId, limit),
    markDrained: async (keys, txnId, _options?: CallOptions) =>
      mark(keys, 'drained', txnId),
    markRefunded: async (keys, txnId, _options?: CallOptions) =>
      mark(keys, 'refunded', txnId),
    stats: async (_options?: CallOptions) => accrualStatsOf(rows, deps.clock),
    netPending: async (sellerId, _options?: CallOptions) => {
      let net = 0n;
      for (const row of rows.values()) {
        if (row.sellerId === sellerId && row.status === 'pending') {
          net += row.amount.minor;
        }
      }
      return net;
    },
  };
}

// Positive shares claim before recovery rows (see AccrualStore), each in insertion order.
function claimSellerPending(
  rows: ReadonlyMap<string, AccrualRow>,
  order: ReadonlyArray<string>,
  sellerId: string,
  limit: number,
): AccrualRow[] {
  const pending = selectAccruals(
    rows,
    order,
    (row) => row.sellerId === sellerId && row.status === 'pending',
  );
  return [
    ...pending.filter((row) => row.amount.minor > 0n),
    ...pending.filter((row) => row.amount.minor < 0n),
  ].slice(0, limit);
}

// Returns the rows matching `want`, in insertion order. Each row is copied so a caller can't
// mutate stored state.
function selectAccruals(
  rows: ReadonlyMap<string, AccrualRow>,
  order: ReadonlyArray<string>,
  want: (row: AccrualRow) => boolean,
  limit = Infinity,
): AccrualRow[] {
  const selected: AccrualRow[] = [];
  for (const id of order) {
    if (selected.length >= limit) {
      break;
    }
    const row = rows.get(id);
    if (row && want(row)) {
      selected.push({ ...row });
    }
  }
  return selected;
}

// Computes the drain's backlog gauge pair: the positive pending total plus the oldest pending
// row's age.
function accrualStatsOf(
  rows: ReadonlyMap<string, AccrualRow>,
  clock: Clock,
): { pendingMinor: bigint; oldestPendingAgeMs: number | null } {
  let pendingMinor = 0n;
  let oldestAt: number | null = null;
  for (const row of rows.values()) {
    if (row.status !== 'pending') {
      continue;
    }
    if (row.amount.minor > 0n) {
      pendingMinor += row.amount.minor;
    }
    if (oldestAt === null || row.recordedAt < oldestAt) {
      oldestAt = row.recordedAt;
    }
  }
  return {
    pendingMinor,
    oldestPendingAgeMs: oldestAt === null ? null : clock.now() - oldestAt,
  };
}

// --- Movement journal ---------------------------------------------------------------

// The journal is append-only and never part of a money transaction (see MovementJournal in
// ports.ts). The batch is validated in full before any row lands, so a conflict rejects all of
// it — the in-process mirror of the SQL engines' single-statement multi-row INSERT.
function createMovementJournal(): MovementJournal & { size(): number } {
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
    sessionIds: async function* () {
      const seen = new Set<string>();
      for (const row of log) {
        seen.add(row.sessionId);
      }
      yield* [...seen].sort();
    },
    pruneSession: async (sessionId) => {
      let removed = 0;
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const row = log[i]!;
        if (row.sessionId !== sessionId) {
          continue;
        }
        idemKeys.delete(row.idempotencyKey);
        positions.delete(`${row.sessionId}::${row.seq}`);
        log.splice(i, 1);
        removed += 1;
      }
      return removed;
    },
    size: () => log.length,
  };
}

// --- Reservation store ------------------------------------------------------------

// This store is the in-process twin of the SQL engines' single-row-per-account counter. `add`
// folds the delta and returns the post-add total, exactly the add-then-check contract in ports.ts.
function createReservationStore(): ReservationStore {
  const totals = new Map<AccountRef, bigint>();
  return {
    add: async (account, naturalDelta) => {
      const total = (totals.get(account) ?? 0n) + naturalDelta;
      totals.set(account, total);
      return total;
    },
    pending: async (account) => totals.get(account) ?? 0n,
    entries: async function* () {
      yield* [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    },
  };
}

// --- Checkpoint store -------------------------------------------------------------

// The store is append-only and never part of a money transaction, so a rollback can't delete a
// recorded checkpoint. The seal-head snapshot upserts per account and mirrors the SQL engines'
// seal_heads table for the incremental seal.
function createCheckpointStore(): CheckpointStore {
  const rows: Checkpoint[] = [];
  const heads = new Map<AccountRef, { head: string; sum: bigint }>();
  const archiveHeadRows = new Map<AccountRef, { head: string; sum: bigint }>();
  let reproof: Reproof | null = null;
  let archive: ArchiveState | null = null;
  return {
    reproof: async (_options?: CallOptions) =>
      reproof === null ? null : { ...reproof },
    putReproof: async (state, _options?: CallOptions) => {
      reproof = { ...state };
    },
    put: async (checkpoint, _options?: CallOptions) => {
      rows.push({ ...checkpoint });
    },
    latest: async (_options?: CallOptions) => {
      const last = rows[rows.length - 1];
      return last ? { ...last } : null;
    },
    putSealHeads: async (leaves, options?) => {
      if (options?.replaceAll === true) {
        heads.clear();
      }
      for (const [account, head, sum] of leaves) {
        heads.set(account, { head, sum });
      }
    },
    sealHeads: async (_options?: CallOptions) =>
      [...heads].map(([account, row]) => [account, row.head, row.sum] as const),
    archiveState: async (_options?: CallOptions) =>
      archive === null ? null : { ...archive },
    archiveHeads: async (_options?: CallOptions) =>
      [...archiveHeadRows].map(([account, row]) => ({
        account,
        head: row.head,
        sum: row.sum,
      })),
    putArchiveBoundary: async (state, rows_, _options?: CallOptions) => {
      archive = { ...state };
      for (const row of rows_) {
        archiveHeadRows.set(row.account, { head: row.head, sum: row.sum });
      }
    },
  };
}

// --- Replay store -----------------------------------------------------------------

// Drops duplicate provider webhooks by event id (a separate id space from callers' idempotency
// keys). Claims happen outside any money transaction, so this store registers no undo.
function createReplayStore(): ReplayStore {
  const seen = new Set<string>();
  return {
    claim: async (eventId, _options?: CallOptions) => {
      if (seen.has(eventId)) {
        return { claimed: false };
      }
      seen.add(eventId);
      return { claimed: true };
    },
  };
}

// Builds the store-level size gauge over the memory twins' collections.
function tableSizesOf(
  unit: {
    idempotency: { size(): number };
    sales: { size(): number };
    outbox: { size(): number };
    sagas: { size(): number };
    accruals: { size(): number };
    entitlements: { size(): number };
  },
  movements: { size(): number },
): () => Promise<TableSizes> {
  return async () => ({
    movements: movements.size(),
    idempotency: unit.idempotency.size(),
    sales: unit.sales.size(),
    outbox: unit.outbox.size(),
    sagas: unit.sagas.size(),
    accruals: unit.accruals.size(),
    entitlements: unit.entitlements.size(),
  });
}

// --- Assembled store --------------------------------------------------------------

/**
 * Build an in-memory {@link Store} with working transaction rollback, for tests and
 * development. If the work inside a `transaction` throws, every store that joined the
 * transaction is rolled back. Each rolls back independently, so one store's failing rollback
 * can't stop the others. The checkpoint store is written outside transactions and isn't rolled
 * back. The hash function and clock default to deterministic versions, so a plain `memoryStore()`
 * is reproducible.
 *
 * Overlapping `transaction` calls queue and run one at a time in arrival order, so the memory
 * store never interleaves writers. `velocityWindowMs` sets the trust store's velocity window and
 * defaults to one hour, matching the SQL stores.
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
  const idempotency = createIdempotencyStore({ clock });
  const sales = createSaleStore();
  const outbox = createOutboxStore({ clock });
  const inbox = createInboxStore();
  const sagas = createSagaStore();
  const entitlements = createEntitlementStore({ clock });
  const subscriptions = createSubscriptionStore();
  const promos = createPromoStore();
  const trust = createTrustStore(clock, velocityWindowMs);
  const accruals = createAccrualStore({ clock });
  const checkpoints = createCheckpointStore();
  const movements = createMovementJournal();
  const replay = createReplayStore();
  const reservations = createReservationStore();

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
    accruals,
  };
  const participants: Participant[] = Object.values(unit);

  // The store runs one writer at a time. Overlapping `transaction` callers wait their turn
  // (FIFO) instead of hitting the journals' nest guard, which stays behind the queue as an
  // invariant. A transaction that opens another from inside `work` would wait on itself —
  // callers overlap, never nest.
  let tail: Promise<unknown> = Promise.resolve();

  return {
    ...unit,
    checkpoints,
    movements,
    replay,
    reservations,
    tableSizes: tableSizesOf(unit, movements),
    transaction: (work) => {
      const run = tail.then(async () => {
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
      });
      // The queue survives a failing transaction. The caller still sees its rejection.
      tail = run.catch(() => {});
      return run;
    },
    // The batch shares one transaction, with one journal savepoint per item. A failing item
    // rolls back to its own mark, and the rest still commit together (see Store.batchTransaction).
    batchTransaction: <T>(
      works: ReadonlyArray<(u: Unit) => Promise<T>>,
    ): Promise<Array<BatchSlot<T>>> => {
      const run = tail.then(() => runMemoryBatch(participants, unit, works));
      tail = run.catch(() => {});
      return run;
    },
    close: async () => {},
  };
}

// This is the batchTransaction body, run on the store's single-writer queue. Every journal opens
// once. Each work item runs against a fresh set of journal marks (its savepoint), and a failing
// item reverses only the writes past its own marks.
async function runMemoryBatch<T>(
  participants: Participant[],
  unit: Unit,
  works: ReadonlyArray<(u: Unit) => Promise<T>>,
): Promise<Array<BatchSlot<T>>> {
  let begun = 0;
  try {
    for (const participant of participants) {
      participant.journal.begin();
      begun += 1;
    }
    const slots: Array<BatchSlot<T>> = [];
    for (const work of works) {
      const marks = participants.map((p) => p.journal.mark());
      try {
        slots.push({ ok: true, value: await work(unit) });
      } catch (error) {
        for (let i = participants.length - 1; i >= 0; i -= 1) {
          participants[i]!.journal.rollbackTo(marks[i]!);
        }
        slots.push({ ok: false, error });
      }
    }
    for (const participant of participants) {
      participant.journal.commit();
    }
    return slots;
  } catch (error) {
    rollbackAll(participants, begun);
    throw error;
  }
}

// Rolls back only the stores that started this transaction — the first `begun` of them, newest
// first. A leftover open transaction could corrupt the next one, so one failing rollback must not
// stop the rest.
function rollbackAll(participants: Participant[], begun: number): void {
  for (let i = begun - 1; i >= 0; i -= 1) {
    try {
      participants[i]!.journal.rollback();
    } catch {
      // Rollback is best effort. Ignore this one's failure and keep rolling back the others.
    }
  }
}
