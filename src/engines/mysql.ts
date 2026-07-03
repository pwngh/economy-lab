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

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chainHash, balanceDelta, GENESIS } from '#src/ledger.ts';
import {
  toAmount,
  encodeAmount,
  decodeAmountWire,
  isAmount,
} from '#src/money.ts';
import { currency, baseOf } from '#src/accounts.ts';
import { byCodeUnit, fromHex } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { systemClock } from '#src/runtime.ts';
import {
  callProcedure,
  callFunction,
  postEntryArgs,
} from '#src/engines/sql-routines.ts';
import {
  defaultDigest,
  GENESIS_HEX,
  CHAIN_FORK_INDEX,
  CHAIN_CONTINUITY_MARKER,
  readMinor,
  distinctAccounts,
  rowToSaga,
  rowToSubscription,
  rowToCheckpoint,
  withTransientRetry,
  isSeededSystemAccount,
} from '#src/engines/sql-shared.ts';
import { metaString, metaNumber } from '#src/meta.ts';

import type { Link } from '#src/engines/sql-shared.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Operation, Transaction } from '#src/contract.ts';
import type {
  Attempt,
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
  OutboxMessage,
  OutboxStore,
  Posting,
  PromoGrant,
  PromoStore,
  Range,
  ReplayStore,
  Saga,
  SagaState,
  SaleStore,
  Sale,
  SagaStore,
  Statement,
  Store,
  StoredLink,
  SubscriptionStore,
  TimelineOptions,
  TrustStore,
  Unit,
  Velocity,
} from '#src/ports.ts';

// --- mysql2/promise driver shape, declared by hand --------------------------------

