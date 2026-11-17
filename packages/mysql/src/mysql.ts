/**
 * @pwngh/economy-mysql
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { toAmount } from '@pwngh/economy-lab';
import { currency } from '@pwngh/economy-lab';
import {
  baseOf,
  isDebitNormal,
  walletKindOf,
} from '@pwngh/economy-lab/store-kit';
import { byCodeUnit } from '@pwngh/economy-lab/store-kit';
import { collapseEntitlementGrants } from '@pwngh/economy-lab/store-kit';
import { GENESIS_HEX } from '@pwngh/economy-lab/store-kit';
import { ERROR_CODES, fault } from '@pwngh/economy-lab';
import { systemClock } from '@pwngh/economy-lab/adapters';
import {
  callProcedure,
  callFunction,
  postEntryArgs,
} from '@pwngh/economy-lab/sql-kit';

import type { PostEntryArgs } from '@pwngh/economy-lab/sql-kit';
import {
  defaultDigest,
  DEFAULT_CONNECT_TIMEOUT_MS,
  CHAIN_FORK_INDEX,
  CHAIN_CONTINUITY_MARKER,
  readMinor,
  distinctAccounts,
  chainLinksFor,
  naturalDelta,
  parseJson,
  rowToSaga,
  rowToSubscription,
  rowToCheckpoint,
  rowToOutbox,
  rowToInbox,
  rowToPromoGrant,
  sortByAccountId,
  withTransientRetry,
  retryTelemetry,
  installMoneyRetrying,
  ENGINE_METRICS,
  isSeededSystemAccount,
  KnownAccounts,
  StagedAccounts,
  TxHeads,
  advanceCapturedHeads,
  endOwnedPool,
  rowToAccrual,
  rowToSale,
  encodeLegs,
  decodeLegs,
  encodeOperation,
} from '@pwngh/economy-lab/sql-kit';
import {
  metaString,
  metaNumber,
  holdReleaseLotFields,
} from '@pwngh/economy-lab/store-kit';
import {
  assertMoneyConformant,
  assertSchemaCurrent,
  unreachableDatabase,
} from '@pwngh/economy-lab/sql-kit';
import { installMysql, proveMysql } from '@pwngh/economy-lab/sql-kit';
import { vectors as moneyVectors } from '@pwngh/economy-lab/sql-kit';

import type {
  EngineOpenShape,
  Link,
  SqlRunner,
} from '@pwngh/economy-lab/sql-kit';

import type { Amount, Currency } from '@pwngh/economy-lab';
import type { AccountRef } from '@pwngh/economy-lab';
import type { Transaction } from '@pwngh/economy-lab';
import type {
  AccrualRow,
  AccrualRowKey,
  AccrualStore,
  Attempt,
  BatchSlot,
  CheckpointStore,
  Clock,
  Digest,
  EntitlementStore,
  IdempotencyStore,
  InboxMessage,
  InboxStore,
  Leg,
  LinkPage,
  Logger,
  MovementJournal,
  ReservationStore,
  ArchivedPosting,
  Ledger,
  Lot,
  Meter,
  OutboxStore,
  Posting,
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
  TableSizes,
  TimelineOptions,
  TrustStore,
  Unit,
  Velocity,
} from '@pwngh/economy-lab/ports';

// --- mysql2/promise driver shape, declared by hand --------------------------------

// This declares only the methods this file calls, so no driver's types are imported and either
// driver behind the seam satisfies it. `query`'s first tuple slot holds rows for a SELECT or an
// `affectedRows` summary for a write. Callers cast.
type Row = Record<string, unknown>;
interface ResultHeader {
  affectedRows?: number;
}
interface MysqlExecutor {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<[unknown, unknown]>;
}
export interface MysqlConnection extends MysqlExecutor {
  release(): void;
  /**
   * The stable identity of the physical connection under a per-borrow wrapper. Both drivers hand
   * out a fresh wrapper each time, so the one-time session setup keys on this instead. A pool
   * that omits it re-runs an idempotent SET on every borrow.
   */
  connection?: object;
}
/**
 * The pool seam the store rides, structurally matching `mysql2/promise`'s pool. Any pool with
 * these members satisfies it: the pool {@link createMysqlPool} builds, or the pipelining
 * `mariadb` pool from `@pwngh/economy-mysql/mariadb`, which {@link mysqlStore} rides unchanged.
 * `query` resolves a tuple whose first slot holds rows for a SELECT or an affected-rows header
 * for a write.
 */