// Only the methods this file calls. mysql2 is an optional dependency that may be absent, so
// importing its types would break type-checking when it isn't installed.
//
// `query` returns a two-element array: a SELECT puts rows in the first slot, an
// INSERT/UPDATE/DELETE puts a result-summary object with `affectedRows`. Both are typed
// `unknown`; each caller casts to the shape it expects.
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
interface MysqlConnection extends MysqlExecutor {
  release(): void;
}
export interface MysqlPool extends MysqlExecutor {
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

interface ExecDeps {
  exec: MysqlExecutor;
  digest: Digest;
  clock: Clock;
  // The store's pool, for statements that must commit outside `exec`'s transaction (plantAndLock
  // creates first-use rows there). In the non-transactional unit, `exec` is the pool itself.
  pool: MysqlPool;
}

async function rows(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<Row[]> {
  const [result] = await exec.query(sql, params);
  return result as Row[];
}

// Run an INSERT/UPDATE/DELETE and return affectedRows. MySQL has no RETURNING, so this count
// is the only signal of whether a conditional UPDATE matched: a WHERE matching nothing reports 0.
async function execWrite(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<number> {
  const [header] = await exec.query(sql, params);
  return (header as ResultHeader).affectedRows ?? 0;
}

// Takes a MySQL named lock and throws if it is not granted. GET_LOCK returns 1 (acquired), 0 (the
// wait elapsed), or NULL (error or killed). A 0 or a NULL means we do not hold the lock. Going on
// anyway would let two writers touch the same row at once, the corruption the lock exists to
// prevent. Postgres' `for update` blocks until granted instead. To keep that same "returns only
// once the lock is held" contract, this surfaces a non-acquire as a transient lock-wait conflict.
// It uses errno 1205, the code a real InnoDB lock-wait timeout carries, so that isTransientConflict
// classifies it and withTransientRetry re-runs it in a fresh transaction.
async function takeGetLock(exec: MysqlExecutor, name: string): Promise<void> {
  const result = await rows(exec, 'SELECT GET_LOCK(?, 10) AS acquired', [name]);
  if (Number(result[0]?.acquired) !== 1) {
    throw Object.assign(new Error(`GET_LOCK did not acquire: ${name}`), {
      errno: 1205,
    });
  }
}

// --- The ledger store -------------------------------------------------------------

// Store methods below omit the interface's optional trailing `options` params: never read here,
// and structural typing accepts a function with fewer trailing optional params.

// Reports whether an account may appear in a posting. A valid account is either a user account (an id
// ending in ':spendable', ':earned', or ':promo') or a platform account already in `accounts`
// (inserted at schema setup). Anything else makes postEntry raise UNKNOWN_ACCOUNT.
async function isKnownAccount(
  exec: MysqlExecutor,
  account: AccountRef,
): Promise<boolean> {
  const colon = account.lastIndexOf(':');
  if (colon >= 0) {
    const suffix = account.slice(colon + 1);
    if (suffix === 'spendable' || suffix === 'earned' || suffix === 'promo') {
      return true;
    }
  }
  // A schema-seeded system account, or a shard of one, is confirmed without a round trip — the
  // bare row always exists and a shard row is created on first use (post_entry's INSERT IGNORE);
  // only a genuinely unknown id falls through to the existence query.
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

// Reads the head hash of each account's chain in one query. `account_balances.head_hash` is the
// maintained head pointer. post_entry advances it to the account's new link hash in the same
// transaction that writes chain_links, so this is an O(1) primary-key read per account. Accounts
// with no balance row are absent from the result, and the caller treats a missing account as the
// genesis hash (a new account's head). The chain_links table stays the source of truth, since
// prove() still re-walks it, so a head pointer that drifts from the chain surfaces there.
//
// It locks the rows (`FOR UPDATE`) so this is a locking read of the latest committed head,
// a guarantee that holds at any isolation level. A stale head would fork the chain on
// chain_links_account_prev_uq (errno 1062) and cost a retry. lockAccounts already holds these
// rows, so the lock is free here.
async function headsForAccounts(
  exec: MysqlExecutor,
  accounts: ReadonlyArray<AccountRef>,
): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  if (accounts.length === 0) {
    return heads;
  }
  const marks = accounts.map(() => '?').join(', ');
  const found = await rows(
    exec,
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

// Computes the new chain link for every account a posting touches. Reads all current head hashes in
// one query. Then chainHash (ledger.ts) derives each account's new hash from that previous hash plus
// the posting details. The previous hash arrives as hex and is decoded back to bytes, except for a
// first-ever posting, whose predecessor is the raw genesis bytes. Hashes are independent across
// accounts, so batching the reads does not change the result.
async function advanceChain(
  deps: ExecDeps,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  const accounts = distinctAccounts(posting.legs);
  const heads = await headsForAccounts(deps.exec, accounts);
  const links: Link[] = [];
  for (const account of accounts) {
    const prevHex = heads.get(account) ?? GENESIS_HEX;
    const accountPrevHash =
      prevHex === GENESIS_HEX ? GENESIS : fromHex(prevHex);
    const hash = await chainHash(deps.digest, {
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

// Writes a posting and everything derived from it: the posting row, all legs, one chain-link row per
// distinct account touched (old and new chain hashes), and the per-leg balance update.
//
// Legs are stored one row per leg, since lineageOf re-derives a hash from the full leg set. Chain
// links are stored once per distinct account, not per leg. The database lets a given previous-hash
// be extended only once, so a per-leg link would make a legitimate second leg to the same account
// look like a second extension of the same prev-hash and would be rejected. advanceChain already
// returns one link per distinct account, so `links` matches chain_links exactly.
async function insertPosting(
  deps: ExecDeps,
  posting: Posting,
): Promise<Transaction> {
  const postedAt = deps.clock.now();
  const links = await advanceChain(deps, posting);

  // One CALL persists the whole posting. The application has already decided everything: the chain
  // hashes, the per-account net balance deltas, and which user accounts are new. `post_entry` then
  // writes the posting, legs, chain links, and balance changes as one set-based unit in this
  // transaction. The JSON arrays carry the bigint amounts as strings to keep values past 2^53.
  const args = postEntryArgs(posting, links);
  // postEntryArgs collects only first-use user accounts. A platform shard (`platform:revenue#3`)
  // is also created on first use — the schema seeds just the bare ids — so add each one with kind
  // `system` and its parent's currency; post_entry's INSERT IGNORE makes repeats free. At one
  // shard no shard ref appears in a posting, so this adds nothing.
  for (const account of distinctAccounts(posting.legs)) {
    if (baseOf(account) !== account && isSeededSystemAccount(account)) {
      args.newAccounts.push({
        id: account,
        kind: 'system',
        currency: currency(account),
      });
    }
  }
  await callProcedure(mysqlQuery(deps.exec), 'mysql', 'post_entry', [
    posting.txnId,
    postedAt,
    JSON.stringify(posting.meta),
    JSON.stringify(args.legs),
    JSON.stringify(args.links),
    JSON.stringify(args.balances),
    JSON.stringify(args.newAccounts),
  ]);
  return { id: posting.txnId, postedAt, legs: posting.legs, links };
}

// Adapt the executor to the query function the shared routine surface expects: positional `?`
// params, rows returned under a `rows` key.
function mysqlQuery(exec: MysqlExecutor) {
  return async (sql: string, params: ReadonlyArray<unknown>) => ({
    rows: (await rows(exec, sql, params)) as ReadonlyArray<
      Record<string, unknown>
    >,
  });
}

// NOTE: creating a first-time user account's `accounts` row happens inside the `post_entry` stored
// procedure (db/mysql-schema.sql), from the new-accounts list the application computes (see
// postEntryArgs in sql-routines.ts). MySQL's `lock` uses a named lock (GET_LOCK), not a row, so it
// needs no account row up front the way the Postgres engine's row lock does.

// NOTE: the per-account balance fold (UPDATE existing rows first so the non-negative CHECK tests
// the new total, then INSERT first-time rows) lives inside the `post_entry` stored procedure
// (db/mysql-schema.sql), which applies every account's net delta in one set-based step. The
// application decides each delta via `balanceDelta` (see postEntryArgs in sql-routines.ts); the
// procedure only persists it.

// The accounts-row kind for an id: 'system' for platform accounts (shards included), else the
// wallet suffix ('spendable' | 'earned' | 'promo').
function rowKind(account: AccountRef): string {
  if (account.startsWith('platform:')) {
    return 'system';
  }
  return account.slice(account.lastIndexOf(':') + 1);
}

// lockMany's body: create any missing balance rows first, then lock the whole set in one ordered
// FOR UPDATE. A row has to exist before it can be locked, so first-use accounts get a placeholder
// row here. The plant runs on the pool, not in the transaction: locking a missing key inside the
// transaction takes a gap lock, and a burst of new accounts (neighboring ids, one shared gap)
// would deadlock on each other's inserts. A pool statement commits and releases its locks
// immediately.
//
// A planted row therefore stays even if the operation rolls back. It is the same placeholder the
// schema seeds for system accounts — zero balance, genesis head — which every reader treats
// like no row at all.
async function plantAndLock(
  deps: ExecDeps,
  accounts: ReadonlyArray<AccountRef>,
): Promise<void> {
  if (accounts.length === 0) {
    return;
  }
  const marks = accounts.map(() => '?').join(', ');
  const found = await rows(
    deps.pool,
    `SELECT account_id FROM account_balances
      WHERE account_id IN (${marks})`,
    [...accounts],
  );
  const have = new Set(found.map((row) => row.account_id as string));
  // Sorted so concurrent plants insert in the same order and can't deadlock each other.
  const missing = accounts
    .filter((account) => !have.has(account))
    .sort(byCodeUnit);
  if (missing.length > 0) {
    // INSERT IGNORE, so losing a plant race is fine: the row is there either way.
    await execWrite(
      deps.pool,
      `INSERT IGNORE INTO accounts (id, kind, currency)
        VALUES ${missing.map(() => '(?, ?, ?)').join(', ')}`,
      missing.flatMap((a) => [a, rowKind(a), currency(a)]),
    );
    await execWrite(
      deps.pool,
      `INSERT IGNORE INTO account_balances (account_id, currency, balance, head_hash)
        VALUES ${missing.map(() => `(?, ?, 0, REPEAT('0', 64))`).join(', ')}`,
      missing.flatMap((a) => [a, currency(a)]),
    );
  }
  // Every row exists now, so this takes plain record locks, in account_id order.
  await rows(
    deps.exec,
    `SELECT account_id FROM account_balances
      WHERE account_id IN (${marks})
      ORDER BY account_id
        FOR UPDATE`,
    [...accounts],
  );
}

function createLedgerStore(deps: ExecDeps): Ledger {
  return {
    hasAccount: async (account) => isKnownAccount(deps.exec, account),

    // Named lock on an account so concurrent transactions touching it run one at a time. Lock name
    // derived from the account id. The same connection can re-take the same named lock without
    // blocking on itself, so locking one account twice is safe. Dropped on commit or rollback.
    lock: (account) => takeGetLock(deps.exec, lockName(account)),

    // Batched twin of `lock`: row-locks every touched balance row in one ordered statement, so
    // InnoDB acquires them in one global order (GET_LOCK above does not pin rows). The MySQL
    // counterpart to Postgres' `lockMany`.
    lockMany: (accounts) => plantAndLock(deps, accounts),

    append: async (posting) => insertPosting(deps, posting),

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

    timeline: (account, options) => timelineOf(deps.exec, account, options),

    heads: async function* () {
      // MySQL has no DISTINCT ON, so this MAX(seq)-per-account subquery + join is the portable equivalent.
      const result = await rows(
        deps.exec,
        `SELECT c.account_id, c.hash FROM chain_links c
           JOIN postings p ON p.id = c.posting_id
           JOIN (
             SELECT c2.account_id AS account_id, MAX(p2.seq) AS max_seq
               FROM chain_links c2
               JOIN postings p2 ON p2.id = c2.posting_id
              GROUP BY c2.account_id
           ) tip ON tip.account_id = c.account_id AND tip.max_seq = p.seq`,
      );
      // Code-unit order in the app (not the DB's collation) so every engine lists accounts identically.
      result.sort((a, b) =>
        byCodeUnit(a.account_id as string, b.account_id as string),
      );
      for (const row of result) {
        yield [row.account_id as AccountRef, row.hash as string] as const;
      }
    },

    balanceAccounts: async function* () {
      // The seeded house-account placeholder (genesis head, zero balance, planted so the first lock has a
      // row to grab) is excluded -- it reads like no row -- except `OR balance <> 0` catches the very
      // drift this scan hunts: a placeholder that gained a balance.
      const result = await rows(
        deps.exec,
        `SELECT account_id FROM account_balances WHERE head_hash <> REPEAT('0', 64) OR balance <> 0`,
      );
      // Code-unit order in the app (not the DB's collation) so every engine lists accounts identically.
      result.sort((a, b) =>
        byCodeUnit(a.account_id as string, b.account_id as string),
      );
      for (const row of result) {
        yield row.account_id as AccountRef;
      }
    },

    lineage: (account) => lineageOf(deps.exec, account),

    posting: (txnId) => postingOf(deps.exec, txnId),

    list: () => listPostingsOf(deps.exec),
  };
}

// Maps an account id to a MySQL named-lock name. MySQL caps lock names at 64 bytes, so for a longer
// id this uses a fixed-length prefix plus the id's full length. Appending the length keeps two ids
// that share a prefix from colliding on one lock.
function lockName(account: AccountRef): string {
  return account.length <= 56
    ? account
    : `${account.slice(0, 48)}#${account.length}`;
}

// Builds a statement for an account over a time range (start inclusive, end exclusive). Each entry's
// amount is the effect on this account's balance, so money into a user account reads positive.
// Conformance fixtures fit one page, so there is no next-page cursor.
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
      ORDER BY p.posted_at, l.id`,
    [account, range.from, range.to],
  );
  const entries = result.map((row) => ({
    txnId: row.txn_id as string,
    amount: naturalDelta(account, row),
    postedAt: Number(row.posted_at),
  }));
  return { account, entries, cursor: null };
}

// Streams an account's incoming funds as dated lots (one per posting that increased the balance,
// skipping spends) for the maturity logic; a posting with no source/maturity falls back to "unknown"
// and mature-now. Ordered by `l.id` (legs.id, an AUTO_INCREMENT) not `p.seq`, so the composite index
// `legs(account_id, id)` serves `ORDER BY id DESC LIMIT n` as a bounded keyed scan with no filesort
// (an `ORDER BY p.seq` would join and sort every leg); the two share commit order, so for one account
// this is the same FIFO order. Spends are filtered in code, so the lot offset/limit apply after that.
// @see https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/
async function* timelineOf(
  exec: MysqlExecutor,
  account: AccountRef,
  options?: TimelineOptions,
): AsyncIterable<Lot> {
  const direction = options?.order === 'desc' ? 'DESC' : 'ASC';
  const lotOffset = options?.offset ?? 0;
  const lotLimit = options?.limit ?? Infinity;

  const pageSize = Number.isFinite(lotLimit)
    ? Math.max(lotOffset + lotLimit, 1)
    : 256;

  let skipped = 0;
  let yielded = 0;
  for (let rowOffset = 0; yielded < lotLimit; rowOffset += pageSize) {
    const result = await rows(
      exec,
      `SELECT p.id AS txn_id, p.meta AS meta, l.currency AS currency,
              l.amount AS amount, p.posted_at AS posted_at
         FROM legs l JOIN postings p ON l.posting_id = p.id
        WHERE l.account_id = ?
        ORDER BY l.id ${direction}
        LIMIT ? OFFSET ?`,
      [account, pageSize, rowOffset],
    );
    if (result.length === 0) {
      return;
    }
    for (const row of result) {
      const delta = naturalDelta(account, row);
      if (delta.minor <= 0n) {
        continue;
      }
      if (skipped < lotOffset) {
        skipped += 1;
        continue;
      }
      if (yielded >= lotLimit) {
        return;
      }
      yielded += 1;
      const meta = parseMeta(row.meta);
      yield {
        txnId: row.txn_id as string,
        amount: delta,
        source: metaString(meta, 'source', 'unknown'),
        toppedUpAt: Number(row.posted_at),
        maturesAt: metaNumber(meta, 'maturesAt', Number(row.posted_at)),
      };
    }
    if (result.length < pageSize) {
      return;
    }
  }
}

// Streams an account's history in a form the chain verifier can re-hash. For each posting that
// touched the account, in commit order, this yields the posting's legs and metadata as written, plus
// the account's head hash before and after. The verifier recomputes the "after" hash from the legs
// and metadata and checks that it still matches.
async function* lineageOf(
  exec: MysqlExecutor,
  account: AccountRef,
): AsyncIterable<StoredLink> {
  const postings = await rows(
    exec,
    `SELECT c.posting_id AS txn_id, p.meta AS meta,
            c.prev_hash AS prev_hash, c.hash AS hash
       FROM chain_links c JOIN postings p ON p.id = c.posting_id
      WHERE c.account_id = ?
      ORDER BY p.seq ASC`,
    [account],
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

// All legs of the posting, not just the verified account's -- the hash recompute selects its own.
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

// Batched twin of legsOf: load every leg of many postings in one round trip, grouped by posting id in
// the same `ORDER BY id` legsOf uses, so the audit/lineage paths (lineageOf, listPostingsOf) expand N
// postings without N legsOf queries. Each Leg is rebuilt exactly as legsOf does, so the batched and
// per-posting paths return byte-identical legs and the recomputed chain hashes are unchanged.
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

// Loads one whole posting by txn id with all its legs (not filtered to one account, unlike
// lineageOf). `reverse` reads this to post the exact opposite entry. Metadata comes from the posting
// row, and the legs come from legsOf. Returns null when no posting has that id.
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

// Streams every posting, newest commit first (see Ledger.list). It orders by `seq` DESC, the
// ever-increasing commit number (`AUTO_INCREMENT UNIQUE`, a single indexed access path). That is a
// total order with no tie to break, the SQL mirror of `payout_sagas ORDER BY updated_at DESC`. Each
// posting carries its full legs, the way postingOf returns them, so a reader can expand a row without
// a second round-trip.
async function* listPostingsOf(exec: MysqlExecutor): AsyncIterable<Posting> {
  const postings = await rows(
    exec,
    'SELECT id, meta FROM postings ORDER BY seq DESC',
  );
  // One batched legs read instead of a legsOf round trip per posting (the same N+1 fold as lineageOf).
  // ledger.list() consumers buffer the whole stream, so reading the legs up front changes nothing they
  // observe.
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

// Computes how much a stored leg changed its account's balance. Leg amounts use a shared sign
// convention (positive for a debit). This rebuilds the leg and applies the account's sign rule: some
// accounts go up on a debit, others on a credit.
function naturalDelta(account: AccountRef, row: Row): Amount {
  const leg: Leg = {
    account,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  };
  return balanceDelta(leg);
}

// --- Idempotency store ------------------------------------------------------------

// Makes a request safe to retry: a key (the `idempotency` primary key) is processed at most once and
// a retry returns the original result. `claim` is the gate: the first caller inserts a placeholder
// row (no result) and proceeds; a later same-key caller either gets the saved result back, or blocks
// on the placeholder row (locked by the unfinished transaction) until that call commits or rolls
// back. A rollback drops the placeholder with it, so a failed attempt frees the key for a real retry.
//
// The claim is a single atomic `INSERT IGNORE` of the placeholder, not a `SELECT ... FOR UPDATE`
// then `INSERT`. A read-then-write would take an exclusive *gap lock* when the `FOR UPDATE` probes
// a not-yet-present key, and two concurrent claims whose keys fall in the same index gap would then
// deadlock on each other's insert-intention lock -- the dominant InnoDB deadlock shape (err 1213)
// under concurrency, since every op claims a key. `INSERT IGNORE` takes only an insert-intention
// lock (which does not conflict with another insert-intention), so claims of distinct keys never
// deadlock, while a claim that collides with an *in-flight* holder still blocks on that row's lock
// until the holder commits or rolls back -- the exactly-once wait, with no gap lock.
// @see https://economy-lab-docs.pages.dev/economy/concepts/idempotency/
function createIdempotencyStore(exec: MysqlExecutor): IdempotencyStore {
  return {
    claim: async (key) => {
      // affectedRows: 1 means we inserted the placeholder and won the claim. 0 means the key
      // exists and its holder has committed: a still-uncommitted holder would have blocked this
      // INSERT IGNORE on its row lock, and a rolled-back one would have freed the key so the
      // insert succeeded. So on 0, replay the recorded result.
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
      // The row exists with no recorded result yet (a placeholder this same caller is re-claiming, or
      // the rare committed-but-unrecorded placeholder). Either way it is ours to proceed on, matching
      // the in-memory reference, which treats any non-committed key as claimable.
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
  };
}

// --- Sale store -------------------------------------------------------------------

// Records each completed sale, keyed by order id. Separate from the idempotency key above: it
// stores the sale's details (including the exact ledger legs) so a later refund can look it up
// by order id and reverse precisely what was posted.
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
      return found.length ? rowToSale(found[0]!) : null;
    },
  };
}

// --- Outbox store -----------------------------------------------------------------

// The transactional-outbox sub-store: `enqueue` saves the event in the same transaction as the
// money posting, a relay later picks up a batch of pending events (`claimBatch`), and FOR UPDATE
// SKIP LOCKED lets several relay workers grab different rows at once.
// See https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ for the outbox
// pattern (write-with-the-transaction, relay-later, dedupe-by-id).
function createOutboxStore(exec: MysqlExecutor): OutboxStore {
  return {
    enqueue: async (message) => {
      await rows(
        exec,
        `INSERT INTO outbox (id, event, status, attempts) VALUES (?, ?, ?, ?)`,
        [
          message.id,
          JSON.stringify(message.event),
          message.status,
          message.attempts,
        ],
      );
    },
    claimBatch: async (limit) => {
      const result = await rows(
        exec,
        `SELECT id, event, status, attempts, dead_letter_reason FROM outbox
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
      // The `AND status = 'pending'` guard stops a stale resend from flipping a row that has since
      // been dead-lettered (or already relayed) back to 'relayed'. It is the same terminal-state guard
      // recordFailure uses and the in-memory reference applies (which skips any non-'pending' row).
      const placeholders = ids.map(() => '?').join(', ');
      await rows(
        exec,
        `UPDATE outbox SET status = 'relayed'
          WHERE id IN (${placeholders}) AND status = 'pending'`,
        [...ids],
      );
    },
    // Record a failed delivery: bump `attempts` and leave the row pending so the next sweep
    // retries it. Same terminal-state guard as markSent above.
    recordFailure: async (id) => {
      await rows(
        exec,
        "UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Give up on a poison message: flip to 'dead' so claimBatch never hands it back, keep the
    // reason for operators. Same terminal-state guard as markSent above.
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE outbox SET status = 'dead', dead_letter_reason = ? WHERE id = ? AND status = 'pending'",
        [reason, id],
      );
    },
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox. `enqueueInbound` saves the row in the same transaction as the
// webhook ingress that claimed it, and dedupes on `key` (the provider event id, UNIQUE in SQL): a
// redelivered event is a no-op insert that returns the existing row. A separate apply worker later
// claims a batch of pending rows (`claimInbound`), and FOR UPDATE SKIP LOCKED lets several workers
// grab different rows at once.
// See https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ for the inbox pattern
// (record-in-the-ingress-transaction, apply-later, dedupe-by-id).
function createInboxStore(exec: MysqlExecutor): InboxStore {
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
    // Pending rows oldest received_at first, capped at `limit`, row-locked for this worker. FOR
    // UPDATE SKIP LOCKED lets overlapping apply workers grab disjoint batches. `input.now` is
    // accepted for parity with the saga/relay claim; the inbox has no due-time gate, so every
    // pending row is immediately claimable.
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
    // Flip a still-pending row to 'applied' so claimInbound never hands it back. Same
    // terminal-state guard as the outbox's markSent: a missing or already-terminal row is a no-op.
    markApplied: async (id) => {
      await rows(
        exec,
        "UPDATE inbox SET status = 'applied' WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Record a failed apply: bump `attempts` and leave the row pending so the next sweep retries
    // it. Same terminal-state guard as markApplied; only deadLetter ever changes status.
    bumpAttempt: async (id) => {
      await rows(
        exec,
        "UPDATE inbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Give up on a poison event: flip to 'dead' so claimInbound never hands it back, keep the
    // reason for operators. Same terminal-state guard as markApplied.
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE inbox SET status = 'dead', dead_letter_reason = ? WHERE id = ? AND status = 'pending'",
        [reason, id],
      );
    },
  };
}

// --- Saga store -------------------------------------------------------------------

// Streams the whole payout board, newest first (see SagaStore.list). This is a read-only
// enumeration, so it takes no FOR UPDATE, matching postgres. `rows` returns everything in one round
// trip, yielded one at a time so a consumer can stop early. It is module-level (like loadSagaOrThrow)
// to keep createSagaStore short.
async function* listSagasOf(exec: MysqlExecutor): AsyncIterable<Saga> {
  for (const row of await rows(
    exec,
    'SELECT * FROM payout_sagas ORDER BY updated_at DESC',
  )) {
    yield rowToSaga(row);
  }
}

// Tracks each payout as a small state machine ("saga"). `advance` changes state only if the
// saga is still in the state the caller expected (the UPDATE's WHERE requires current state =
// `from`). If two workers advance the same saga at once, only one matches a row; the other
// changes zero rows and learns it lost, so a payout can't advance twice.
function createSagaStore(exec: MysqlExecutor): SagaStore {
  return {
    open: async (saga) => {
      await rows(
        exec,
        `INSERT INTO payout_sagas
           (id, user_id, reserve, rate_id, state, provider_ref, attempts, due_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id), reserve = VALUES(reserve),
           rate_id = VALUES(rate_id), state = VALUES(state),
           provider_ref = VALUES(provider_ref), attempts = VALUES(attempts),
           due_at = VALUES(due_at), updated_at = VALUES(updated_at)`,
        [
          saga.id,
          saga.userId,
          saga.reserve.minor.toString(),
          saga.rateId,
          saga.state,
          saga.providerRef,
          saga.attempts,
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
    list: () => listSagasOf(exec),
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
    advance: (id, from, to, patch) =>
      advanceSaga(exec, { id, from, to, patch }),
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

// The compare-and-set state change behind SagaStore.advance: the UPDATE takes effect only if the
// saga is still in the state the caller expected (WHERE state = `from`), and a zero-row result
// tells the caller it lost the race. MySQL has no partial-UPDATE coalesce (the postgres twin
// does), so this read-modify-writes the whole row: a non-terminal advance re-writes
// payout_usd/reason from the loaded row, never disturbing them.
async function advanceSaga(
  exec: MysqlExecutor,
  input: { id: string; from: SagaState; to: SagaState; patch: Partial<Saga> },
): Promise<boolean> {
  const { id, from, to, patch } = input;
  const next = {
    ...(await loadSagaOrThrow(exec, id)),
    ...patch,
    state: to,
  };
  const affected = await execWrite(
    exec,
    `UPDATE payout_sagas SET
       reserve = ?, rate_id = ?, state = ?, provider_ref = ?,
       attempts = ?, due_at = ?, updated_at = ?, payout_usd = ?, reason = ?
     WHERE id = ? AND state = ?`,
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

// Loads a saga and throws if it is absent. `advance` calls this to get the current field values, then
// overlays the few it is changing. A missing saga here means a caller bug, since under normal use the
// saga exists by the time advance runs.
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

// Tracks what each user owns (entitlements). This is ownership state, not money movement, so it
// touches no ledger. `revoke` is a soft delete: it sets `revoked = true` and keeps the row, so the
// audit history a refund or clawback may need survives. A later re-grant clears `revoked` via the
// on-conflict path, so re-buying re-activates. `owns` honors expiry: owned while now <= expiresAt,
// lost once now > expiresAt, checked against the injected clock, matching the older reference.
function createEntitlementStore(deps: ExecDeps): EntitlementStore {
  const exec = deps.exec;
  return {
    grant: async (userId, sku, attrs) => {
      await rows(
        exec,
        `INSERT INTO entitlements (user_id, sku, quantity, version, expires_at, source, revoked)
         VALUES (?, ?, ?, ?, ?, ?, false)
         ON DUPLICATE KEY UPDATE
           quantity = VALUES(quantity), version = VALUES(version),
           expires_at = VALUES(expires_at), source = VALUES(source), revoked = false`,
        [
          userId,
          sku,
          attrs.quantity ?? 1,
          attrs.version ?? 1,
          attrs.expiresAt ?? null,
          attrs.source ?? null,
        ],
      );
    },

    revoke: async (userId, sku) => {
      await rows(
        exec,
        'UPDATE entitlements SET revoked = true WHERE user_id = ? AND sku = ?',
        [userId, sku],
      );
    },
    owns: async (userId, sku) => {
      // `expires_at IS NULL` is a perpetual grant; otherwise owned up to and including
      // `expiresAt` (>= now), expiring only once the clock passes it.
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
  };
}

// --- Subscription store -----------------------------------------------------------

// Tracks recurring subscriptions for the renewal job. It finds subscriptions whose next charge is due
// (`claimDue`), records a successful charge and schedules the next (`markBilled`), and ends one that
// cannot be funded (`markLapsed`) or that the user cancels.
function createSubscriptionStore(exec: MysqlExecutor): SubscriptionStore {
  return {
    open: async (sub) => {
      // The ON DUPLICATE KEY branch must overwrite `attempts` -- a re-open with attempts:n+1 that kept the
      // old count would never advance the retry cap.
      await rows(
        exec,
        `INSERT INTO subscriptions
           (id, user_id, seller_id, sku, price, period_ms, state, period, attempts, next_due_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           state = VALUES(state), period = VALUES(period), attempts = VALUES(attempts),
           next_due_at = VALUES(next_due_at), updated_at = VALUES(updated_at)`,
        [
          sub.id,
          sub.userId,
          sub.sellerId,
          sub.sku,
          sub.price.minor.toString(),
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
    // The one ACTIVE subscription for this (user, sku, seller) triple, or null. The subscribe
    // handler reads this to refuse a duplicate active subscription that would double-bill.
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
    cancel: async (id) => {
      await rows(
        exec,
        "UPDATE subscriptions SET state = 'CANCELED' WHERE id = ?",
        [id],
      );
    },
    // FOR UPDATE SKIP LOCKED, like the saga/promo claimDue, lets overlapping sweepers grab
    // disjoint batches instead of contending over the same due rows.
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
      // Compare-and-set on next_due_at = `expectedDueAt`: a worker that already billed this period moved the
      // date on, so the loser matches no row and never double-charges. attempts resets to 0 on success.
      const affected = await execWrite(
        exec,
        `UPDATE subscriptions SET next_due_at = ?, period = period + 1, attempts = 0
          WHERE id = ? AND next_due_at = ?`,
        [nextDueAt, id, expectedDueAt],
      );
      return affected > 0;
    },
    // End a subscription because a renewal charge couldn't be funded (distinct from the user
    // canceling). The UPDATE only applies while still active, so it moves active -> lapsed exactly
    // once; once lapsed it no longer matches the renewal job (active-only), so billing stops.
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

// Tracks each marketing promo grant so the promo-expiry sweep can reverse whatever the user has not
// spent once the grant expires. `grantPromo` records the grant here in the same transaction as the
// credit posting. The sweep later claims due grants oldest-first, reverses the unspent remainder,
// then marks each one reversed so it is not reversed twice.
function createPromoStore(exec: MysqlExecutor): PromoStore {
  return {
    // Idempotent on `id`: `ON DUPLICATE KEY UPDATE id = id` is the MySQL idempotent-insert idiom, a
    // no-op assignment that swallows the duplicate-key conflict without touching any column, so a
    // second open() leaves the original row untouched. Unlike the saga/subscription `open` upserts
    // above (which overwrite on conflict), a promo grant must not be clobbered.
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
    // The grants the sweep should act on: expired (`expires_at <= now`) and not yet reversed,
    // oldest `expires_at` first so the most overdue are reversed first, capped at `limit`.
    // FOR UPDATE SKIP LOCKED matches the saga/outbox claim queries so two sweeps grab
    // different grants.
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
    // Mark a grant reversed so `claimDue` never hands it back again. The `AND reversed = false`
    // guard is the outbox markSent terminal-state guard in boolean form.
    markReversed: async (id) => {
      await rows(
        exec,
        'UPDATE promo_grants SET reversed = true WHERE id = ? AND reversed = false',
        [id],
      );
    },
  };
}

// --- Trust store -------------------------------------------------------------------

// Records spending attempts per subject (a user or similar) to enforce spending-velocity limits.
// Two views share the helpers below: the pool-backed store commits on its own, and the Unit view
// writes inside the money transaction. `submit` combines them so a committed attempt shares the
// money commit and a rolled-back one still counts. `bump` uses each attempt's idempotency key as
// the primary key (INSERT IGNORE), so retrying the same attempt does not double-count. `read`
// sums a subject's recorded attempts.

// The windowed measure `read` and `record` share: only attempts newer than the cutoff are summed,
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
    // Record-and-measure atomically. Borrow one connection, take a per-subject named lock so two
    // concurrent same-subject calls serialize, insert the attempt, then measure, now including
    // this attempt. The lock is released and the connection returned in `finally`, so a borrower
    // never inherits a stale lock. Serializing the insert and SUM behind one lock gives the
    // atomicity `TrustStore.record` requires (ports.ts).
    record: async (subject, attempt) => {
      const cutoff = clock.now() - windowMs;
      const connection = await pool.getConnection();
      try {
        await takeGetLock(connection, subjectLockName(subject));
        await insertAttempt(connection, subject, attempt);
        return await measureVelocity(connection, subject, cutoff);
      } finally {
        await releaseLocks(connection);
        connection.release();
      }
    },
  };
}

// The transaction-scoped trust view a Unit carries. `record` runs on the money transaction's own
// connection, so the inserted attempt commits with the money. The named lock stays held until
// `transaction()` releases it after commit or rollback, and a concurrent same-subject `record`
// waits it out. That is the same per-subject serialization the pool-backed `record` gets from
// its borrowed connection.
function createUnitTrustStore(
  exec: MysqlExecutor,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    read: async (subject) =>
      measureVelocity(exec, subject, clock.now() - windowMs),
    bump: async (subject, attempt) => insertAttempt(exec, subject, attempt),
    record: async (subject, attempt) => {
      await takeGetLock(exec, subjectLockName(subject));
      await insertAttempt(exec, subject, attempt);
      return measureVelocity(exec, subject, clock.now() - windowMs);
    },
  };
}

// Maps a risk subject (a user id) to a MySQL named-lock name, so same-subject `record` calls
// serialize. It uses the same 64-byte cap and prefix#length scheme as `lockName`, kept separate so a
// subject lock cannot collide with an account lock of the same string.
function subjectLockName(subject: string): string {
  const tagged = `trust:${subject}`;
  return tagged.length <= 56
    ? tagged
    : `${tagged.slice(0, 48)}#${tagged.length}`;
}

// --- Checkpoint store (used only by background workers) ---------------------------

// Written on the pool, not in a money transaction, so a recorded checkpoint survives even if a later
// money transaction rolls back.
function createCheckpointStore(pool: MysqlPool): CheckpointStore {
  return {
    put: async (checkpoint) => {
      await rows(
        pool,
        `INSERT INTO checkpoints (id, root, signature, count, at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          checkpoint.id,
          checkpoint.root,
          checkpoint.signature,
          checkpoint.count,
          checkpoint.at,
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

// Makes processing an inbound provider webhook happen at most once, keyed by the provider's own
// event id (a separate id space from the application's idempotency keys). The webhook handler claims
// the `eventId` here only after checking the delivery is authentic and recent, as a standalone write
// on the pool, not inside a money transaction. So a rejected or forged delivery that never reaches
// this point can't use up the id, while a claim that does land stays recorded even if a later money
// posting rolls back.
//
// `claim` inserts the id only if not already present: `INSERT IGNORE` adds the row the first time
// and does nothing on a redelivery, rather than raising a duplicate-key error (same effect as the
// Postgres engine's `on conflict do nothing`). The driver reports affectedRows = 1 on the call
// that inserted and 0 on every later one, so the count distinguishes first delivery from duplicate.
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

function rowToSale(row: Row): Sale {
  return {
    orderId: row.order_id as string,
    buyerId: row.buyer_id as string,
    recipientId: (row.recipient_id as string | null) ?? undefined,
    sku: row.sku as string,
    price: toAmount('CREDIT', readMinor(row.price)),
    fee: toAmount('CREDIT', readMinor(row.fee)),
    legs: decodeLegs(
      parseJson(row.legs) as ReadonlyArray<{ account: string; amount: string }>,
    ),
    txnId: row.txn_id as string,
    postedAt: Number(row.posted_at),
  };
}

function rowToOutbox(row: Row): OutboxMessage {
  return {
    id: row.id as string,
    event: parseJson(row.event) as OutboxMessage['event'],
    status: row.status as OutboxMessage['status'],
    attempts: Number(row.attempts),
    reason: (row.dead_letter_reason as string | null) ?? null,
  };
}

function rowToInbox(row: Row): InboxEntry {
  return {
    id: row.id as string,
    key: row.key as string,
    operation: decodeOperation(parseJson(row.operation) as EncodedOperation),
    status: row.status as InboxEntry['status'],
    attempts: Number(row.attempts),
    receivedAt: Number(row.received_at),
    reason: (row.dead_letter_reason as string | null) ?? null,
  };
}

// JSON.stringify throws on the BigInt inside an Amount, so amounts are walked by brand and swapped for
// their `CREDIT:12.34` string. Same approach as encodeTransaction/decodeTransaction below.
type EncodedOperation = Record<string, unknown>;

function encodeOperation(operation: Operation): EncodedOperation {
  return encodeAmounts(operation) as EncodedOperation;
}

function decodeOperation(encoded: EncodedOperation): Operation {
  return decodeAmounts(encoded) as Operation;
}

// The Amount test comes first so an Amount (itself an object) is encoded, not walked field-by-field.
function encodeAmounts(value: unknown): unknown {
  if (isAmount(value)) {
    return encodeAmount(value);
  }
  if (Array.isArray(value)) {
    return value.map(encodeAmounts);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = encodeAmounts(inner);
    }
    return out;
  }
  return value;
}

// A string is decoded to an Amount only if it parses as `CURRENCY:decimal`; any other string passes
// through, so plain fields (idempotencyKey, sku, reason) are left alone.
function decodeAmounts(value: unknown): unknown {
  if (typeof value === 'string') {
    const amount = tryDecodeAmountString(value);
    return amount ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeAmounts);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = decodeAmounts(inner);
    }
    return out;
  }
  return value;
}

// A colon alone is not enough: decodeAmountWire throws on a non-numeric tail, and that throw is caught
// so a plain string containing a colon falls through to null instead of throwing.
function tryDecodeAmountString(encoded: string): Amount | null {
  const colon = encoded.indexOf(':');
  if (colon < 0) {
    return null;
  }
  try {
    return decodeAmountWire(encoded);
  } catch {
    return null;
  }
}

function rowToPromoGrant(row: Row): PromoGrant {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
    expiresAt: Number(row.expires_at),
    reversed: Boolean(row.reversed),
  };
}

// --- Converting money and JSON to and from stored form ----------------------------

// JSON.stringify cannot handle bigint, so amounts become decimal strings; this lets a stored
// transaction round-trip exactly for an idempotent replay.
function encodeTransaction(transaction: Transaction): string {
  return JSON.stringify({
    id: transaction.id,
    postedAt: transaction.postedAt,
    legs: encodeLegs(transaction.legs),
    links: transaction.links,
  });
}

function parseTransaction(value: unknown): Transaction {
  const parsed = parseJson(value) as {
    id: string;
    postedAt: number;
    legs: ReadonlyArray<{ account: string; amount: string }>;
    links: Transaction['links'];
  };
  return {
    id: parsed.id,
    postedAt: parsed.postedAt,
    legs: decodeLegs(parsed.legs),
    links: parsed.links,
  };
}

// Amount becomes a "CURRENCY:minor" string (e.g. "CREDIT:500") to keep the exact integer across JSON.
function encodeLegs(
  legs: ReadonlyArray<Leg>,
): ReadonlyArray<{ account: string; amount: string }> {
  return legs.map((leg) => ({
    account: leg.account,
    amount: `${leg.amount.currency}:${leg.amount.minor.toString()}`,
  }));
}

function decodeLegs(
  legs: ReadonlyArray<{ account: string; amount: string }>,
): ReadonlyArray<Leg> {
  return legs.map((leg) => {
    const colon = leg.amount.indexOf(':');
    const currencyTag = leg.amount.slice(0, colon) as Amount['currency'];
    const minor = BigInt(leg.amount.slice(colon + 1));
    return {
      account: leg.account as AccountRef,
      amount: toAmount(currencyTag, minor),
    };
  });
}

// mysql2 normally returns JSON columns already parsed; parse only if a driver config handed back a string.
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseMeta(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

// --- Grouping the stores into one transactional unit ------------------------------

// Bundles the stores a request handler may use, all sharing one database connection, so every write
// commits or rolls back together as one transaction. The trust and checkpoint stores are left out
// because they are written outside the money transaction (see their comments above).
// `trust` is passed in rather than built from deps. A transaction passes the transaction-scoped
// view. The non-transactional unit gets the pool-backed store instead, because a named lock
// taken through the pool would land on an arbitrary connection and never be released.
function buildUnit(deps: ExecDeps, trust: TrustStore): Unit {
  return {
    ledger: createLedgerStore(deps),
    idempotency: createIdempotencyStore(deps.exec),
    sales: createSaleStore(deps.exec),
    outbox: createOutboxStore(deps.exec),
    inbox: createInboxStore(deps.exec),
    sagas: createSagaStore(deps.exec),
    entitlements: createEntitlementStore(deps),
    subscriptions: createSubscriptionStore(deps.exec),
    promos: createPromoStore(deps.exec),
    trust,
  };
}

// --- The assembled store ----------------------------------------------------------

/**
 * Build the full MySQL-backed store on a `mysql2` connection pool the caller creates and owns.
 *
 * `transaction(work)` borrows one connection, wraps `work` in START TRANSACTION ... COMMIT, and
 * rolls back if `work` throws. On the way out it releases any named locks the connection acquired,
 * so a returned connection carries no leftover locks. Anything outside a transaction (plain
 * reads/writes, plus the trust and checkpoint stores) runs directly on the pool and commits on its
 * own.
 *
 * The hash service defaults to the deterministic web-standard SHA-256; the clock defaults to
 * wall-clock time. Pass a fixed clock when reproducible `postedAt` values matter.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage &
 *   messaging} for the store and outbox/inbox ports this backs.
 */
export function mysqlStore(deps: {
  pool: MysqlPool;
  digest?: Digest;
  clock?: Clock;
  velocityWindowMs?: number;
}): Store {
  const pool = deps.pool;
  const digest = deps.digest ?? defaultDigest();
  const clock = deps.clock ?? systemClock();
  const velocityWindowMs = deps.velocityWindowMs ?? 60 * 60_000;
  const poolDeps: ExecDeps = { exec: pool, digest, clock, pool };

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
    checkpoints: createCheckpointStore(pool),
    replay: createReplayStore(pool),

    // The whole unit of work lives in this one transaction, so a transient InnoDB abort (deadlock or
    // lock-wait timeout) committed nothing and withTransientRetry can re-run all of `work` in a fresh
    // connection + transaction, atomic and idempotency-safe. A true settle-vs-reverse conflict then
    // retries into a clean SAGA.INVALID_TRANSITION (the retried op reloads a now-terminal saga) rather
    // than escaping as a raw deadlock; any non-transient error propagates unchanged on its first throw.
    // @see https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/
    transaction: async (work) =>
      withTransientRetry(async () => {
        const connection = await pool.getConnection();
        try {
          // Run the money transaction at READ COMMITTED, like Postgres. Correctness comes from
          // the explicit FOR UPDATE locks, which behave the same at either level. REPEATABLE
          // READ only ever hurt here: its pinned snapshot served stale mid-transaction reads,
          // and its gap locks deadlocked concurrent first-use inserts. The reads the schema's
          // own triggers make take those gap locks too. The SET covers just the next
          // transaction, so the connection returns to the pool unchanged.
          await connection.query(
            'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
          );
          await connection.query('START TRANSACTION');
          const unit = buildUnit(
            { exec: connection, digest, clock, pool },
            createUnitTrustStore(connection, clock, velocityWindowMs),
          );
          const result = await work(unit);
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await safeRollback(connection);
          throw error;
        } finally {
          await releaseLocks(connection);
          connection.release();
        }
      }, isTransientConflict),

    close: async () => {
      await pool.end();
    },
  };
}

// Reports whether an error is a transient lock conflict InnoDB raised to break a tie, which is safe
// to retry because the aborted transaction committed nothing. Those are errno 1213 (ER_LOCK_DEADLOCK,
// the engine rolled one side back to resolve a deadlock) or 1205 (ER_LOCK_WAIT_TIMEOUT, a lock wait
// that timed out without committing). Both surface on mysql2's `error.errno`. Anything else (a domain
// fault, a CHECK/constraint violation, a connection error) is not retried.
function isTransientConflict(error: unknown): boolean {
  const e = error as {
    errno?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  } | null;
  const errno = e?.errno;
  // 1213 (deadlock) and 1205 (lock-wait timeout) are the classic "try again" aborts. 1062 (duplicate
  // entry) on chain_links_account_prev_uq is the subtler one. Each account's history is a hash chain,
  // and a new link names the current head as its parent. That index lets only one link claim a given
  // parent. So when two writers read the same head and both try to attach, one wins and the other gets
  // a 1062. The other writer read a now-stale head: the head has moved, and a retry re-reads it and
  // attaches cleanly. mysql2 surfaces no constraint name, so we match the fork by key name in the
  // message. A real duplicate (a colliding id or idempotency key) names a different key and still
  // fails fast. mysql2 puts the key name in sqlMessage (message mirrors it), and String() guards the
  // includes() below.
  //
  // 1644 is the chain-continuity trigger's `SIGNAL SQLSTATE '45000'` -- the same cold-start / stale-head
  // race seen from the trigger side instead of the unique index (a concurrent writer advanced or created
  // the head first), equally fixed by re-reading the head. It is matched only when the message names
  // "chain continuity", because 1644 is also the state of the genuine `conservation` and
  // `balance integrity` faults, which must fail fast and are never retried.
  const text = String(e?.sqlMessage ?? e?.message ?? '');
  return (
    errno === 1213 ||
    errno === 1205 ||
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
 * absent (an un-migrated or pre-versioning database). The composition layer (selectStore) passes the
 * result to {@link assertSchemaCurrent} to fail fast on a schema that has drifted from this code.
 */
export async function readSchemaVersion(
  pool: MysqlPool,
): Promise<string | null> {
  try {
    const [rows] = await pool.query('SELECT version FROM schema_meta LIMIT 1');
    const row = (rows as Array<{ version?: string }>)[0];
    return row?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Create all tables and stored routines this engine needs, from the canonical schema file
 * `db/mysql-schema.sql` (the MySQL counterpart to `db/postgresql-schema.sql`). The file drops and
 * recreates the tables, so running this resets to a clean schema (convenient for tests). Run once
 * during setup (operations tooling or CI), never automatically at app startup.
 *
 * mysql2 sends one statement per `query`, so the file is split into individual statements first
 * (see {@link splitSqlStatements}), then each is run in order.
 */
export async function applyMysqlSchema(pool: MysqlPool): Promise<void> {
  const path = fileURLToPath(
    new URL('../../db/mysql-schema.sql', import.meta.url),
  );
  const sql = await readFile(path, 'utf8');
  // The schema file pins the database collation (its leading ALTER DATABASE) before any DROP/CREATE,
  // so the freshly created tables match the utf8mb4_0900_ai_ci strings JSON_TABLE produces inside
  // post_entry. That is the same pin `mysql < db/mysql-schema.sql` (scripts/migrate.sh) applies. This
  // just runs the file statement by statement.
  for (const statement of splitSqlStatements(sql)) {
    await pool.query(statement);
  }
}

// Splits a `.sql` file into individual statements so each can be sent on its own (mysql2 runs one
// statement per `query`). Statements are separated by the current delimiter, which is `;` by default.
// A `DELIMITER xxx` line changes it, the same directive the mysql CLI uses. That is how a stored
// routine whose body contains `;` stays one statement: it is wrapped in `DELIMITER $$ ... $$` so the
// inner semicolons are not read as statement ends. The directive line itself is not sent to the
// server. Blank lines and `--` comment lines between statements are skipped, but a comment inside a
// statement stays with it.
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
    if (buffer.trimEnd().endsWith(delimiter)) {
      const end = buffer.trimEnd();
      const statement = end.slice(0, end.length - delimiter.length).trim();
      if (statement !== '') {
        statements.push(statement);
      }
      buffer = '';
    }
  }
  return statements;
}

/**
 * Create a `mysql2` connection pool from a connection URL. `mysql2` is imported here, only when
 * this function runs, since it's an optional dependency the rest of the code never needs. The pool
 * returns large integer columns (the money columns, stored as 64-bit integers) as strings, which
 * the engine then converts to bigint exactly.
 *
 * `connectionLimit` caps the pool. Each in-flight transaction holds one connection for its whole
 * BEGIN..COMMIT, so a caller driving N concurrent submits must size this to at least N. Left unset,
 * `mysql2`'s default of 10 applies, which is the historical behavior.
 */
export async function createMysqlPool(
  url: string,
  options: { connectionLimit?: number } = {},
): Promise<MysqlPool> {
  // Hold the module name in a variable instead of writing it directly in import(), so the
  // type-checker does not try to resolve this optional dependency at build time (it need only be
  // installed wherever this engine runs). `@vite-ignore` tells a bundler (Vite/Rollup) the same
  // thing: leave it a runtime import rather than warning that it cannot statically analyze the
  // variable specifier. mysql2 is a server-only optional driver that consumers externalize, never
  // bundled.
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
    // Pin the connection collation to MySQL 8's utf8mb4 default. Strings produced by JSON_TABLE in
    // post_entry take their collation from the connection. Left at mysql2's default, the connection is
    // utf8mb4_unicode_ci, which clashes with the utf8mb4_0900_ai_ci table columns on every
    // `ab.account_id = d.account` join ("Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and
    // (utf8mb4_unicode_ci,IMPLICIT)"). Matching the connection to the table and JSON side keeps every
    // `=` in a single collation. (applyMysqlSchema pins the database default to the same collation.)
    charset: 'UTF8MB4_0900_AI_CI',
  });
}