export interface MysqlPool extends MysqlExecutor {
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

interface ExecDeps {
  exec: MysqlExecutor;
  digest: Digest;
  clock: Clock;
  // The store's pool, for statements that must commit outside `exec`'s transaction. In the
  // non-transactional unit, `exec` is the pool itself.
  pool: MysqlPool;
  // Store-wide cache of accounts whose rows exist as committed data. It lets the hot path skip
  // first-use probes and plants (see KnownAccounts in sql-shared).
  known: KnownAccounts;
  // Where this transaction's plants wait for commit-promotion into `known`. It is absent on the
  // non-transactional pool unit, whose plants simply stay uncached until a later probe sees them.
  staged?: StagedAccounts;
  // Chain heads captured at lock time (the locking FOR UPDATE returns them in the same
  // statement) and advanced by this transaction's own appends. Absent outside a transaction.
  heads?: TxHeads;
}

// bigNumberStrings stringifies every numeric column — even SELECT 1 — so every raw-row read
// converts explicitly.
async function rows(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<Row[]> {
  const [result] = await exec.query(sql, params);
  return result as Row[];
}

// Run an INSERT/UPDATE/DELETE and return affectedRows. MySQL has no RETURNING, so this count
// is the only signal of whether a conditional UPDATE matched. A WHERE matching nothing reports 0.
async function execWrite(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<number> {
  const [header] = await exec.query(sql, params);
  return (header as ResultHeader).affectedRows ?? 0;
}

// Takes a MySQL named lock and throws if it is not granted. GET_LOCK returns 1 (acquired), 0 (the
// wait elapsed), or NULL (error or killed). Unlike Postgres' blocking `for update`, a non-acquire
// must be surfaced. It is thrown as errno 1205 (the InnoDB lock-wait code) so isTransientConflict
// classifies it and withTransientRetry re-runs it in a fresh transaction.
async function takeGetLock(exec: MysqlExecutor, name: string): Promise<void> {
  // The 10s wait is comfortably past any healthy transaction and well under innodb_lock_wait_timeout's 50s.
  const result = await rows(exec, 'SELECT GET_LOCK(?, 10) AS acquired', [name]);
  if (Number(result[0]?.acquired) !== 1) {
    throw Object.assign(new Error(`GET_LOCK did not acquire: ${name}`), {
      errno: 1205,
    });
  }
}

// --- The ledger store -------------------------------------------------------------

async function isKnownAccount(
  exec: MysqlExecutor,
  account: AccountRef,
): Promise<boolean> {
  if (walletKindOf(account) !== null) {
    return true;
  }
  if (isSeededSystemAccount(account)) {
    return true;
  }
  const found = await rows(
    exec,
    'SELECT 1 FROM accounts WHERE id = ? LIMIT 1',
    [account],
  );
  return found.length > 0;
}

// Reads each account's chain head from `account_balances.head_hash`, the pointer post_entry
// advances in the same transaction that writes chain_links. A missing row means genesis.
// chain_links stays the source of truth (prove() re-walks it), so a drifted pointer surfaces there.
//
// FOR UPDATE makes this a locking read of the latest committed head at any isolation level. A
// stale head would fork the chain on chain_links_account_prev_uq (errno 1062) and cost a retry.
// lockAccounts already holds these rows, so the lock is free here.
async function headsForAccounts(
  deps: ExecDeps,
  accounts: ReadonlyArray<AccountRef>,
): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  if (accounts.length === 0) {
    return heads;
  }
  // Full coverage from the lock-time capture skips the query. The locks held since capture
  // guarantee the heads are exact. Partial coverage (an unlocked append, e.g. conformance
  // driving the ledger directly) falls through to the query and does not populate the capture.
  // An unlocked head can move under us, and the chain-fork index plus retry covers that.
  const captured = deps.heads;
  if (captured !== undefined && accounts.every((a) => captured.has(a))) {
    for (const account of accounts) {
      heads.set(account, captured.get(account)!);
    }
    return heads;
  }
  const marks = accounts.map(() => '?').join(', ');
  const found = await rows(
    deps.exec,
    `SELECT account_id, head_hash FROM account_balances
      WHERE account_id IN (${marks})
      ORDER BY account_id
        FOR UPDATE`,
    accounts,
  );
  for (const row of found) {
    heads.set(row.account_id as string, row.head_hash as string);
  }
  return heads;
}

async function advanceChain(
  deps: ExecDeps,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  const heads = await headsForAccounts(deps, distinctAccounts(posting.legs));
  return chainLinksFor(deps.digest, posting, heads);
}

// This is the fused pair-posting write: one head read over the union and one post_entries CALL
// for the whole set. Heads thread forward app-side, so a later posting chains onto an earlier
// one's new head exactly as sequential appends would. The union head read takes the same sorted
// FOR UPDATE locks a sequential pair would, just once.
async function appendPostings(
  deps: ExecDeps,
  postings: ReadonlyArray<Posting>,
): Promise<Transaction[]> {
  const postedAt = deps.clock.now();
  const heads = await headsForAccounts(
    deps,
    distinctAccounts(postings.flatMap((posting) => posting.legs)),
  );
  const transactions: Transaction[] = [];
  const entries: Array<Record<string, unknown>> = [];
  for (const posting of postings) {
    const links = await chainLinksFor(deps.digest, posting, heads);
    for (const link of links) {
      heads.set(link.account, link.hash);
    }
    const args = postEntryArgs(posting, links);
    screenNewAccounts(deps, posting, args);
    entries.push({
      txn: posting.txnId,
      postedAt,
      meta: posting.meta,
      legs: args.legs,
      links: args.links,
      balances: args.balances,
      newAccounts: args.newAccounts,
    });
    transactions.push({
      id: posting.txnId,
      postedAt,
      legs: posting.legs,
      links,
      meta: posting.meta,
    });
  }
  await callProcedure(mysqlQuery(deps.exec), 'mysql', 'post_entries', [
    JSON.stringify(entries),
  ]);
  advanceCapturedHeads(deps.heads, transactions);
  return transactions;
}

// postEntryArgs collects only user accounts. A platform shard (`platform:revenue#3`) is also
// created on first use — the schema seeds just the bare ids — so add each one with kind `system`.
// Then drop every account the known-set can vouch for and stage the rest for commit-promotion.
// Steady-state the proc receives an empty list and its first-use INSERT IGNORE scans nothing.
// post_entry's balance fold creates the account_balances row for every account it touches, so a
// committed posting is complete evidence for both rows.
function screenNewAccounts(
  deps: ExecDeps,
  posting: Posting,
  args: PostEntryArgs,
): void {
  for (const account of distinctAccounts(posting.legs)) {
    if (baseOf(account) !== account && isSeededSystemAccount(account)) {
      args.newAccounts.push({
        id: account,
        kind: 'system',
        currency: currency(account),
      });
    }
  }
  args.newAccounts = args.newAccounts.filter((row) => !deps.known.has(row.id));
  for (const row of args.newAccounts) {
    deps.staged?.add(row.id);
  }
}

// Legs are stored one row per leg (lineageOf re-derives the hash from the full leg set). Chain
// links are stored once per distinct account, not per leg. The fork index lets a given prev-hash
// be extended only once, so a second leg to the same account must not read as a second extension.
async function insertPosting(
  deps: ExecDeps,
  posting: Posting,
): Promise<Transaction> {
  const postedAt = deps.clock.now();
  const links = await advanceChain(deps, posting);

  // The JSON arrays carry the bigint amounts as strings to keep values past 2^53.
  const args = postEntryArgs(posting, links);
  screenNewAccounts(deps, posting, args);
  await callProcedure(mysqlQuery(deps.exec), 'mysql', 'post_entry', [
    posting.txnId,
    postedAt,
    JSON.stringify(posting.meta),
    JSON.stringify(args.legs),
    JSON.stringify(args.links),
    JSON.stringify(args.balances),
    JSON.stringify(args.newAccounts),
  ]);
  const transaction = {
    id: posting.txnId,
    postedAt,
    legs: posting.legs,
    links,
    meta: posting.meta,
  };
  advanceCapturedHeads(deps.heads, [transaction]);
  return transaction;
}

async function archivePageOf(
  exec: MysqlExecutor,
  cursor: number | null,
  limit: number,
): Promise<{ postings: ArchivedPosting[]; cursor: number | null }> {
  const page = await rows(
    exec,
    `SELECT id, seq, posted_at, meta FROM postings
      WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    [cursor ?? 0, limit],
  );
  if (page.length === 0) {
    return { postings: [], cursor: null };
  }
  const ids = page.map((row) => row.id as string);
  const marks = ids.map(() => '?').join(', ');
  const legs = await rows(
    exec,
    `SELECT posting_id, account_id, currency, amount FROM legs
      WHERE posting_id IN (${marks}) ORDER BY id`,
    ids,
  );
  const links = await rows(
    exec,
    `SELECT posting_id, account_id, prev_hash, hash FROM chain_links
      WHERE posting_id IN (${marks})`,
    ids,
  );
  const legsBy = new Map<string, Leg[]>();
  for (const row of legs) {
    const list = legsBy.get(row.posting_id as string) ?? [];
    list.push({
      account: row.account_id as AccountRef,
      amount: toAmount(row.currency as Currency, readMinor(row.amount)),
    });
    legsBy.set(row.posting_id as string, list);
  }
  const linksBy = new Map<
    string,
    Array<{ account: AccountRef; prevHash: string; hash: string }>
  >();
  for (const row of links) {
    const list = linksBy.get(row.posting_id as string) ?? [];
    list.push({
      account: row.account_id as AccountRef,
      prevHash: row.prev_hash as string,
      hash: row.hash as string,
    });
    linksBy.set(row.posting_id as string, list);
  }
  const size = await rows(
    exec,
    'SELECT COALESCE(MAX(seq), 0) AS size FROM postings',
  );
  const newest = Number(size[0]!.size);
  const last = page[page.length - 1]!;
  return {
    postings: page.map((row) => ({
      txnId: row.id as string,
      seq: Number(row.seq),
      postedAt: Number(row.posted_at),
      meta: parseJson(row.meta) as Record<string, unknown>,
      legs: legsBy.get(row.id as string) ?? [],
      links: linksBy.get(row.id as string) ?? [],
    })),
    cursor: Number(last.seq) >= newest ? null : Number(last.seq),
  };
}

function mysqlQuery(exec: MysqlExecutor) {
  return async (sql: string, params: ReadonlyArray<unknown>) => ({
    rows: (await rows(exec, sql, params)) as ReadonlyArray<
      Record<string, unknown>
    >,
  });
}

// NOTE: first-time account rows are created inside the `post_entry` procedure (db/mysql-schema.sql).
// MySQL's `lock` is a named lock, not a row lock, so no account row is needed up front the way
// the Postgres engine's row lock needs one.

// NOTE: the per-account balance fold (UPDATE before INSERT, so the non-negative CHECK tests the
// new total) lives inside the `post_entry` procedure. The application decides each delta via
// `balanceDelta` (postEntryArgs), and the procedure only persists it.

function rowKind(account: AccountRef): string {
  if (account.startsWith('platform:')) {
    return 'system';
  }
  return account.slice(account.lastIndexOf(':') + 1);
}

// lockMany's body creates any missing balance rows first, then locks the whole set in one ordered
// FOR UPDATE. A row has to exist before it can be locked, so first-use accounts get a placeholder
// row here. Everything runs on the transaction's own connection. The money transaction is READ
// COMMITTED, which takes no gap lock on a missing key, so inline planting cannot deadlock the way
// REPEATABLE READ would (bursts of neighboring first-use inserts colliding through one shared
// gap). Planting through a separate pool connection is ruled out: with every in-flight transaction
// already holding its own connection, a full pool would leave each one waiting for a second
// connection that could never free. A transaction uses exactly one connection for its whole life.
//
// A plant rolls back with its operation. The next attempt simply replants. A committed placeholder
// is the same one the schema seeds for system accounts — zero balance, genesis head — which every
// reader treats like no row at all.
async function plantAndLock(
  deps: ExecDeps,
  accounts: ReadonlyArray<AccountRef>,
): Promise<void> {
  if (accounts.length === 0) {
    return;
  }
  // The probe covers only accounts the known-set can't vouch for. Steady-state that is nobody
  // and the whole call is the single FOR UPDATE below. Inside a transaction a probe hit can be
  // this transaction's own uncommitted plant, so hits stage for commit-promotion like plants.
  // On the pool unit they enter the known-set directly.
  const unknown = accounts.filter((account) => !deps.known.has(account));
  if (unknown.length > 0) {
    const found = await rows(
      deps.exec,
      `SELECT account_id FROM account_balances
        WHERE account_id IN (${unknown.map(() => '?').join(', ')})`,
      [...unknown],
    );
    const have = new Set(found.map((row) => row.account_id as string));
    for (const account of have) {
      (deps.staged ?? deps.known).add(account);
    }
    // The list is sorted so concurrent plants insert in the same order and can't deadlock each other.
    const missing = unknown
      .filter((account) => !have.has(account))
      .sort(byCodeUnit);
    if (missing.length > 0) {
      // This is INSERT IGNORE, so losing a plant race is fine. The row is there either way.
      await execWrite(
        deps.exec,
        `INSERT IGNORE INTO accounts (id, kind, currency)
          VALUES ${missing.map(() => '(?, ?, ?)').join(', ')}`,
        missing.flatMap((a) => [a, rowKind(a), currency(a)]),
      );
      await execWrite(
        deps.exec,
        `INSERT IGNORE INTO account_balances (account_id, currency, balance, head_hash)
          VALUES ${missing.map(() => `(?, ?, 0, REPEAT('0', 64))`).join(', ')}`,
        missing.flatMap((a) => [a, currency(a)]),
      );
      for (const account of missing) {
        deps.staged?.add(account);
      }
    }
  }
  // Every row exists now, so this takes plain record locks, in account_id order. The statement
  // returns each row's head in the same round trip, feeding the transaction's head capture. A
  // head read under a lock held to commit stays exact.
  const locked = await rows(
    deps.exec,
    `SELECT account_id, head_hash FROM account_balances
      WHERE account_id IN (${accounts.map(() => '?').join(', ')})
      ORDER BY account_id
        FOR UPDATE`,
    [...accounts],
  );
  if (deps.heads !== undefined) {
    const found = new Map(
      locked.map((row) => [row.account_id as string, row.head_hash as string]),
    );
    for (const account of accounts) {
      deps.heads.set(account, found.get(account) ?? GENESIS_HEX);
    }
  }
}

// The tip of every account's chain, as the JOIN fragment both head reads share. MySQL has no
// DISTINCT ON, so this MAX(seq)-per-account subquery + join is the portable equivalent.
const CHAIN_TIP_JOIN_SQL = `JOIN (
         SELECT c2.account_id AS account_id, MAX(p2.seq) AS max_seq
           FROM chain_links c2
           JOIN postings p2 ON p2.id = c2.posting_id
          GROUP BY c2.account_id
       ) tip ON tip.account_id = c.account_id AND tip.max_seq = p.seq`;

function createLedgerStore(deps: ExecDeps): Ledger {
  return {
    hasAccount: async (account) => isKnownAccount(deps.exec, account),

    // Named lock per account. The same connection can re-take it without blocking on itself, so
    // locking one account twice is safe. transaction() releases all named locks on the way out.
    lock: (account) => takeGetLock(deps.exec, lockName(account)),

    // The batched twin of `lock`. It row-locks every touched balance row in one ordered
    // statement, so InnoDB acquires them in one global order (GET_LOCK above does not pin rows).
    lockMany: (accounts) => plantAndLock(deps, accounts),

    append: async (posting) => insertPosting(deps, posting),

    appendAll: async (postings) => appendPostings(deps, postings),

    balance: async (account) => {
      const raw = await callFunction(
        mysqlQuery(deps.exec),
        'mysql',
        'account_balance',
        [account],
      );
      return toAmount(currency(account), readMinor(raw));
    },

    statement: async (account, range) =>
      buildStatement(deps.exec, account, range),

    derivedBalances: async (account) => derivedBalancesOf(deps.exec, account),

    timeline: (account, options) => timelineOf(deps.exec, account, options),

    heads: async function* () {
      const result = await rows(
        deps.exec,
        `SELECT c.account_id, c.hash FROM chain_links c
           JOIN postings p ON p.id = c.posting_id
           ${CHAIN_TIP_JOIN_SQL}`,
      );
      sortByAccountId(result);
      for (const row of result) {
        yield [row.account_id as AccountRef, row.hash as string] as const;
      }
    },

    headSums: () => headSumsOf(deps.exec),

    balanceAccounts: async function* () {
      // The seeded placeholder (genesis head, zero balance) reads like no row and is excluded.
      // `OR balance <> 0` catches the drift this scan hunts: a placeholder that gained a
      // balance.
      const result = await rows(
        deps.exec,
        `SELECT account_id FROM account_balances WHERE head_hash <> REPEAT('0', 64) OR balance <> 0`,
      );
      sortByAccountId(result);
      for (const row of result) {
        yield row.account_id as AccountRef;
      }
    },

    lineage: (account, options) =>
      lineageOf(deps.exec, account, options?.sinceHash),

    posting: (txnId) => postingOf(deps.exec, txnId),

    links: async (txnId) => {
      const result = await rows(
        deps.exec,
        'SELECT account_id, prev_hash, hash FROM chain_links WHERE posting_id = ?',
        [txnId],
      );
      return result.map((row) => ({
        account: row.account_id as AccountRef,
        prevHash: row.prev_hash as string,
        hash: row.hash as string,
      }));
    },

    linksPage: (cursor, limit) => linksPageOf(deps.exec, cursor, limit),

    historySize: async () => {
      const found = await rows(
        deps.exec,
        'SELECT COALESCE(MAX(seq), 0) AS size FROM postings',
      );
      return Number(found[0]!.size);
    },

    // The mover's page read returns whole postings in commit order with legs and links, grouped
    // in process from three keyed queries. Legs come back in insert order (their auto-increment
    // id), the same order the chain preimage hashed them in.
    archivePage: async (cursor, limit) =>
      archivePageOf(deps.exec, cursor, limit),

    prune: (txnIds) => pruneWholePostings(deps.exec, txnIds),

    list: () => listPostingsOf(deps.exec),
  };
}

// The mover's delete half. Children go first (both reference postings), and it deletes whole
// postings only.
async function pruneWholePostings(
  exec: MysqlExecutor,
  txnIds: ReadonlyArray<string>,
): Promise<void> {
  if (txnIds.length === 0) {
    return;
  }
  const marks = txnIds.map(() => '?').join(', ');
  await rows(exec, `DELETE FROM chain_links WHERE posting_id IN (${marks})`, [
    ...txnIds,
  ]);
  await rows(exec, `DELETE FROM legs WHERE posting_id IN (${marks})`, [
    ...txnIds,
  ]);
  await rows(exec, `DELETE FROM postings WHERE id IN (${marks})`, [...txnIds]);
}

// Pages by postings.seq (the commit order), whole postings at a time, so a posting's links never
// split across pages. A null cursor from here means the newest stored posting was consumed.
async function linksPageOf(
  exec: MysqlExecutor,
  cursor: number | null,
  limit: number,
): Promise<LinkPage> {
  const page = await rows(
    exec,
    `SELECT id, seq, meta FROM postings WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    [cursor ?? -1, limit],
  );
  if (page.length === 0) {
    return { links: [], cursor: null };
  }
  const legsByTxn = await legsByPosting(
    exec,
    page.map((row) => row.id as string),
  );
  const linkRows = await rows(
    exec,
    `SELECT posting_id, account_id, prev_hash, hash FROM chain_links
      WHERE posting_id IN (${page.map(() => '?').join(', ')})`,
    page.map((row) => row.id as string),
  );
  const metaByTxn = new Map(
    page.map((row) => [row.id as string, parseMeta(row.meta)]),
  );
  const links = linkRows.map((row) => ({
    account: row.account_id as AccountRef,
    txnId: row.posting_id as string,
    legs: legsByTxn.get(row.posting_id as string) ?? [],
    meta: metaByTxn.get(row.posting_id as string) ?? {},
    prevHash: row.prev_hash as string,
    hash: row.hash as string,
  }));
  return {
    links,
    cursor: page.length < limit ? null : Number(page[page.length - 1]!.seq),
  };
}

// MySQL caps lock names at 64 bytes, so a longer id becomes a fixed-length prefix plus the id's
// full length. The appended length keeps two ids that share a prefix from colliding on one lock.
// 56 leaves headroom under the cap for multi-byte ids.
function lockName(account: AccountRef): string {
  return account.length <= 56
    ? account
    : `${account.slice(0, 48)}#${account.length}`;
}

// Builds a statement for an account over a time range (start inclusive, end exclusive). Each entry's
// amount is the effect on this account's balance, so money into a user account reads positive.
// Conformance fixtures fit one page, so there is no next-page cursor.
//
// `posted_at` selects the rows and `seq` orders them. They are not the same order: posted_at comes
// from the injected Clock and nothing makes it rise, so a stepped-back clock writes a later posting
// with an earlier posted_at. Ordering by it returned the statement permuted against commit order,
// which the Ledger.statement contract fixes. `l.id` then orders the legs a posting puts on one
// account.
async function buildStatement(
  exec: MysqlExecutor,
  account: AccountRef,
  range: Range,
): Promise<Statement> {
  const result = await rows(
    exec,
    `SELECT p.id AS txn_id, l.account_id AS account_id, l.currency AS currency,
            l.amount AS amount, p.posted_at AS posted_at
       FROM legs l JOIN postings p ON l.posting_id = p.id
      WHERE l.account_id = ? AND p.posted_at >= ? AND p.posted_at < ?
      ORDER BY p.seq, l.id`,
    [account, range.from, range.to],
  );
  const entries = result.map((row) => ({
    txnId: row.txn_id as string,
    amount: naturalDelta(account, row),
    postedAt: Number(row.posted_at),
  }));
  return { account, entries, cursor: null };
}

// This joins the heads query with per-account raw leg sums in ONE statement on purpose. A posting
// writes its chain link and its legs in one transaction, and a single statement reads one
// consistent snapshot, so a head can never be paired with a sum it didn't commit with. Raw means
// as posted (debit positive). SUM over BIGINT returns DECIMAL as a string, and readMinor turns it
// back into a bigint.
async function* headSumsOf(
  exec: MysqlExecutor,
): AsyncIterable<readonly [AccountRef, string, bigint]> {
  const result = await rows(
    exec,
    `SELECT c.account_id, c.hash, s.raw FROM chain_links c
       JOIN postings p ON p.id = c.posting_id
       ${CHAIN_TIP_JOIN_SQL}
       JOIN (
         SELECT account_id, SUM(amount) AS raw FROM legs GROUP BY account_id
       ) s ON s.account_id = c.account_id`,
  );
  sortByAccountId(result);
  for (const row of result) {
    yield [
      row.account_id as AccountRef,
      row.hash as string,
      readMinor(row.raw),
    ] as const;
  }
}

// Server-side fold, one amount per currency. SUM over BIGINT returns DECIMAL as a string, and
// readMinor turns it back into a bigint. `naturalDelta` applies the account's sign rule to the
// summed figure — the sum of signed deltas equals the delta of the sum.
async function derivedBalancesOf(
  exec: MysqlExecutor,
  account: AccountRef,
): Promise<Amount[]> {
  const result = await rows(
    exec,
    `SELECT currency, SUM(amount) AS minor FROM legs
      WHERE account_id = ? GROUP BY currency ORDER BY currency`,
    [account],
  );
  return result.map((row) =>
    naturalDelta(account, { currency: row.currency, amount: row.minor }),
  );
}

// Streams an account's incoming funds as dated lots for the maturity logic. Absent meta falls back
// to a mature-now "unknown" source. The stream orders by `l.id`, not `p.seq`: `legs(account_id, id)`
// serves the bounded scan directly, and the two share commit order for one account. The lot filter
// (a balance-raising leg, per the account's sign rule) must stay in the SQL. Filtering in code reads
// every spend leg just to drop it, and the maturity check on a busy account goes O(history).
// @see https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/
async function* timelineOf(
  exec: MysqlExecutor,
  account: AccountRef,
  options?: TimelineOptions,
): AsyncIterable<Lot> {
  const direction = options?.order === 'desc' ? 'DESC' : 'ASC';
  const lotOffset = options?.offset ?? 0;
  const lotLimit = options?.limit ?? Infinity;
  const pageSize = Number.isFinite(lotLimit) ? Math.max(lotLimit, 1) : 256;

  let cursor: unknown = null;
  let yielded = 0;
  while (yielded < lotLimit) {
    const result = await lotPage(exec, account, {
      direction,
      pageSize,
      offset: lotOffset,
      cursor,
    });
    if (result.length === 0) {
      return;
    }
    for (const row of result) {
      cursor = row.leg_id;
      const delta = naturalDelta(account, row);
      // This is unreachable under the SQL sign filter. Skip rather than trust a drifted schema.
      if (delta.minor <= 0n) {
        continue;
      }
      yielded += 1;
      const meta = parseMeta(row.meta);
      yield {
        txnId: row.txn_id as string,
        amount: delta,
        source: metaString(meta, 'source', 'unknown'),
        toppedUpAt: Number(row.posted_at),
        maturesAt: metaNumber(meta, 'maturesAt', Number(row.posted_at)),
        ...holdReleaseLotFields(account, meta),
      };
      if (yielded >= lotLimit) {
        return;
      }
    }
    if (result.length < pageSize) {
      return;
    }
  }
}

// One page of an account's lots. The first page honors the caller's lot offset. Later pages
// continue from the keyset (last l.id) instead, never re-scanning rows via OFFSET.
async function lotPage(
  exec: MysqlExecutor,
  account: AccountRef,
  page: {
    direction: 'ASC' | 'DESC';
    pageSize: number;
    offset: number;
    cursor: unknown;
  },
): Promise<Record<string, unknown>[]> {
  const lotSign = isDebitNormal(account) ? '>' : '<';
  const after = page.direction === 'DESC' ? '<' : '>';
  return page.cursor === null
    ? rows(
        exec,
        `SELECT l.id AS leg_id, p.id AS txn_id, p.meta AS meta, l.currency AS currency,
                l.amount AS amount, p.posted_at AS posted_at
           FROM legs l JOIN postings p ON l.posting_id = p.id
          WHERE l.account_id = ? AND l.amount ${lotSign} 0
          ORDER BY l.id ${page.direction}
          LIMIT ? OFFSET ?`,
        [account, page.pageSize, page.offset],
      )
    : rows(
        exec,
        `SELECT l.id AS leg_id, p.id AS txn_id, p.meta AS meta, l.currency AS currency,
                l.amount AS amount, p.posted_at AS posted_at
           FROM legs l JOIN postings p ON l.posting_id = p.id
          WHERE l.account_id = ? AND l.amount ${lotSign} 0 AND l.id ${after} ?
          ORDER BY l.id ${page.direction}
          LIMIT ?`,
        [account, page.cursor, page.pageSize],
      );
}

// Streams the account's chain links in commit order, legs and metadata as written, for the
// verifier to re-hash. With `sinceHash`, it streams only links past the one carrying that head.
// The subquery resolves its seq, and `seq > NULL` matches nothing, so an unknown hash streams
// nothing (see Ledger.lineage).
async function* lineageOf(
  exec: MysqlExecutor,
  account: AccountRef,
  sinceHash?: string,
): AsyncIterable<StoredLink> {
  const postings =
    sinceHash === undefined
      ? await rows(
          exec,
          `SELECT c.posting_id AS txn_id, p.meta AS meta,
                  c.prev_hash AS prev_hash, c.hash AS hash
             FROM chain_links c JOIN postings p ON p.id = c.posting_id
            WHERE c.account_id = ?
            ORDER BY p.seq ASC`,
          [account],
        )
      : await rows(
          exec,
          `SELECT c.posting_id AS txn_id, p.meta AS meta,
                  c.prev_hash AS prev_hash, c.hash AS hash
             FROM chain_links c JOIN postings p ON p.id = c.posting_id
            WHERE c.account_id = ?
              AND p.seq > (SELECT p2.seq FROM chain_links c2
                             JOIN postings p2 ON p2.id = c2.posting_id
                            WHERE c2.account_id = ? AND c2.hash = ?)
            ORDER BY p.seq ASC`,
          [account, account, sinceHash],
        );
  // chainPreimage filters legs itself, so this loads the whole posting's legs, not just this account's.
  const legsByTxn = await legsByPosting(
    exec,
    postings.map((posting) => posting.txn_id as string),
  );
  for (const posting of postings) {
    const txnId = posting.txn_id as string;
    yield {
      txnId,
      legs: legsByTxn.get(txnId) ?? [],
      meta: parseMeta(posting.meta),
      prevHash: posting.prev_hash as string,
      hash: posting.hash as string,
    };
  }
}

// This loads all legs of the posting, not just the verified account's. The hash recompute
// selects its own.
async function legsOf(
  exec: MysqlExecutor,
  txnId: string,
): Promise<ReadonlyArray<Leg>> {
  const result = await rows(
    exec,
    'SELECT account_id, currency, amount FROM legs WHERE posting_id = ? ORDER BY id',
    [txnId],
  );
  return result.map((row) => ({
    account: row.account_id as AccountRef,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  }));
}

// The batched twin of legsOf, with the same ordering and rebuild. The batched and per-posting
// paths must return byte-identical legs so the recomputed chain hashes are unchanged.
async function legsByPosting(
  exec: MysqlExecutor,
  postingIds: ReadonlyArray<string>,
): Promise<Map<string, Leg[]>> {
  const byPosting = new Map<string, Leg[]>();
  if (postingIds.length === 0) {
    return byPosting;
  }
  const marks = postingIds.map(() => '?').join(', ');
  const result = await rows(
    exec,
    `SELECT posting_id, account_id, currency, amount FROM legs
      WHERE posting_id IN (${marks}) ORDER BY posting_id, id`,
    [...postingIds],
  );
  for (const row of result) {
    const txnId = row.posting_id as string;
    let legs = byPosting.get(txnId);
    if (!legs) {
      legs = [];
      byPosting.set(txnId, legs);
    }
    legs.push({
      account: row.account_id as AccountRef,
      amount: toAmount(
        row.currency as Amount['currency'],
        readMinor(row.amount),
      ),
    });
  }
  return byPosting;
}

// One whole posting with all its legs. `reverse` reads this to post the exact opposite entry.
// It returns null when no posting has that id.
async function postingOf(
  exec: MysqlExecutor,
  txnId: string,
): Promise<Posting | null> {
  const found = await rows(
    exec,
    'SELECT meta FROM postings WHERE id = ? LIMIT 1',
    [txnId],
  );
  if (!found.length) {
    return null;
  }
  const legs = await legsOf(exec, txnId);
  return { txnId, legs, meta: parseMeta(found[0]!.meta) };
}

// Lists newest commit first. `seq` is AUTO_INCREMENT UNIQUE, a total order with no tie to break.
async function* listPostingsOf(exec: MysqlExecutor): AsyncIterable<Posting> {
  const postings = await rows(
    exec,
    'SELECT id, meta FROM postings ORDER BY seq DESC',
  );
  // list() consumers buffer the whole stream, so the eager batched legs read changes nothing.
  const legsByTxn = await legsByPosting(
    exec,
    postings.map((row) => row.id as string),
  );
  for (const row of postings) {
    const txnId = row.id as string;
    yield {
      txnId,
      legs: legsByTxn.get(txnId) ?? [],
      meta: parseMeta(row.meta),
    };
  }
}

// --- Idempotency store ------------------------------------------------------------

// `claim` inserts a placeholder row. A later same-key caller blocks on it until the holder
// commits (replay the saved result) or rolls back (the key is freed for a real retry).
//
// The claim is a single atomic `INSERT IGNORE`, not `SELECT ... FOR UPDATE` then `INSERT`.
// Probing a not-yet-present key with FOR UPDATE takes a gap lock, and two claims whose keys share
// a gap deadlock on each other's insert. That is the dominant InnoDB deadlock shape here, since
// every op claims a key. Insert-intention locks do not conflict with each other, so distinct keys
// never deadlock. A collision with an in-flight holder still blocks on that row's lock.
// @see https://economy-lab-docs.pages.dev/economy/concepts/idempotency/
function createIdempotencyStore(exec: MysqlExecutor): IdempotencyStore {
  return {
    claim: async (key) => {
      // affectedRows 1 means we inserted the placeholder and won the claim. 0 means the key's
      // holder committed, so replay the recorded result. An in-flight holder would have blocked
      // this INSERT IGNORE, and a rolled-back one would have freed the key.
      const inserted = await execWrite(
        exec,
        'INSERT IGNORE INTO idempotency (`key`, transaction) VALUES (?, NULL)',
        [key],
      );
      if (inserted > 0) {
        return { claimed: true };
      }
      const existing = await rows(
        exec,
        'SELECT transaction FROM idempotency WHERE `key` = ? LIMIT 1',
        [key],
      );
      const recorded = existing[0]?.transaction ?? null;
      if (recorded !== null) {
        return {
          claimed: false,
          transaction: parseTransaction(recorded),
        };
      }
      // The row exists with no recorded result: a placeholder this caller is re-claiming. Treat it
      // as ours, matching the in-memory reference.
      return { claimed: true };
    },

    record: async (key, transaction) => {
      await rows(
        exec,
        `INSERT INTO idempotency (\`key\`, transaction) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE transaction = VALUES(transaction)`,
        [key, encodeTransaction(transaction)],
      );
    },

    deleteOlderThan: async (cutoffMs, limit) =>
      execWrite(
        exec,
        `DELETE FROM idempotency
          WHERE created_at < FROM_UNIXTIME(? / 1000)
          ORDER BY created_at
          LIMIT ?`,
        [cutoffMs, limit],
      ),
  };
}

// --- Sale store -------------------------------------------------------------------

// Records each completed sale, keyed by order id. The order id is separate from the idempotency
// key above. The row stores the sale's details (including the exact ledger legs) so a later
// refund can look it up by order id and reverse precisely what was posted.
function createSaleStore(exec: MysqlExecutor): SaleStore {
  return {
    put: async (sale) => {
      await rows(
        exec,
        `INSERT INTO sales (order_id, buyer_id, recipient_id, sku, price, fee, legs, txn_id, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           buyer_id = VALUES(buyer_id), recipient_id = VALUES(recipient_id),
           sku = VALUES(sku), price = VALUES(price), fee = VALUES(fee),
           legs = VALUES(legs), txn_id = VALUES(txn_id), posted_at = VALUES(posted_at)`,
        [
          sale.orderId,
          sale.buyerId,
          sale.recipientId ?? null,
          sale.sku,
          sale.price.minor.toString(),
          sale.fee.minor.toString(),
          JSON.stringify(encodeLegs(sale.legs)),
          sale.txnId,
          sale.postedAt,
        ],
      );
    },
    get: async (orderId) => {
      const found = await rows(
        exec,
        'SELECT * FROM sales WHERE order_id = ? LIMIT 1',
        [orderId],
      );
      return found.length ? saleFromRow(found[0]!) : null;
    },
  };
}

// --- Outbox store -----------------------------------------------------------------

// `enqueue` saves the event in the same transaction as the money posting. FOR UPDATE SKIP LOCKED
// separates two claims only while both are inside transactions. The relay claims on the pool, so
// its locks are gone before it delivers and `markRelayed` is what takes a row out of the sweep.
// See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for the outbox pattern.
function createOutboxStore(deps: ExecDeps): OutboxStore {
  const exec = deps.exec;
  return {
    enqueue: async (message) => {
      await rows(
        exec,
        `INSERT INTO outbox (id, event, status, attempts, correlation_id) VALUES (?, ?, ?, ?, ?)`,
        [
          message.id,
          JSON.stringify(message.event),
          message.status,
          message.attempts,
          message.correlationId,
        ],
      );
    },
    claimBatch: async (limit) => {
      const result = await rows(
        exec,
        `SELECT id, event, status, attempts, dead_letter_reason, correlation_id FROM outbox
          WHERE status = 'pending'
          ORDER BY created_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      return result.map(rowToOutbox);
    },
    markRelayed: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      // The `AND status = 'pending'` clause stops a stale resend from flipping a dead-lettered or
      // already-relayed row back to 'relayed'.
      const placeholders = ids.map(() => '?').join(', ');
      await rows(
        exec,
        `UPDATE outbox SET status = 'relayed'
          WHERE id IN (${placeholders}) AND status = 'pending'`,
        [...ids],
      );
    },
    bumpAttempt:
      exec === deps.pool
        ? (id) => bumpAttemptOnPool(deps.pool, 'outbox', id)
        : (id) => bumpAttemptRow(exec, 'outbox', id),
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE outbox SET status = 'dead', dead_letter_reason = ? WHERE id = ? AND status = 'pending'",
        [reason, id],
      );
    },
    // Age comes from the database's own NOW(6), so an app/database clock skew never distorts it.
    stats: async () => {
      const result = await rows(
        exec,
        `SELECT COUNT(*) AS pending,
                FLOOR(TIMESTAMPDIFF(MICROSECOND, MIN(created_at), NOW(6)) / 1000) AS age_ms
           FROM outbox WHERE status = 'pending'`,
      );
      const row = result[0] as unknown as {
        pending: number | string;
        age_ms: number | string | null;
      };
      return {
        pending: Number(row.pending),
        oldestPendingAgeMs:
          row.age_ms === null ? null : Math.max(0, Number(row.age_ms)),
      };
    },
  };
}

// MySQL has no RETURNING, so the number this bump wrote comes back through LAST_INSERT_ID, which
// is per-connection: the UPDATE stows the new count in it and the SELECT reads it off the same
// connection. Re-reading the column instead would hand back whatever a concurrent bump had reached
// by then. LAST_INSERT_ID keeps its previous value when nothing matched, so a zero affectedRows
// short-circuits rather than returning a stale count.
async function bumpAttemptRow(
  exec: MysqlExecutor,
  table: 'outbox' | 'inbox',
  id: string,
): Promise<number> {
  const affected = await execWrite(
    exec,
    `UPDATE ${table} SET attempts = LAST_INSERT_ID(attempts + 1)
      WHERE id = ? AND status = 'pending'`,
    [id],
  );
  if (affected === 0) {
    return 0;
  }
  const read = await rows(exec, 'SELECT LAST_INSERT_ID() AS attempts');
  return Number(read[0]?.attempts ?? 0);
}

// On the pool the two statements must land on one connection, or the SELECT reads another
// caller's LAST_INSERT_ID. Inside a transaction `exec` is already that one connection.
async function bumpAttemptOnPool(
  pool: MysqlPool,
  table: 'outbox' | 'inbox',
  id: string,
): Promise<number> {
  const connection = await pool.getConnection();
  try {
    return await bumpAttemptRow(connection, table, id);
  } finally {
    connection.release();
  }
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox. `enqueueInbound` saves the row in the webhook ingress
// transaction and dedupes on `key` (the provider event id, UNIQUE in SQL). FOR UPDATE SKIP LOCKED
// separates two claims only while both are inside transactions. The drain claims on the pool, so
// its locks are gone before it applies and the stored Operation's idempotencyKey is what dedupes.
// See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for the inbox pattern.
function createInboxStore(deps: ExecDeps): InboxStore {
  const exec = deps.exec;
  return {
    // MySQL has no RETURNING, so the inserted/existing row is fetched in a second read (postgres hands it
    // back from the insert). encodeOperation carries the bigint amounts as decimal strings (JSON
    // can't hold BigInt).
    enqueueInbound: async (entry) => {
      await rows(
        exec,
        `INSERT IGNORE INTO inbox (id, \`key\`, operation, status, attempts, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.key,
          JSON.stringify(encodeOperation(entry.operation)),
          entry.status,
          entry.attempts,
          entry.receivedAt,
        ],
      );
      const found = await rows(
        exec,
        `SELECT id, \`key\`, operation, status, attempts, received_at, dead_letter_reason FROM inbox
          WHERE \`key\` = ?
          LIMIT 1`,
        [entry.key],
      );
      return rowToInbox(found[0]!);
    },
    // `input.now` is accepted for parity with the saga/relay claim. The inbox has no due-time gate,
    // so every pending row is immediately claimable.
    claimInbound: async (input) => {
      const result = await rows(
        exec,
        `SELECT id, \`key\`, operation, status, attempts, received_at, dead_letter_reason FROM inbox
          WHERE status = 'pending'
          ORDER BY received_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [input.limit],
      );
      return result.map(rowToInbox);
    },
    markApplied: async (id) => {
      await rows(
        exec,
        "UPDATE inbox SET status = 'applied' WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    bumpAttempt:
      exec === deps.pool
        ? (id) => bumpAttemptOnPool(deps.pool, 'inbox', id)
        : (id) => bumpAttemptRow(exec, 'inbox', id),
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE inbox SET status = 'dead', dead_letter_reason = ? WHERE id = ? AND status = 'pending'",
        [reason, id],
      );
    },
    // Reviving is a claim, so it needs a transaction to hold its locks in. Inside one, it rides
    // the caller's and commits with it; on the pool it opens its own, because autocommit drops
    // every lock at the end of each statement.
    reviveDead:
      exec === deps.pool
        ? (limit) => reviveDeadOnPool(deps.pool, limit)
        : (limit) => reviveDeadInbox(exec, limit),
  };
}

// Borrows one connection for the revive's own transaction. It can only ever hold locks and never
// wait for one (SKIP LOCKED skips instead of blocking, and the update touches only rows this
// transaction already locked), so no transient-abort retry is needed here.
async function reviveDeadOnPool(
  pool: MysqlPool,
  limit: number,
): Promise<ReadonlyArray<InboxMessage>> {
  const connection = await pool.getConnection();
  try {
    await ensureReadCommitted(connection);
    await connection.query('START TRANSACTION');
    try {
      const revived = await reviveDeadInbox(connection, limit);
      await connection.query('COMMIT');
      return revived;
    } catch (error) {
      await safeRollback(connection);
      throw error;
    }
  } finally {
    connection.release();
  }
}

// This runs three statements, since MySQL has no RETURNING and no self-referencing update
// subquery, and all three belong to one transaction: FOR UPDATE SKIP LOCKED is what makes the
// batch this caller's own, so a concurrent revive picks different rows or none. The status guard
// on the update was never enough on its own — the re-read that followed it asked which rows are
// pending, not which rows this caller revived, so the caller whose update matched nothing still
// read back the winner's rows and returned them as its own.
async function reviveDeadInbox(
  exec: MysqlExecutor,
  limit: number,
): Promise<ReadonlyArray<InboxMessage>> {
  const capped = Math.max(0, limit);
  if (capped === 0) {
    return [];
  }
  const dead = await rows(
    exec,
    `SELECT id FROM inbox WHERE status = 'dead' ORDER BY received_at, id LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [capped],
  );
  if (dead.length === 0) {
    return [];
  }
  const ids = dead.map((row) => String(row.id));
  const placeholders = ids.map(() => '?').join(', ');
  await rows(
    exec,
    `UPDATE inbox SET status = 'pending', attempts = 0, dead_letter_reason = NULL
      WHERE id IN (${placeholders}) AND status = 'dead'`,
    [...ids],
  );
  const revived = await rows(
    exec,
    `SELECT id, \`key\`, operation, status, attempts, received_at, dead_letter_reason FROM inbox
      WHERE id IN (${placeholders})`,
    [...ids],
  );
  return revived.map(rowToInbox);
}

// --- Saga store -------------------------------------------------------------------

// There is no FOR UPDATE: this is a read-only enumeration, not a claim. An empty `states` list yields nothing
// per the SagaStore contract (`IN ()` is not valid MySQL, so it short-circuits here).
async function* listSubscriptionsOf(
  exec: MysqlExecutor,
  userId: string,
): AsyncIterable<Subscription> {
  const found = await rows(
    exec,
    `SELECT * FROM subscriptions WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC`,
    [userId],
  );
  for (const row of found) {
    yield rowToSubscription(row);
  }
}

async function* listSagasOf(
  exec: MysqlExecutor,
  states?: readonly Saga['state'][],
  userId?: string,
): AsyncIterable<Saga> {
  if (states !== undefined && states.length === 0) {
    return;
  }
  const where: string[] = [];
  const params: unknown[] = [];
  if (states !== undefined) {
    where.push(`state IN (${states.map(() => '?').join(', ')})`);
    params.push(...states);
  }
  if (userId !== undefined) {
    where.push('user_id = ?');
    params.push(userId);
  }
  const sql = `SELECT * FROM payout_sagas${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY updated_at DESC, id DESC`;
  for (const row of await rows(exec, sql, params)) {
    yield rowToSaga(row);
  }
}

function createSagaStore(exec: MysqlExecutor): SagaStore {
  return {
    open: async (saga) => {
      await rows(
        exec,
        `INSERT INTO payout_sagas
           (id, user_id, reserve, rate_id, txn_id, state, provider_ref, attempts, payout_usd, due_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id), reserve = VALUES(reserve),
           rate_id = VALUES(rate_id), txn_id = VALUES(txn_id),
           state = VALUES(state), provider_ref = VALUES(provider_ref),
           attempts = VALUES(attempts), payout_usd = VALUES(payout_usd),
           due_at = VALUES(due_at), updated_at = VALUES(updated_at)`,
        [
          saga.id,
          saga.userId,
          saga.reserve.minor.toString(),
          saga.rateId,
          saga.txnId,
          saga.state,
          saga.providerRef,
          saga.attempts,
          saga.payoutUsd === null ? null : saga.payoutUsd.minor.toString(),
          saga.dueAt,
          saga.updatedAt,
        ],
      );
    },
    load: async (id) => {
      const found = await rows(
        exec,
        'SELECT * FROM payout_sagas WHERE id = ? LIMIT 1',
        [id],
      );
      return found.length ? rowToSaga(found[0]!) : null;
    },
    findByProviderRef: async (providerRef) => {
      const found = await rows(
        exec,
        `SELECT * FROM payout_sagas WHERE provider_ref = ?
          ORDER BY updated_at DESC LIMIT 1`,
        [providerRef],
      );
      return found.length ? rowToSaga(found[0]!) : null;
    },
    list: (options) => listSagasOf(exec, options?.states, options?.userId),
    claimDue: async (now, limit) => {
      const result = await rows(
        exec,
        `SELECT * FROM payout_sagas
          WHERE due_at <= ? AND state IN ('RESERVED', 'SUBMITTED')
          ORDER BY due_at LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.map(rowToSaga);
    },
    // The five parameters of SagaStore.advance arrive as a tuple: naming them all would trip the
    // repo's four-parameter cap.
    advance: (...args) => advanceSaga(exec, args),
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE payout_sagas SET state = 'FAILED', reason = ? WHERE id = ?",
        [reason, id],
      );
    },
    lastPayoutAt: (userId) => lastPayoutOf(exec, userId),
  };
}

// The compare-and-set state change behind SagaStore.advance. The UPDATE takes effect only if the
// saga is still in the state the caller expected (WHERE state = `from`), and a zero-row result
// tells the caller it lost the race. A same-state advance passes that predicate for every caller
// at once, so `expectAttempts` adds `AND attempts = ?` when the caller named the value it read.
// MySQL has no partial-UPDATE coalesce (the postgres twin does), so this read-modify-writes the
// whole row. A non-terminal advance re-writes payout_usd/reason from the loaded row, never
// disturbing them.
async function advanceSaga(
  exec: MysqlExecutor,
  [id, from, to, patch, options]: Parameters<SagaStore['advance']>,
): Promise<boolean> {
  const next = {
    ...(await loadSagaOrThrow(exec, id)),
    ...patch,
    state: to,
  };
  const expectAttempts = options?.expectAttempts;
  const affected = await execWrite(
    exec,
    `UPDATE payout_sagas SET
       reserve = ?, rate_id = ?, state = ?, provider_ref = ?,
       attempts = ?, due_at = ?, updated_at = ?, payout_usd = ?, reason = ?
     WHERE id = ? AND state = ?${expectAttempts === undefined ? '' : ' AND attempts = ?'}`,
    [
      next.reserve.minor.toString(),
      next.rateId,
      to,
      next.providerRef,
      next.attempts,
      next.dueAt,
      next.updatedAt,
      next.payoutUsd === null ? null : next.payoutUsd.minor.toString(),
      next.reason,
      id,
      from,
      ...(expectAttempts === undefined ? [] : [expectAttempts]),
    ],
  );
  return affected > 0;
}

// MAX over no rows yields NULL, so a user with no sagas reads back null and their first request passes.
async function lastPayoutOf(
  exec: MysqlExecutor,
  userId: string,
): Promise<number | null> {
  const found = await rows(
    exec,
    'SELECT MAX(updated_at) AS last FROM payout_sagas WHERE user_id = ?',
    [userId],
  );
  const last = found[0]?.last;
  return last === null || last === undefined ? null : Number(last);
}

// A missing saga here is a caller bug: under normal use it exists by the time advance runs.
async function loadSagaOrThrow(exec: MysqlExecutor, id: string): Promise<Saga> {
  const found = await rows(
    exec,
    'SELECT * FROM payout_sagas WHERE id = ? LIMIT 1',
    [id],
  );
  if (!found.length) {
    throw fault(ERROR_CODES.INVALID_TRANSITION, 'Advancing a missing saga.', {
      detail: { id },
    });
  }
  return rowToSaga(found[0]!);
}

// --- Entitlement store ------------------------------------------------------------

// Ownership state, not money movement. One row per (user_id, sku, source), so refunding one order
// drops that order's grant and leaves the rest. `revoke` is a soft delete (the row keeps the audit
// history a refund or clawback may need). A later re-grant clears `revoked`, so re-buying
// re-activates.
function createEntitlementStore(deps: ExecDeps): EntitlementStore {
  const exec = deps.exec;
  return {
    grant: async (userId, sku, attrs) => {
      await rows(
        exec,
        `INSERT INTO entitlements (user_id, sku, source, quantity, version, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, false)
         ON DUPLICATE KEY UPDATE
           quantity = VALUES(quantity), version = VALUES(version),
           expires_at = VALUES(expires_at), revoked = false`,
        [
          userId,
          sku,
          attrs.source ?? '',
          attrs.quantity ?? 1,
          attrs.version ?? 1,
          attrs.expiresAt ?? null,
        ],
      );
    },

    revoke: async (userId, sku, options) => {
      // A named source revokes that one grant; no source is the operator door and takes the sku.
      const bySource = options?.source !== undefined;
      await rows(
        exec,
        `UPDATE entitlements SET revoked = true
          WHERE user_id = ? AND sku = ?${bySource ? ' AND source = ?' : ''}`,
        bySource ? [userId, sku, options.source] : [userId, sku],
      );
    },
    owns: async (userId, sku) => {
      // A null expires_at is a perpetual grant. Otherwise the user owns while now <= expiresAt, inclusive.
      const found = await rows(
        exec,
        `SELECT 1 FROM entitlements
          WHERE user_id = ? AND sku = ? AND revoked = false
            AND (expires_at IS NULL OR expires_at >= ?)
          LIMIT 1`,
        [userId, sku, deps.clock.now()],
      );
      return found.length > 0;
    },
    list: async function* (userId) {
      // Non-revoked grants, expired included. The per-sku fold and both orderings are the lab's,
      // not the database's, so a server collation never changes the answer.
      const result = await rows(
        deps.exec,
        `SELECT sku, source, expires_at FROM entitlements
          WHERE user_id = ? AND revoked = false`,
        [userId],
      );
      yield* collapseEntitlementGrants(
        result.map((row) => ({
          sku: row.sku as string,
          source: row.source as string,
          expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        })),
      );
    },
  };
}

// --- Subscription store -----------------------------------------------------------

function createSubscriptionStore(exec: MysqlExecutor): SubscriptionStore {
  return {
    open: async (sub) => {
      // ON DUPLICATE KEY must overwrite `attempts`: keeping the old count would never advance the
      // retry cap.
      await rows(
        exec,
        `INSERT INTO subscriptions
           (id, user_id, seller_id, sku, price, txn_id, period_ms, state, period, attempts, next_due_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           state = VALUES(state), period = VALUES(period), attempts = VALUES(attempts),
           next_due_at = VALUES(next_due_at), updated_at = VALUES(updated_at)`,
        [
          sub.id,
          sub.userId,
          sub.sellerId,
          sub.sku,
          sub.price.minor.toString(),
          sub.txnId,
          sub.periodMs,
          sub.state,
          sub.period,
          sub.attempts,
          sub.nextDueAt,
          sub.updatedAt,
        ],
      );
    },
    load: async (id) => {
      const found = await rows(
        exec,
        'SELECT * FROM subscriptions WHERE id = ? LIMIT 1',
        [id],
      );
      return found.length ? rowToSubscription(found[0]!) : null;
    },
    // The one ACTIVE subscription per (user, sku, seller), or null; subscribe reads this to refuse
    // a duplicate that would double-bill.
    activeFor: async (userId, sku, sellerId) => {
      const found = await rows(
        exec,
        `SELECT * FROM subscriptions
          WHERE user_id = ? AND sku = ? AND seller_id = ? AND state = 'ACTIVE'
          LIMIT 1`,
        [userId, sku, sellerId],
      );
      return found.length ? rowToSubscription(found[0]!) : null;
    },
    listFor: (userId) => listSubscriptionsOf(exec, userId),
    cancel: async (id) => {
      await rows(
        exec,
        "UPDATE subscriptions SET state = 'CANCELED' WHERE id = ?",
        [id],
      );
    },
    // FOR UPDATE SKIP LOCKED separates two claims only while both are inside transactions. The
    // sweep claims on the pool, so `markBilled`'s expectedDueAt is what stops a double bill.
    claimDue: async (now, limit) => {
      const result = await rows(
        exec,
        `SELECT * FROM subscriptions WHERE state = 'ACTIVE' AND next_due_at <= ?
          ORDER BY next_due_at LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.map(rowToSubscription);
    },
    markBilled: async (id, nextDueAt, expectedDueAt) => {
      // This is a compare-and-set on next_due_at. A worker that already billed this period moved the
      // date, so the loser matches no row and never double-charges. attempts resets to 0 on success.
      const affected = await execWrite(
        exec,
        `UPDATE subscriptions SET next_due_at = ?, period = period + 1, attempts = 0
          WHERE id = ? AND next_due_at = ?`,
        [nextDueAt, id, expectedDueAt],
      );
      return affected > 0;
    },
    // LAPSED (a renewal couldn't be funded) is distinct from the user canceling. Either way the row
    // leaves the active-only renewal query, so billing stops.
    markLapsed: async (id) => {
      await rows(
        exec,
        "UPDATE subscriptions SET state = 'LAPSED' WHERE id = ? AND state = 'ACTIVE'",
        [id],
      );
    },
  };
}

// --- Promo store ------------------------------------------------------------------

// Grants are recorded in the same transaction as the credit posting. The expiry sweep reverses
// the unspent remainder once, gated by `reversed`.
function createPromoStore(exec: MysqlExecutor): PromoStore {
  return {
    // The insert is idempotent: `ON DUPLICATE KEY UPDATE id = id` swallows the conflict without
    // touching a column, so a second open() leaves the original row intact. Unlike the saga and
    // subscription upserts, a promo grant must not be clobbered.
    open: async (grant) => {
      await rows(
        exec,
        `INSERT INTO promo_grants (id, user_id, amount, currency, expires_at, reversed)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          grant.id,
          grant.userId,
          grant.amount.minor.toString(),
          grant.amount.currency,
          grant.expiresAt,
          grant.reversed,
        ],
      );
    },
    // FOR UPDATE SKIP LOCKED separates two claims only while both are inside transactions. The
    // sweep claims on the pool, so `markReversed` no-opping on a reversed row is what absorbs a
    // doubled claim.
    claimDue: async (now, limit) => {
      const result = await rows(
        exec,
        `SELECT * FROM promo_grants
          WHERE expires_at <= ? AND reversed = false
          ORDER BY expires_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.map(rowToPromoGrant);
    },
    liveFor: async (userId) => {
      const result = await rows(
        exec,
        'SELECT * FROM promo_grants WHERE user_id = ? AND reversed = false',
        [userId],
      );
      return result.map(rowToPromoGrant);
    },
    holders: async function* () {
      const result = await rows(
        exec,
        'SELECT DISTINCT user_id FROM promo_grants',
      );
      for (const row of result) {
        yield row.user_id as string;
      }
    },
    markReversed: async (id) => {
      await rows(
        exec,
        'UPDATE promo_grants SET reversed = true WHERE id = ? AND reversed = false',
        [id],
      );
    },
  };
}

// --- Accrual store ----------------------------------------------------------------

// Parked seller shares under the accrual split. The claim reads take FOR UPDATE row locks with
// commit release, so a refund and a drain can't both consume one row. Marks are guarded on
// status = 'pending' so a terminal row never flips twice.
function createAccrualStore(deps: ExecDeps): AccrualStore {
  const exec = deps.exec;
  return {
    put: (batch) => putAccrualRows(exec, batch),
    claimByOrder: async (orderId) => {
      const result = await rows(
        exec,
        `SELECT * FROM accrual_rows WHERE order_id = ?
          ORDER BY seller_id, seq FOR UPDATE`,
        [orderId],
      );
      return result.map(rowToAccrual);
    },
    pendingSellers: async (limit) => {
      const result = await rows(
        exec,
        `SELECT DISTINCT seller_id FROM accrual_rows
          WHERE status = 'pending' ORDER BY seller_id LIMIT ?`,
        [limit],
      );
      return result.map((row) => row.seller_id as string);
    },
    // `amount < 0` sorts positives (0) ahead of recovery rows (1). See AccrualStore.
    claimPendingBySeller: async (sellerId, limit) => {
      const result = await rows(
        exec,
        `SELECT * FROM accrual_rows
          WHERE seller_id = ? AND status = 'pending'
          ORDER BY (amount < 0), recorded_at, order_id, seq
          LIMIT ? FOR UPDATE`,
        [sellerId, limit],
      );
      return result.map(rowToAccrual);
    },
    markDrained: (keys, txnId) => markAccruals(exec, keys, 'drained', txnId),
    markRefunded: (keys, txnId) => markAccruals(exec, keys, 'refunded', txnId),
    stats: async () => {
      const result = await rows(
        exec,
        `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS pending,
                MIN(recorded_at) AS oldest
           FROM accrual_rows WHERE status = 'pending'`,
      );
      const row = result[0]!;
      return {
        pendingMinor: readMinor(row.pending),
        oldestPendingAgeMs:
          row.oldest === null || row.oldest === undefined
            ? null
            : Math.max(0, deps.clock.now() - Number(row.oldest)),
      };
    },
    netPending: async (sellerId) => {
      const result = await rows(
        exec,
        `SELECT COALESCE(SUM(amount), 0) AS net FROM accrual_rows
          WHERE seller_id = ? AND status = 'pending'`,
        [sellerId],
      );
      return readMinor(result[0]!.net);
    },
  };
}

async function putAccrualRows(
  exec: MysqlExecutor,
  batch: ReadonlyArray<AccrualRow>,
): Promise<void> {
  if (batch.length === 0) {
    return;
  }
  const marks = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  await rows(
    exec,
    `INSERT INTO accrual_rows
       (order_id, seller_id, seq, amount, shard, status, txn_id, settled_txn_id, recorded_at)
     VALUES ${marks}`,
    batch.flatMap((row) => [
      row.orderId,
      row.sellerId,
      row.seq,
      row.amount.minor.toString(),
      row.shard,
      row.status,
      row.txnId,
      row.settledTxnId,
      row.recordedAt,
    ]),
  );
}

async function markAccruals(
  exec: MysqlExecutor,
  keys: ReadonlyArray<AccrualRowKey>,
  status: 'drained' | 'refunded',
  settledTxnId: string,
): Promise<void> {
  for (const key of keys) {
    await rows(
      exec,
      `UPDATE accrual_rows SET status = ?, settled_txn_id = ?
        WHERE order_id = ? AND seller_id = ? AND seq = ? AND status = 'pending'`,
      [status, settledTxnId, key.orderId, key.sellerId, key.seq],
    );
  }
}

// --- Trust store -------------------------------------------------------------------

// Two views share the helpers below. The pool-backed store commits on its own. The Unit view
// writes inside the money transaction, so a committed attempt shares the money commit and a
// rolled-back one still counts. `bump` keys on the attempt's idempotency key, so a retry never
// double-counts.

// The windowed measure `read` and `record` share. Only attempts newer than the cutoff are summed,
// so each ages out on its own. The cutoff uses the injected clock (not SQL NOW()) so tests stay
// deterministic.
async function measureVelocity(
  exec: MysqlExecutor,
  subject: string,
  cutoff: number,
): Promise<Velocity> {
  const found = await rows(
    exec,
    `SELECT COALESCE(MIN(at), 0) AS window_start,
            COALESCE(SUM(amount), 0) AS spent,
            COUNT(*) AS attempts
       FROM trust_attempts WHERE subject = ? AND at > ?`,
    [subject, cutoff],
  );
  const row = found[0]!;
  return {
    subject,
    windowStart: Number(row.window_start),
    spent: toAmount('CREDIT', readMinor(row.spent)),
    attempts: Number(row.attempts),
  } satisfies Velocity;
}

// Runs a CALL whose procedure returns rows. mysql2 wraps the result set in an extra array ahead
// of the OK packet, so the rows are the first element.
async function callRows(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown>,
): Promise<Row[]> {
  const [results] = await exec.query(sql, params);
  const first = (results as unknown[])[0];
  return (Array.isArray(first) ? first : []) as Row[];
}

// The one-round-trip trust_record procedure call both trust stores share. The proc takes the
// subject lock, inserts, and measures server-side (see db/mysql-schema.sql).
async function recordViaProcedure(
  exec: MysqlExecutor,
  subject: string,
  attempt: Attempt,
  cutoff: number,
): Promise<Velocity> {
  const found = await callRows(exec, 'CALL trust_record(?, ?, ?, ?, ?, ?)', [
    attempt.idempotencyKey,
    subject,
    attempt.amount.minor.toString(),
    attempt.outcome,
    attempt.at,
    cutoff,
  ]);
  const row = found[0]!;
  return {
    subject,
    windowStart: Number(row.window_start),
    spent: toAmount('CREDIT', readMinor(row.spent)),
    attempts: Number(row.attempts),
  } satisfies Velocity;
}

async function insertAttempt(
  exec: MysqlExecutor,
  subject: string,
  attempt: Attempt,
): Promise<void> {
  await rows(
    exec,
    `INSERT IGNORE INTO trust_attempts (idempotency_key, subject, amount, outcome, at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      attempt.idempotencyKey,
      subject,
      attempt.amount.minor.toString(),
      attempt.outcome,
      attempt.at,
    ],
  );
}

function createTrustStore(
  pool: MysqlPool,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    read: async (subject) =>
      measureVelocity(pool, subject, clock.now() - windowMs),
    bump: async (subject, attempt) => insertAttempt(pool, subject, attempt),
    // The proc's per-subject named lock serializes the insert and the SUM — the atomicity
    // `TrustStore.record` requires (ports.ts). The lock attaches to the borrowed connection, so
    // it is released in `finally` and a later borrower never inherits it.
    record: async (subject, attempt) => {
      const cutoff = clock.now() - windowMs;
      const connection = await pool.getConnection();
      try {
        return await recordViaProcedure(connection, subject, attempt, cutoff);
      } finally {
        await releaseLocks(connection);
        connection.release();
      }
    },
  };
}

// The transaction-scoped trust view a Unit carries. `record` runs on the money transaction's own
// connection, so the inserted attempt commits with the money. The proc's named lock holds
// until `transaction()` releases it after commit or rollback. The proc derives the lock name
// itself (`trust:` tag, 56-byte cap).
function createUnitTrustStore(
  exec: MysqlExecutor,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    read: async (subject) =>
      measureVelocity(exec, subject, clock.now() - windowMs),
    bump: async (subject, attempt) => insertAttempt(exec, subject, attempt),
    record: async (subject, attempt) =>
      recordViaProcedure(exec, subject, attempt, clock.now() - windowMs),
  };
}

// --- Movement journal ---------------------------------------------------------------

// Append-only and never part of a money transaction (see MovementJournal in ports.ts). The whole
// batch lands as ONE multi-row INSERT — a single statement, so it commits or rejects atomically
// with one fsync for N movements. A duplicate idem_key or (session_id, seq) rejects it all.
function createMovementJournal(pool: MysqlPool): MovementJournal {
  return {
    append: async (movements) => {
      if (movements.length === 0) {
        return;
      }
      const marks = movements.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      await rows(
        pool,
        `INSERT INTO instance_movements
           (session_id, seq, idem_key, legs, prev_hash, hash, recorded_at)
         VALUES ${marks}`,
        movements.flatMap((movement) => [
          movement.sessionId,
          movement.seq,
          movement.idempotencyKey,
          JSON.stringify(encodeLegs(movement.legs)),
          movement.prevHash,
          movement.hash,
          movement.recordedAt,
        ]),
      );
    },
    bySession: async function* (sessionId) {
      const result = await rows(
        pool,
        `SELECT * FROM instance_movements WHERE session_id = ? ORDER BY seq`,
        [sessionId],
      );
      for (const row of result) {
        yield {
          sessionId: row.session_id as string,
          seq: Number(row.seq),
          idempotencyKey: row.idem_key as string,
          legs: decodeLegs(
            parseJson(row.legs) as ReadonlyArray<{
              account: string;
              amount: string;
            }>,
          ),
          prevHash: row.prev_hash as string,
          hash: row.hash as string,
          recordedAt: Number(row.recorded_at),
        };
      }
    },
    // Pages by keyset so an unbounded journal never materializes in one result set.
    sessionIds: async function* () {
      let after = '';
      for (;;) {
        const page = await rows(
          pool,
          `SELECT DISTINCT session_id FROM instance_movements
            WHERE session_id > ?
            ORDER BY session_id
            LIMIT 500`,
          [after],
        );
        if (page.length === 0) {
          return;
        }
        for (const row of page) {
          yield row.session_id as string;
        }
        after = page[page.length - 1]!.session_id as string;
      }
    },
    pruneSession: async (sessionId) =>
      execWrite(pool, `DELETE FROM instance_movements WHERE session_id = ?`, [
        sessionId,
      ]),
  };
}

// --- Reservation store ------------------------------------------------------------

async function readTableSizes(pool: MysqlPool): Promise<TableSizes> {
  const found = await rows(
    pool,
    `SELECT
       (SELECT COUNT(*) FROM instance_movements) AS movements,
       (SELECT COUNT(*) FROM idempotency)        AS idempotency,
       (SELECT COUNT(*) FROM sales)              AS sales,
       (SELECT COUNT(*) FROM outbox)             AS outbox,
       (SELECT COUNT(*) FROM payout_sagas)       AS sagas,
       (SELECT COUNT(*) FROM accrual_rows)       AS accruals,
       (SELECT COUNT(*) FROM entitlements)       AS entitlements`,
  );
  const row = found[0]!;
  return {
    movements: Number(row.movements),
    idempotency: Number(row.idempotency),
    sales: Number(row.sales),
    outbox: Number(row.outbox),
    sagas: Number(row.sagas),
    accruals: Number(row.accruals),
    entitlements: Number(row.entitlements),
  };
}

// The multi-node counter (see the reservations banner in db/postgresql-schema.sql). MySQL's
// upsert cannot return the updated value, so the read is a second autocommitted statement. The
// read sees a total at-or-after our own add (a concurrent add is either already inside it or
// arrives later and sees ours). The caller's add-then-check therefore only ever drifts
// conservative — refusing a marginal movement, never accepting one blind.
function createReservationStore(pool: MysqlPool): ReservationStore {
  return {
    add: async (account, naturalDelta) => {
      await execWrite(
        pool,
        `INSERT INTO reservations (account_id, pending) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE pending = pending + VALUES(pending)`,
        [account, naturalDelta.toString()],
      );
      const found = await rows(
        pool,
        `SELECT pending FROM reservations WHERE account_id = ?`,
        [account],
      );
      return readMinor(found[0]!.pending);
    },
    pending: async (account) => {
      const found = await rows(
        pool,
        `SELECT pending FROM reservations WHERE account_id = ?`,
        [account],
      );
      const row = found[0];
      return row === undefined ? 0n : readMinor(row.pending);
    },
    entries: async function* () {
      let after = '';
      for (;;) {
        const page = await rows(
          pool,
          `SELECT account_id, pending FROM reservations
            WHERE account_id > ?
            ORDER BY account_id
            LIMIT 500`,
          [after],
        );
        if (page.length === 0) {
          return;
        }
        for (const row of page) {
          yield [row.account_id as AccountRef, readMinor(row.pending)] as [
            AccountRef,
            bigint,
          ];
        }
        after = page[page.length - 1]!.account_id as string;
      }
    },
  };
}

// --- Checkpoint store (used only by background workers) ---------------------------

// These are the archival mover's boundary records: the signed archive state and the per-account
// archived heads/sums it authenticates. The state is a single-row rewrite, like the reproof
// state. A crash between delete and insert is repaired by the mover re-writing state before its
// next prune.
function archiveStateSurfaces(
  pool: MysqlPool,
): Pick<
  CheckpointStore,
  'archiveState' | 'archiveHeads' | 'putArchiveBoundary'
> {
  return {
    archiveState: async () => {
      const found = await rows(
        pool,
        `SELECT through_seq, cursor_seq, root, signature, checkpoint_id, at
           FROM archive_state LIMIT 1`,
      );
      const row = found[0];
      if (!row) {
        return null;
      }
      return {
        throughSeq: Number(row.through_seq),
        cursor: row.cursor_seq === null ? null : Number(row.cursor_seq),
        root: row.root as string,
        signature: row.signature as string,
        checkpointId: row.checkpoint_id as string,
        at: Number(row.at),
      };
    },
    archiveHeads: async () => {
      const found = await rows(
        pool,
        'SELECT account_id, head, sum FROM archive_heads ORDER BY account_id',
      );
      return found.map((row) => ({
        account: row.account_id as AccountRef,
        head: row.head as string,
        sum: readMinor(row.sum),
      }));
    },
    // Everything runs in one transaction: the state's signature authenticates the head set, so
    // the pair must land together or not at all.
    putArchiveBoundary: async (state, heads) => {
      const connection = await pool.getConnection();
      try {
        await connection.query('START TRANSACTION');
        for (const row of heads) {
          await connection.query(
            `INSERT INTO archive_heads (account_id, head, sum) VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE head = VALUES(head), sum = VALUES(sum)`,
            [row.account, row.head, row.sum.toString()],
          );
        }
        await connection.query('DELETE FROM archive_state');
        await connection.query(
          `INSERT INTO archive_state (through_seq, cursor_seq, root, signature, checkpoint_id, at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          [
            state.throughSeq,
            state.cursor,
            state.root,
            state.signature,
            state.checkpointId,
            state.at,
          ],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await safeRollback(connection);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

// The incremental seal's snapshot leaves. Writes are chunked so a full-mode rewrite stays under
// max_allowed_packet. A crash between the replaceAll delete and the inserts leaves a partial
// snapshot that fails the next seal's authentication and heals through another full replay.
function sealHeadSurfaces(
  pool: MysqlPool,
): Pick<CheckpointStore, 'putSealHeads' | 'sealHeads'> {
  return {
    putSealHeads: async (leaves, options) => {
      if (options?.replaceAll === true) {
        await rows(pool, 'DELETE FROM seal_heads');
      }
      for (let i = 0; i < leaves.length; i += 500) {
        const chunk = leaves.slice(i, i + 500);
        await rows(
          pool,
          `INSERT INTO seal_heads (account_id, head, sum)
           VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
           ON DUPLICATE KEY UPDATE head = VALUES(head), sum = VALUES(sum)`,
          chunk.flatMap(([account, head, sum]) => [
            account,
            head,
            sum.toString(),
          ]),
        );
      }
    },
    sealHeads: async () => {
      const result = await rows(pool, 'SELECT * FROM seal_heads');
      return result.map(
        (row) =>
          [
            row.account_id as AccountRef,
            row.head as string,
            readMinor(row.sum),
          ] as const,
      );
    },
  };
}

// Written on the pool, not in a money transaction, so a recorded checkpoint survives even if a
// later money transaction rolls back.
function createCheckpointStore(pool: MysqlPool): CheckpointStore {
  return {
    reproof: async () => {
      const result = await rows(
        pool,
        'SELECT cursor_seq, rotated_at FROM chain_reproof LIMIT 1',
      );
      const row = result[0];
      if (row === undefined) {
        return null;
      }
      return {
        cursor: row.cursor_seq === null ? null : Number(row.cursor_seq),
        rotatedAt: row.rotated_at === null ? null : Number(row.rotated_at),
      };
    },
    // A single-row rewrite. A crash between the two statements loses only the cursor, and the next
    // sweep restarts from genesis — over-verification, never a skipped link.
    putReproof: async (state) => {
      await rows(pool, 'DELETE FROM chain_reproof');
      await rows(
        pool,
        'INSERT INTO chain_reproof (cursor_seq, rotated_at) VALUES (?, ?)',
        [state.cursor, state.rotatedAt],
      );
    },
    ...archiveStateSurfaces(pool),
    ...sealHeadSurfaces(pool),
    put: async (checkpoint) => {
      await rows(
        pool,
        `INSERT INTO checkpoints (id, root, signature, count, at, v, sum, kid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          checkpoint.id,
          checkpoint.root,
          checkpoint.signature,
          checkpoint.count,
          checkpoint.at,
          checkpoint.v,
          checkpoint.sum,
          checkpoint.kid,
        ],
      );
    },
    latest: async () => {
      const found = await rows(
        pool,
        'SELECT * FROM checkpoints ORDER BY seq DESC LIMIT 1',
      );
      return found.length ? rowToCheckpoint(found[0]!) : null;
    },
  };
}

// --- Webhook replay store (kept outside money transactions) -----------------------

// Dedupes inbound provider webhooks by the provider's event id, a separate id space from the
// application's idempotency keys. An id is claimed only after the signature and freshness
// checks, so a rejected delivery never burns the id. Claims are written on the pool, so a landed
// claim survives a later money rollback. INSERT IGNORE reports affectedRows 1 only on the inserting call, which
// distinguishes first delivery from redelivery.
function createReplayStore(pool: MysqlPool): ReplayStore {
  return {
    claim: async (eventId) => {
      const affected = await execWrite(
        pool,
        'INSERT IGNORE INTO seen_webhooks (event_id) VALUES (?)',
        [eventId],
      );
      return { claimed: affected > 0 };
    },
  };
}

// --- Row decoders -----------------------------------------------------------------

// MySQL hands back the legs column as text; the assembly after that is the lab's.
const saleFromRow = (row: Row): Sale =>
  rowToSale(
    row,
    decodeLegs(
      parseJson(row.legs) as ReadonlyArray<{ account: string; amount: string }>,
    ),
  );

// --- Converting money and JSON to and from stored form ----------------------------

// JSON.stringify cannot handle bigint, so amounts become decimal strings. This lets a stored
// transaction round-trip exactly for an idempotent replay.
function encodeTransaction(transaction: Transaction): string {
  return JSON.stringify({
    id: transaction.id,
    postedAt: transaction.postedAt,
    legs: encodeLegs(transaction.legs),
    links: transaction.links,
    meta: transaction.meta,
  });
}

function parseTransaction(value: unknown): Transaction {
  const parsed = parseJson(value) as {
    id: string;
    postedAt: number;
    legs: ReadonlyArray<{ account: string; amount: string }>;
    links: Transaction['links'];
    meta?: Record<string, unknown>;
  };
  return {
    id: parsed.id,
    postedAt: parsed.postedAt,
    legs: decodeLegs(parsed.legs),
    links: parsed.links,
    // Rows recorded before Transaction carried meta have none stored.
    meta: parsed.meta ?? {},
  };
}

function parseMeta(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

// --- Grouping the stores into one transactional unit ------------------------------

// All sub-stores share one connection, so every write commits or rolls back together. `trust` is
// passed in: a transaction passes the Unit view, while the non-transactional unit gets the
// pool-backed store — a named lock taken through the pool would land on an arbitrary connection
// and never be released.
function buildUnit(deps: ExecDeps, trust: TrustStore): Unit {
  return {
    ledger: createLedgerStore(deps),
    idempotency: createIdempotencyStore(deps.exec),
    sales: createSaleStore(deps.exec),
    outbox: createOutboxStore(deps),
    inbox: createInboxStore(deps),
    sagas: createSagaStore(deps.exec),
    entitlements: createEntitlementStore(deps),
    subscriptions: createSubscriptionStore(deps.exec),
    promos: createPromoStore(deps.exec),
    trust,
    accruals: createAccrualStore(deps),
  };
}

// --- The assembled store ----------------------------------------------------------

// The one path that ends a pool, and the only place ownership is spent. It refuses a pool this
// package did not open, so ending a caller's pool fails by name instead of quietly happening.
/** Everything {@link mysqlStore} takes. Named so the private builder below can share it. */
type MysqlStoreDeps = {
  pool: MysqlPool;
  /** Hash service for chain links; defaults to the deterministic web-standard SHA-256. */
  digest?: Digest;
  /** Time source for `postedAt` and window math; defaults to wall-clock time. */
  clock?: Clock;
  /**
   * Rolling window (ms) the trust store applies when summing a subject's recent spend for the
   * velocity check. Defaults to one hour.
   */
  velocityWindowMs?: number;
  /**
   * Open-path schema policy: 'assert' verifies the schema_meta stamp before the first operation
   * of any kind; 'skip' (the default here) is for the staged open that already asserted on the
   * pool. It governs the stamp only — the money proof runs either way. Migration is
   * {@link applyMysqlSchema} or an external migrate job — never an open option.
   */
  schema?: 'assert' | 'skip';
  /**
   * Optional runtime ports for the engine's own telemetry (transient-retry pressure). Unset
   * emits nothing.
   */
  meter?: Meter;
  logger?: Logger;
};

/**
 * Build the full MySQL-backed store on a connection pool the caller creates and owns. That is
 * the `mysql2` pool from {@link createMysqlPool}, or the pipelining `mariadb` pool from
 * `@pwngh/economy-mysql/mariadb`. Both fill the same {@link MysqlPool} seam and run
 * the same SQL against the same schema.
 *
 * `transaction(work)` borrows one connection, wraps `work` in START TRANSACTION ... COMMIT, and
 * rolls back if `work` throws. Money transactions run at READ COMMITTED (set once per pooled
 * connection). Correctness comes from explicit `FOR UPDATE` row locks plus a `GET_LOCK` named
 * lock per account. A transient InnoDB abort — deadlock, lock-wait timeout, named-lock deadlock,
 * or a stale-head chain fork — committed nothing. So the whole unit of work is re-run in a fresh
 * connection and transaction and callers never see it as an error. Every posting appends to a
 * per-account hash chain, and the schema's triggers enforce conservation and chain continuity on
 * every write. On the way out of a transaction every named lock the connection acquired is
 * released, so a returned connection carries no leftover locks. Anything outside a transaction
 * (plain reads/writes, plus the trust and checkpoint stores) runs directly on the pool and
 * commits on its own.
 *
 * The hash service defaults to the deterministic web-standard SHA-256; the clock defaults to
 * wall-clock time. Pass a fixed clock when reproducible `postedAt` values matter. The velocity
 * window defaults to one hour.
 *
 * The pool stays the caller's. `close()` releases nothing here, and ending the pool is the
 * caller's job. {@link mysql} opens its own pool and does end that one on `close()`.
 *
 * This factory is synchronous, so the open-path checks run once before the first operation rather
 * than here: the engine installs the vendored money routines and proves it computes the pinned
 * arithmetic before any posting trusts it. `schema: 'assert'` adds the schema_meta stamp to that
 * same one-time check.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the store and outbox/inbox ports this backs.
 */
export function mysqlStore(deps: MysqlStoreDeps): Store {
  return buildMysqlStore(deps, null);
}

// The store proper. `owned` is the provenance record: the pool when this package opened it,
// null when the caller handed one in. It is the only thing close() consults before ending.
// `verified` says the caller already ran the open-path checks eagerly, so the lazy ones stand down.
function buildMysqlStore(
  deps: MysqlStoreDeps,
  owned: MysqlPool | null,
  verified = false,
): Store {
  const digest = deps.digest ?? defaultDigest();
  const clock = deps.clock ?? systemClock();
  const velocityWindowMs = deps.velocityWindowMs ?? 60 * 60_000;
  const ensureSchemaAsserted = lazyOpenChecks(deps.pool, deps.schema, verified);
  // Every pool query below waits for the one-time open checks unless they already ran.
  const pool = gatePool(deps.pool, verified, ensureSchemaAsserted);
  const retryObserver = retryTelemetry(
    { meter: deps.meter, logger: deps.logger },
    'mysql',
  );
  const acquireTimed = async () => {
    deps.meter?.count(ENGINE_METRICS.poolAcquire, 1, { engine: 'mysql' });
    const started = clock.now();
    const connection = await pool.getConnection();
    deps.meter?.observe(ENGINE_METRICS.poolAcquireMs, clock.now() - started, {
      engine: 'mysql',
    });
    return connection;
  };
  const known = new KnownAccounts();
  const poolDeps: ExecDeps = { exec: pool, digest, clock, pool, known };

  const trust = createTrustStore(pool, clock, velocityWindowMs);
  const auto = buildUnit(poolDeps, trust);

  return {
    ledger: auto.ledger,
    idempotency: auto.idempotency,
    sales: auto.sales,
    outbox: auto.outbox,
    inbox: auto.inbox,
    sagas: auto.sagas,
    entitlements: auto.entitlements,
    subscriptions: auto.subscriptions,
    promos: auto.promos,
    trust,
    accruals: auto.accruals,
    checkpoints: createCheckpointStore(pool),
    movements: createMovementJournal(pool),
    reservations: createReservationStore(pool),
    replay: createReplayStore(pool),
    tableSizes: () => readTableSizes(pool),

    // The whole unit of work lives in this one transaction, so a transient InnoDB abort (deadlock or
    // lock-wait timeout) committed nothing and withTransientRetry can re-run all of `work` in a fresh
    // connection + transaction, atomic and idempotency-safe. A true settle-vs-reverse conflict then
    // retries into a clean SAGA.INVALID_TRANSITION (the retried op reloads a now-terminal saga) rather
    // than escaping as a raw deadlock. Any non-transient error propagates unchanged on its first throw.
    // @see https://economy-lab-docs.pages.dev/economy/ports/messaging/
    transaction: async (work) => {
      await ensureSchemaAsserted();
      return withTransientRetry(
        () =>
          transactionAttempt(
            { acquireTimed, digest, clock, pool, velocityWindowMs, known },
            work,
          ),
        isTransientConflict,
        { observer: retryObserver },
      );
    },

    // Submit micro-batching uses one transaction with one savepoint per work item. A failing item
    // rolls back to its savepoint only. The batch commits the rest with one fsync. Named locks a
    // rolled-back item took stay held until the connection's RELEASE_ALL_LOCKS — over-holding,
    // never under-holding. A transient abort re-runs the whole batch like any transaction.
    batchTransaction: async (works, _options?) => {
      await ensureSchemaAsserted();
      return withTransientRetry(
        () =>
          batchAttempt(
            { acquireTimed, digest, clock, pool, velocityWindowMs, known },
            works,
          ),
        isTransientConflict,
        { observer: retryObserver },
      );
    },

    // Ownership follows creation: the pool is ended only when this package opened it. A pool the
    // caller built is left open for the caller to end.
    close: async () => {
      if (owned === null) {
        return;
      }
      await endOwnedPool(owned, 'mysql', 'close');
    },
  };
}

type AttemptEnv = {
  acquireTimed: () => Promise<MysqlConnection>;
  digest: Digest;
  clock: Clock;
  pool: MysqlPool;
  velocityWindowMs: number;
  known: KnownAccounts;
};

// Money transactions run at READ COMMITTED, like Postgres. Correctness comes from the explicit
// FOR UPDATE locks, which behave the same at either level. REPEATABLE READ's pinned
// snapshot served stale mid-transaction reads, and its gap locks deadlocked concurrent first-use
// inserts. The level is set once per pooled connection at the session level, since every
// transaction on the connection wants it. A single-statement autocommit read observes the same
// latest committed state at either level, so the returned connection serves reads unchanged.
const readCommittedSet = new WeakSet<object>();
async function ensureReadCommitted(connection: MysqlConnection): Promise<void> {
  const key = connection.connection ?? connection;
  if (readCommittedSet.has(key)) {
    return;
  }
  await connection.query(
    'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
  );
  readCommittedSet.add(key);
}

// The savepoint walk rolls this per-transaction scratch state back alongside the data: staged
// plants and captured heads.
type TxScratch = { staged: StagedAccounts; heads: TxHeads };

async function transactionAttempt<T>(
  env: AttemptEnv,
  work: (
    unit: Unit,
    connection: MysqlConnection,
    scratch: TxScratch,
  ) => Promise<T>,
): Promise<T> {
  const connection = await env.acquireTimed();
  const staged = new StagedAccounts();
  const heads = new TxHeads();
  try {
    await ensureReadCommitted(connection);
    await connection.query('START TRANSACTION');
    const unit = buildUnit(
      {
        exec: connection,
        digest: env.digest,
        clock: env.clock,
        pool: env.pool,
        known: env.known,
        staged,
        heads,
      },
      createUnitTrustStore(connection, env.clock, env.velocityWindowMs),
    );
    const result = await work(unit, connection, { staged, heads });
    await connection.query('COMMIT');
    // Only now are this transaction's plants committed data. A rollback promotes nothing.
    staged.promoteInto(env.known);
    return result;
  } catch (error) {
    await safeRollback(connection);
    throw error;
  } finally {
    await releaseLocks(connection);
    connection.release();
  }
}

async function batchAttempt<T>(
  env: AttemptEnv,
  works: ReadonlyArray<(u: Unit) => Promise<T>>,
): Promise<Array<BatchSlot<T>>> {
  return transactionAttempt(env, (unit, connection, scratch) =>
    runSavepointed(connection, unit, scratch, works),
  );
}

// The savepoint walk batchTransaction runs between BEGIN and COMMIT. A transient InnoDB abort
// inside an item poisons the whole transaction (InnoDB may have rolled it back already), so it
// rethrows to retry the batch rather than being absorbed into the item's slot.
async function runSavepointed<T>(
  connection: MysqlConnection,
  unit: Unit,
  scratch: TxScratch,
  works: ReadonlyArray<(u: Unit) => Promise<T>>,
): Promise<Array<BatchSlot<T>>> {
  const slots: Array<BatchSlot<T>> = [];
  for (let i = 0; i < works.length; i += 1) {
    await connection.query(`SAVEPOINT op_${i}`);
    // A savepoint rollback undoes the item's plants and chain links, so its staging and head
    // advances roll back with it — a stale forward head would fork the chain on the next append.
    const stagedMark = scratch.staged.mark();
    const headsMark = scratch.heads.mark();
    try {
      slots.push({ ok: true, value: await works[i]!(unit) });
      await connection.query(`RELEASE SAVEPOINT op_${i}`);
    } catch (error) {
      if (isTransientConflict(error)) {
        throw error;
      }
      await connection.query(`ROLLBACK TO SAVEPOINT op_${i}`);
      scratch.staged.rollbackTo(stagedMark);
      scratch.heads.rollbackTo(headsMark);
      slots.push({ ok: false, error });
    }
  }
  return slots;
}

// The store factory is sync, so the open-path checks run lazily before the first operation of any
// kind — reads through the gated pool, transactions directly — rather than at open. The money
// proof always runs; `mode` governs the schema stamp alone. That split matches postgresStore,
// where the install and proof sit outside the same guard, and it is what makes the money proof
// reach the sync door. `verified` is set by the async `mysql()` door, which already ran both
// eagerly. Concurrent first calls share one in-flight check. Once verified it never re-checks. A
// failed check clears so the next call retries.
function lazyOpenChecks(
  pool: MysqlPool,
  mode: 'assert' | 'skip' | undefined,
  verified: boolean,
): () => Promise<void> {
  if (verified) {
    return () => Promise.resolve();
  }
  let checked = false;
  let inFlight: Promise<void> | undefined;
  return () => {
    if (checked) {
      return Promise.resolve();
    }
    inFlight ??= (async () => {
      if (mode === 'assert') {
        assertSchemaCurrent(await readSchemaVersion(pool), 'MySQL');
      }
      await installAndProveMoney(pool);
      checked = true;
    })().catch((error: unknown) => {
      inFlight = undefined;
      throw error;
    });
    return inFlight;
  };
}

// Wraps the pool so every query and every borrowed connection first waits for the one-time open
// checks, gating all pool-backed work at one chokepoint. A store whose checks already ran gets the
// pool untouched. The checks run on the pool underneath, so waiting for them here cannot recurse.
function gatePool(
  pool: MysqlPool,
  verified: boolean,
  ensureOpenChecked: () => Promise<void>,
): MysqlPool {
  if (verified) {
    return pool;
  }
  return {
    query: async (sql, params) => {
      await ensureOpenChecked();
      return pool.query(sql, params);
    },
    getConnection: async () => {
      await ensureOpenChecked();
      return pool.getConnection();
    },
    end: () => pool.end(),
  };
}

// A transient InnoDB abort committed nothing, so it is safe to retry. Anything else (a domain
// fault, a CHECK/constraint violation, a connection error) is not retried.
function isTransientConflict(error: unknown): boolean {
  const e = error as {
    errno?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  } | null;
  const errno = e?.errno;
  // 1213 (deadlock) and 1205 (lock-wait timeout) are the classic "try again" aborts, and 3058 is
  // the named-lock (GET_LOCK) deadlock the MDL detector raises — the same would-block verdict as
  // 1213, seen from the user-lock side. Nothing committed, so a fresh attempt after rollback is
  // safe. Batching raises its odds (one connection holds several subjects' locks). A 1062 on
  // chain_links_account_prev_uq is a stale-head chain fork, not a real duplicate: the head moved,
  // and a retry re-reads it and attaches cleanly. mysql2 surfaces no constraint name, so the fork is
  // matched by key name in sqlMessage. A real duplicate names a different key and still fails fast.
  //
  // 1644 is the chain-continuity trigger's SIGNAL. It is the same stale-head race seen from the
  // trigger side, equally fixed by retrying. It is matched only when the message names "chain continuity",
  // because 1644 also carries the genuine `conservation` and `balance integrity` faults, which must
  // fail fast and are never retried.
  const text = String(e?.sqlMessage ?? e?.message ?? '');
  return (
    errno === 1213 ||
    errno === 1205 ||
    errno === 3058 ||
    (errno === 1062 && text.includes(CHAIN_FORK_INDEX)) ||
    (errno === 1644 && text.includes(CHAIN_CONTINUITY_MARKER))
  );
}

// Rolls back, ignoring any error from the rollback itself. We are here because `work` threw, and that
// original error is the one to report, so a failing rollback must not replace it.
async function safeRollback(connection: MysqlConnection): Promise<void> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    // The original error is the one that matters; ignore a failed rollback.
  }
}

// Drops every named lock the connection holds before it returns to the pool. MySQL named locks stay
// held until explicitly released or the connection closes, so without this a later borrower would
// inherit locks it never asked for.
async function releaseLocks(connection: MysqlConnection): Promise<void> {
  try {
    await connection.query('SELECT RELEASE_ALL_LOCKS()');
  } catch {
    // The connection is being released anyway; a failed unlock can't keep it tied up.
  }
}

// --- Creating the database schema -------------------------------------------------

/**
 * Reads the database's stamped schema version from `schema_meta`, or `null` when that table is
 * absent (an un-migrated or pre-versioning database). Every other failure throws, because an
 * unreachable or unauthorized database is not an un-migrated one and must not be answered with
 * "re-apply the schema". Assert the result at startup to fail fast on a schema that has drifted
 * from this code.
 */
export async function readSchemaVersion(
  pool: MysqlPool,
): Promise<string | null> {
  try {
    const [rows] = await pool.query('SELECT version FROM schema_meta LIMIT 1');
    const row = (rows as Array<{ version?: string }>)[0];
    return row?.version ?? null;
  } catch (error) {
    if (isMissingSchemaTable(error)) {
      return null;
    }
    throw unreachableDatabase('MySQL', error);
  }
}

// 1146 (ER_NO_SUCH_TABLE) is how a reachable MySQL says schema_meta is not there. Nothing else,
// least of all a connection error, carries that meaning.
function isMissingSchemaTable(error: unknown): boolean {
  const failure = error as { errno?: unknown; code?: unknown } | null;
  return failure?.errno === 1146 || failure?.code === 'ER_NO_SUCH_TABLE';
}

/**
 * Create all tables and stored routines this engine needs, from the canonical schema file
 * `db/mysql-schema.sql` (the MySQL counterpart to `db/postgresql-schema.sql`). The file drops and
 * recreates the tables, so running this resets to a clean schema (convenient for tests). Run once
 * during setup (operations tooling or CI), never automatically at app startup.
 *
 * mysql2 sends one statement per `query`, so the file is split into individual statements first
 * (honoring the mysql CLI's `DELIMITER` directive for routine bodies), then each is run in order.
 */
export async function applyMysqlSchema(pool: MysqlPool): Promise<void> {
  const path = fileURLToPath(
    new URL('../db/mysql-schema.sql', import.meta.url),
  );
  const sql = await readFile(path, 'utf8');
  // The schema file pins the database collation (its leading ALTER DATABASE) before any DROP/CREATE,
  // so the freshly created tables match the utf8mb4_0900_ai_ci strings JSON_TABLE produces inside
  // post_entry — the same pin scripts/migrate.sh applies.
  for (const statement of splitSqlStatements(sql)) {
    await pool.query(statement);
  }
}

// Splits a `.sql` file into statements (mysql2 runs one per `query`). A `DELIMITER xxx` line
// changes the separator, the same directive the mysql CLI uses, so a routine body's inner `;`
// stays one statement. The directive line itself is never sent to the server.
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (/^DELIMITER\s+/i.test(trimmed)) {
      delimiter = trimmed.replace(/^DELIMITER\s+/i, '').trim();
      continue;
    }
    if (buffer.trim() === '' && (trimmed === '' || trimmed.startsWith('--'))) {
      continue;
    }
    buffer += line + '\n';
    // A `--` comment line stays with its statement but never terminates it: prose punctuation at
    // a comment's end (a trailing `;`) is not a statement end. Only real SQL text can carry the
    // delimiter.
    if (trimmed.startsWith('--')) {
      continue;
    }
    if (buffer.trimEnd().endsWith(delimiter)) {
      const end = buffer.trimEnd();
      const statement = end.slice(0, end.length - delimiter.length).trim();
      if (statement !== '') {
        statements.push(statement);
      }
      buffer = '';
    }
  }
  // A nonempty tail means a statement never met its delimiter — a same-line trailing comment
  // after the `;`, or a missing terminator. Fail loud instead of silently dropping it.
  if (buffer.trim() !== '') {
    throw new Error(
      `mysql schema: unterminated trailing statement: ${buffer.trim().slice(0, 80)}`,
    );
  }
  return statements;
}

/**
 * Create a `mysql2` connection pool from a connection URL. `mysql2` is imported here and nowhere
 * else, only when this function runs, so a process that never opens a pool never loads it. The
 * pool returns large integer columns (the money columns, stored as 64-bit integers) as strings,
 * which the engine then converts to bigint exactly.
 *
 * The connection collation is pinned to the schema's utf8mb4 default so the strings the posting
 * routine derives from JSON join the table columns without collation errors.
 *
 * `connectionLimit` caps the pool. Each in-flight transaction holds one connection for its whole
 * BEGIN..COMMIT, so a caller driving N concurrent submits must size this to at least N. Left unset,
 * `mysql2`'s default of 10 applies.
 *
 * `connectTimeout` bounds the wait for a connection, defaulting to 10s. A host that accepts the
 * socket and never sends its handshake fails there instead of hanging the open.
 */
export async function createMysqlPool(
  url: string,
  options: { connectionLimit?: number; connectTimeout?: number } = {},
): Promise<MysqlPool> {
  // The module name lives in a variable so the type-checker does not resolve the driver at build
  // time. `@vite-ignore` tells a bundler the same thing (leave it a runtime import). mysql2 is a
  // server-only driver consumers externalize, never bundled.
  const specifier = 'mysql2/promise';
  const mysql = (await import(/* @vite-ignore */ specifier)) as unknown as {
    createPool(config: unknown): MysqlPool;
  };
  return mysql.createPool({
    uri: url,
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false,
    ...(options.connectionLimit
      ? { connectionLimit: options.connectionLimit }
      : {}),
    connectTimeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
    // Pin the connection collation to MySQL 8's utf8mb4 default: JSON_TABLE strings inside post_entry
    // take the connection's collation, and mysql2's default utf8mb4_unicode_ci clashes with the
    // utf8mb4_0900_ai_ci table columns on every join ("Illegal mix of collations"). applyMysqlSchema
    // pins the database default to the same collation.
    charset: 'UTF8MB4_0900_AI_CI',
  });
}

/** Everything {@link mysql} accepts beyond the connection URL. */
export interface MysqlOptions {
  /** Caps the pool. Size it to at least the number of concurrent submits. */
  poolMax?: number;
  /** Bounds the wait for a connection, in milliseconds. */
  connectTimeoutMs?: number;
  /** Hash service for chain links; defaults to the deterministic web-standard SHA-256. */
  digest?: Digest;
  /** Time source for `postedAt` and window math; defaults to wall-clock time. */
  clock?: Clock;
  /** Rolling window (ms) the trust store sums recent spend over. Defaults to one hour. */
  velocityWindowMs?: number;
  meter?: Meter;
  logger?: Logger;
}

/**
 * Build a {@link Store} backed by MySQL from a connection URL alone. The pool, the schema gate,
 * and the money-routine install and proof all happen inside, in that order, so a returned store
 * is already known to match this build's schema and arithmetic.
 *
 * Opened from a URL, the pool is this factory's: `close()` ends it, and an open that rejects has
 * already ended it, so a failed call leaves no connection behind.
 *
 * Pass `{ pool }` in place of the URL when the caller owns the wire — a `mysql2` pool, or the
 * pipelining `mariadb` one. The open-path checks still run, and that pool stays the caller's:
 * `close()` leaves it open for them to end.
 *
 * @example
 * const store = await mysql('mysql://econ:secret@127.0.0.1:3306/economy', { poolMax: 32 });
 * // ... on shutdown:
 * await store.close();
 */
export function mysql(url: string, options?: MysqlOptions): Promise<Store>;
export function mysql(
  options: MysqlOptions & { pool: MysqlPool },
): Promise<Store>;
export async function mysql(
  source: string | (MysqlOptions & { pool: MysqlPool }),
  options: MysqlOptions = {},
): Promise<Store> {
  if (typeof source !== 'string') {
    // A caller-owned pool still passes the open-path checks. The escape hatch is the wire, not
    // the trust.
    await verifySchemaAndMoney(source.pool);
    return buildMysqlStore({ ...source, pool: source.pool }, null, true);
  }
  const url = source;
  const pool = await createMysqlPool(url, {
    ...(options.poolMax ? { connectionLimit: options.poolMax } : {}),
    ...(options.connectTimeoutMs
      ? { connectTimeout: options.connectTimeoutMs }
      : {}),
  });
  // A caller that only sees the throw has no handle to end the pool with, so end it here and let
  // a failure to end it lose to the original error.
  try {
    await verifySchemaAndMoney(pool);
  } catch (error) {
    await endOwnedPool(pool, 'mysql', 'open').catch(() => {});
    throw error;
  }
  // This branch opened the pool, so this branch is the one that records owning it.
  return buildMysqlStore(
    {
      pool,
      digest: options.digest,
      clock: options.clock,
      velocityWindowMs: options.velocityWindowMs,
      meter: options.meter,
      logger: options.logger,
    },
    pool,
    true,
  );
}

function moneyRunner(exec: MysqlExecutor): SqlRunner {
  return {
    run: (sql: string, params?: readonly unknown[]) =>
      exec
        .query(sql, params ? [...params] : undefined)
        .then(([rows]) => rows as Record<string, unknown>[]),
  };
}

// How long a booter waits for whoever is installing, in seconds. The install is a handful of DDL
// statements, so a wait this long means the holder is wedged rather than slow.
const INSTALL_LOCK_TIMEOUT_S = 30;

// MySQL named locks are server-wide rather than per-database, so the name carries the schema. Two
// isolated databases on one server then install concurrently instead of queueing behind each other.
const INSTALL_LOCK_NAME = "concat(database(), ':money-install')";

// Runs `work` as the only session installing into this database. GET_LOCK is bound to a connection,
// so the whole critical section rides one borrowed connection and releases the lock even when
// `work` throws. Unlike takeGetLock, a non-acquire is not thrown: this is a boot path with no
// transaction to retry, and a caller that could not wait its turn falls through to `work` anyway —
// which is the unlocked behaviour this replaced, so waiting is never worse than not waiting.
async function withInstallLock(
  pool: MysqlPool,
  work: (exec: MysqlExecutor) => Promise<void>,
): Promise<void> {
  const connection = await pool.getConnection();
  let held = false;
  try {
    const acquired = await rows(
      connection,
      `SELECT GET_LOCK(${INSTALL_LOCK_NAME}, ?) AS acquired`,
      [INSTALL_LOCK_TIMEOUT_S],
    );
    held = Number(acquired[0]?.acquired) === 1;
    await work(connection);
  } finally {
    if (held) {
      await connection
        .query(`SELECT RELEASE_LOCK(${INSTALL_LOCK_NAME})`)
        .catch(() => {});
    }
    connection.release();
  }
}

// Make the engine prove it computes the pinned arithmetic before any posting trusts it, and install
// the vendored money routines when it does not. Every path that builds a store runs this, the sync
// one lazily; only the schema stamp is skippable.
//
// The proof comes first because the install is destructive. MySQL has no CREATE OR REPLACE for a
// stored function, so installing means `drop function` then `create function`, and a caller landing
// in that window sees `FUNCTION <db>.money_div_round does not exist`. Proving first means an
// already-installed database is opened with no data-definition statement at all, so opening a store
// cannot break a store that is already running. proveMysql answers the whole question in one pass:
// it reads the money_meta stamp, refuses a version this build does not expect, and calls both
// routines, so a stamp written without its routines fails it rather than passing a version check.
async function installAndProveMoney(pool: MysqlPool): Promise<void> {
  const runner = moneyRunner(pool);
  if ((await proveMysql(runner, moneyVectors)).length === 0) {
    return;
  }
  await withInstallLock(pool, async (exec) => {
    const held = moneyRunner(exec);
    // Re-proved under the lock: whoever held it before us may have just installed, and then this
    // booter has nothing to do.
    if ((await proveMysql(held, moneyVectors)).length === 0) {
      return;
    }
    await installMoneyRetrying(() => installMysql(held));
    assertMoneyConformant(await proveMysql(held, moneyVectors), 'MySQL');
  });
}

// The open-path checks, in trust order: refuse a database whose schema drifted from this code,
// then prove its arithmetic.
async function verifySchemaAndMoney(pool: MysqlPool): Promise<void> {
  assertSchemaCurrent(await readSchemaVersion(pool), 'MySQL');
  await installAndProveMoney(pool);
}

/**
 * The shared field vocabulary for opening a SQL engine, with the pool type bound to this
 * driver's {@link MysqlPool}. {@link mysqlStore} implements the MySQL subset (it takes a pre-built `pool` rather than
 * opening by `url`, and has no `schemaName` isolation).
 */
export type EngineOpenOptions = EngineOpenShape<MysqlPool>;
