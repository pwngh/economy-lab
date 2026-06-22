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
import { toAmount } from '#src/money.ts';
import { currency } from '#src/accounts.ts';
import { fromHex } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import {
  callProcedure,
  callFunction,
  postEntryArgs,
} from '#src/adapters/sql-routines.ts';
import {
  defaultDigest,
  defaultClock,
  GENESIS_HEX,
  readMinor,
  distinctAccounts,
  rowToSaga,
  rowToSubscription,
  rowToCheckpoint,
  metaString,
  metaNumber,
} from '#src/adapters/sql-shared.ts';

import type { Link } from '#src/adapters/sql-shared.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Transaction } from '#src/contract.ts';
import type {
  CheckpointStore,
  Clock,
  Digest,
  EntitlementStore,
  IdempotencyStore,
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
  SaleStore,
  Sale,
  SagaStore,
  Statement,
  Store,
  StoredLink,
  SubscriptionStore,
  TrustStore,
  Unit,
  Velocity,
} from '#src/ports.ts';

// --- The mysql2/promise driver, described here by hand ----------------------------

// We declare only the few methods this file calls instead of importing the real types
// from `mysql2`. `mysql2` is an optional dependency a consumer may not have installed, so
// importing it would break type-checking when it is absent. Describing the shape here lets
// the file type-check on its own.
//
// The driver's `query` returns a two-element array: a SELECT puts its rows in the first
// slot; an INSERT/UPDATE/DELETE puts a result-summary object there instead, which reports
// how many rows the statement changed (`affectedRows`). Both are typed `unknown` here and
// each caller casts to whichever shape it expects.
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

// What each store-building function needs: something it can run SQL on (either the pool
// for standalone statements or a single connection inside a transaction), plus the
// injected hashing and clock services.
interface ExecDeps {
  exec: MysqlExecutor;
  digest: Digest;
  clock: Clock;
}

// Run a SELECT and return just its rows. The driver also returns a column-metadata object,
// which we don't use and drop here.
async function rows(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<Row[]> {
  let [result] = await exec.query(sql, params);
  return result as Row[];
}

// Run an INSERT/UPDATE/DELETE and return how many rows it changed. MySQL can't return the
// changed rows themselves (no RETURNING clause), so this count is the only way to tell
// whether a conditional UPDATE actually matched a row: an UPDATE whose WHERE matched
// nothing reports 0.
async function execWrite(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<number> {
  let [header] = await exec.query(sql, params);
  return (header as ResultHeader).affectedRows ?? 0;
}

// --- The ledger store -------------------------------------------------------------

// Whether an account is allowed to appear in a posting. Two ways to qualify: a user
// account, recognized by its id ending in ':spendable', ':earned', or ':promo'; or a
// platform account already present in the `accounts` table (those are inserted when the
// schema is set up). A leg against anything else makes postEntry raise UNKNOWN_ACCOUNT.
async function isKnownAccount(
  exec: MysqlExecutor,
  account: AccountRef,
): Promise<boolean> {
  let colon = account.lastIndexOf(':');
  if (colon >= 0) {
    let suffix = account.slice(colon + 1);
    if (suffix === 'spendable' || suffix === 'earned' || suffix === 'promo') {
      return true;
    }
  }
  let found = await rows(exec, 'SELECT 1 FROM accounts WHERE id = ? LIMIT 1', [
    account,
  ]);
  return found.length > 0;
}

// The head hash of each given account's chain, read in ONE query. Each account's entries are
// linked into a tamper-evident chain where each entry's hash is built from the previous entry's,
// and the head is the latest such hash. Each posting that touches an account writes one chain_links
// row, so the most recent link — the one with the highest posting sequence number — carries the
// head; a window function (ROW_NUMBER per account, newest first) picks it. Accounts with no entries
// yet are simply absent from the result, and the caller treats a missing account as the genesis
// hash. Reading every head at once turns one round-trip per account into one round-trip per posting.
async function headsForAccounts(
  exec: MysqlExecutor,
  accounts: ReadonlyArray<AccountRef>,
): Promise<Map<string, string>> {
  let heads = new Map<string, string>();
  if (accounts.length === 0) {
    return heads;
  }
  let marks = accounts.map(() => '?').join(', ');
  let found = await rows(
    exec,
    `SELECT t.account_id, t.hash FROM (
       SELECT c.account_id, c.hash,
              ROW_NUMBER() OVER (
                PARTITION BY c.account_id ORDER BY p.seq DESC
              ) AS rn
         FROM chain_links c
         JOIN postings p ON p.id = c.posting_id
        WHERE c.account_id IN (${marks})
     ) t
      WHERE t.rn = 1`,
    accounts,
  );
  for (let row of found) {
    heads.set(row.account_id as string, row.hash as string);
  }
  return heads;
}

// Compute the new chain link for every account a posting touches. Read every account's current
// head hash in one query, then for each account ask chainHash (in ledger.ts) for this posting's
// new hash, derived from that previous hash plus the posting's details. The previous hash comes in
// as hex and is decoded back to bytes — except for a first-ever posting, whose predecessor is the
// raw genesis bytes. The hashes are independent across accounts, so batching the reads and
// computing the hashes after changes nothing about the result.
async function advanceChain(
  deps: ExecDeps,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  let accounts = distinctAccounts(posting.legs);
  let heads = await headsForAccounts(deps.exec, accounts);
  let links: Link[] = [];
  for (let account of accounts) {
    let prevHex = heads.get(account) ?? GENESIS_HEX;
    let accountPrevHash = prevHex === GENESIS_HEX ? GENESIS : fromHex(prevHex);
    let hash = await chainHash(deps.digest, {
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

// Write a posting and everything derived from it: the posting row, ALL of its legs, exactly
// one chain-link row per distinct account it touched (carrying that account's old and new
// chain hashes), and the running-balance update per leg.
//
// Legs and chain links are stored at different levels of detail on purpose: a posting may
// have several legs to one account (e.g. a promo-funded spend), but it advances that
// account's hash chain only once. We store every leg because re-deriving an account's hash
// later (in lineageOf) needs the account's full set of legs, and storing them all keeps that
// set identical to the in-memory adapter. We store the chain link once per account (not once
// per leg) because the database enforces a rule that a given previous-hash may be extended
// only once — if each leg wrote its own link, a posting's legitimate second leg to the same
// account would look like a second link extending the same previous hash and be rejected.
// advanceChain already returns one link per distinct account, so `links` has exactly the
// rows chain_links needs.
async function insertPosting(
  deps: ExecDeps,
  posting: Posting,
): Promise<Transaction> {
  let postedAt = deps.clock.now();
  let links = await advanceChain(deps, posting);

  // One CALL persists the whole posting. The application has already done every decision (the
  // chain hashes, the per-account net balance deltas, which user accounts are new); the
  // `post_entry` procedure receives those finished values and writes the posting, its legs, its
  // chain links, and the balance changes as one set-based unit inside this transaction. This
  // replaces a per-leg loop that cost a dozen-plus round-trips per posting. JSON arrays carry the
  // bigint amounts as strings so nothing is lost past 2^53.
  let args = postEntryArgs(posting, links);
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

// Wrap the MySQL executor as the normalized query function the shared routine surface expects:
// run the SQL with positional `?` params and return the rows under a `rows` key.
function mysqlQuery(exec: MysqlExecutor) {
  return async (sql: string, params: ReadonlyArray<unknown>) => ({
    rows: (await rows(exec, sql, params)) as ReadonlyArray<
      Record<string, unknown>
    >,
  });
}

// NOTE: creating a first-time user account's `accounts` row now happens inside the `post_entry`
// stored procedure (db/mysql-schema.sql), from the new-accounts list the application computes
// (see postEntryArgs in sql-routines.ts). MySQL's `lock` uses a named lock (GET_LOCK), not a row,
// so it needs no account row up front the way the Postgres adapter's row lock does.

// NOTE: the per-account balance fold (UPDATE existing rows first so the non-negative CHECK is
// tested against the new total, then INSERT first-time rows) now lives inside the `post_entry`
// stored procedure (db/mysql-schema.sql), which applies every account's net delta in one
// set-based step. The application still decides each delta via `balanceDelta` (see postEntryArgs
// in sql-routines.ts); the procedure only persists it.

function createLedgerStore(deps: ExecDeps): Ledger {
  return {
    hasAccount: async (account) => isKnownAccount(deps.exec, account),

    // Take a named lock on an account so concurrent transactions touching the same
    // account run one at a time. The lock name is derived from the account id.
    // MySQL lets the same connection take the same named lock more than once without
    // blocking on itself, so locking one account twice in a row is safe. The lock is
    // dropped when the transaction commits or rolls back.
    lock: async (account) => {
      await rows(deps.exec, 'SELECT GET_LOCK(?, 10)', [lockName(account)]);
    },

    append: async (posting) => insertPosting(deps, posting),

    balance: async (account) => {
      // The cached balance comes back through the `account_balance` function (0 when the account
      // has no row yet), giving the read one named, tunable access path on the database side.
      let raw = await callFunction(
        mysqlQuery(deps.exec),
        'mysql',
        'account_balance',
        [account],
      );
      return toAmount(currency(account), readMinor(raw));
    },

    statement: async (account, range) =>
      buildStatement(deps.exec, account, range),

    timeline: (account) => timelineOf(deps.exec, account),

    heads: async function* () {
      // One row per account paired with the hash at the tip of its chain. The tip is the
      // chain_links row with the highest posting sequence number for that account; the
      // subquery finds that max seq per account and the join pulls back its hash. MySQL has
      // no DISTINCT ON, so this is the portable equivalent.
      for (let row of await rows(
        deps.exec,
        `SELECT c.account_id, c.hash FROM chain_links c
           JOIN postings p ON p.id = c.posting_id
           JOIN (
             SELECT c2.account_id AS account_id, MAX(p2.seq) AS max_seq
               FROM chain_links c2
               JOIN postings p2 ON p2.id = c2.posting_id
              GROUP BY c2.account_id
           ) tip ON tip.account_id = c.account_id AND tip.max_seq = p.seq`,
      )) {
        yield [row.account_id as AccountRef, row.hash as string] as const;
      }
    },

    balanceAccounts: async function* () {
      // Every account that has a cached balance row. The store keeps a running per-account
      // balance in `account_balances` as a cache; the entries (legs) it is summed from are the
      // real source of truth. This lists accounts straight from that cache, not from the
      // postings — so a stale or phantom balance row that has NO entries behind it is still
      // surfaced, which an account-from-postings scan (`heads`, below) would never reach. The
      // integrity checker sums each account's entries first, then treats anything seen only
      // here as "should be zero" — so a balance row with no entries shows up as a mismatch
      // between the cached balance and what the entries actually sum to.
      for (let row of await rows(
        deps.exec,
        'SELECT account_id FROM account_balances',
      )) {
        yield row.account_id as AccountRef;
      }
    },

    lineage: (account) => lineageOf(deps.exec, account),

    posting: (txnId) => postingOf(deps.exec, txnId),
  };
}

// Turn an account id into a name for MySQL's named lock. MySQL caps lock names at 64
// bytes, and an account id can be longer, so for long ids we use a fixed-length prefix
// followed by the id's full length. Including the length keeps two different ids that
// share a prefix from colliding on the same lock.
function lockName(account: AccountRef): string {
  return account.length <= 56
    ? account
    : `${account.slice(0, 48)}#${account.length}`;
}

// Build a statement for an account over a time range (start inclusive, end exclusive).
// Each entry's amount is shown as the effect on this account's balance, so money coming
// into a user account reads as a positive number. The conformance fixtures always fit in
// one page, so there is no next-page cursor.
async function buildStatement(
  exec: MysqlExecutor,
  account: AccountRef,
  range: Range,
): Promise<Statement> {
  let result = await rows(
    exec,
    `SELECT p.id AS txn_id, l.account_id AS account_id, l.currency AS currency,
            l.amount AS amount, p.posted_at AS posted_at
       FROM legs l JOIN postings p ON l.posting_id = p.id
      WHERE l.account_id = ? AND p.posted_at >= ? AND p.posted_at < ?
      ORDER BY p.posted_at, l.id`,
    [account, range.from, range.to],
  );
  let entries = result.map((row) => ({
    txnId: row.txn_id as string,
    amount: naturalDelta(account, row),
    postedAt: Number(row.posted_at),
  }));
  return { account, entries, cursor: null };
}

// Stream an account's funds as dated lots, oldest first, for the maturity logic that
// decides when funds become spendable. It yields one lot for every posting that increased
// the account's balance; legs that decreased it are skipped. The "when does this mature"
// rule lives in maturity.ts — here we just carry over what each posting recorded. If a
// posting didn't record a source or a maturity time, we fall back to "unknown" and to
// treating it as mature right away (the safe default).
async function* timelineOf(
  exec: MysqlExecutor,
  account: AccountRef,
): AsyncIterable<Lot> {
  let result = await rows(
    exec,
    `SELECT p.id AS txn_id, p.meta AS meta, l.currency AS currency,
            l.amount AS amount, p.posted_at AS posted_at
       FROM legs l JOIN postings p ON l.posting_id = p.id
      WHERE l.account_id = ? ORDER BY p.posted_at, l.id`,
    [account],
  );
  for (let row of result) {
    let delta = naturalDelta(account, row);
    if (delta.minor <= 0n) {
      continue;
    }
    let meta = parseMeta(row.meta);
    yield {
      txnId: row.txn_id as string,
      amount: delta,
      source: metaString(meta, 'source', 'unknown'),
      toppedUpAt: Number(row.posted_at),
      maturesAt: metaNumber(meta, 'maturesAt', Number(row.posted_at)),
    };
  }
}

// Stream an account's history in a form the chain verifier can re-hash to confirm nothing
// was tampered with. For each posting that touched the account, in commit order, it yields
// the posting's legs and metadata exactly as they were written, alongside the two hashes
// recorded at the time: the account's head before this posting and after. The verifier
// recomputes the "after" hash from the legs and metadata and checks it still matches.
async function* lineageOf(
  exec: MysqlExecutor,
  account: AccountRef,
): AsyncIterable<StoredLink> {
  // One chain_links row per posting that touched this account (a posting advances the
  // account's chain exactly once, however many legs it has to the account), so this yields
  // one StoredLink per such posting — exactly what the in-memory adapter does.
  let postings = await rows(
    exec,
    `SELECT c.posting_id AS txn_id, p.meta AS meta,
            c.prev_hash AS prev_hash, c.hash AS hash
       FROM chain_links c JOIN postings p ON p.id = c.posting_id
      WHERE c.account_id = ? ORDER BY p.seq ASC`,
    [account],
  );
  for (let posting of postings) {
    // The whole posting's legs (not just this account's): chainPreimage filters to the
    // account's own legs itself, so the recompute matches the in-memory reference exactly.
    let legs = await legsOf(exec, posting.txn_id as string);
    yield {
      txnId: posting.txn_id as string,
      legs,
      meta: parseMeta(posting.meta),
      prevHash: posting.prev_hash as string,
      hash: posting.hash as string,
    };
  }
}

// Every leg of one posting, in a stable order. The hash recomputation needs all of a
// posting's legs, not just the ones for the account being verified, because it selects the
// relevant legs itself when rebuilding the hash input.
async function legsOf(
  exec: MysqlExecutor,
  txnId: string,
): Promise<ReadonlyArray<Leg>> {
  let result = await rows(
    exec,
    'SELECT account_id, currency, amount FROM legs WHERE posting_id = ? ORDER BY id',
    [txnId],
  );
  return result.map((row) => ({
    account: row.account_id as AccountRef,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  }));
}

// Load one whole posting by its transaction id, with all of its legs (not filtered to one
// account, unlike lineageOf). The `reverse` operation reads this to post the exact
// opposite entry and undo a posting. The metadata comes from the posting row and the legs
// from legsOf. Returns null when no posting has that id, so the caller can fail loudly
// instead of guessing.
async function postingOf(
  exec: MysqlExecutor,
  txnId: string,
): Promise<Posting | null> {
  let found = await rows(
    exec,
    'SELECT meta FROM postings WHERE id = ? LIMIT 1',
    [txnId],
  );
  if (!found.length) {
    return null;
  }
  let legs = await legsOf(exec, txnId);
  return { txnId, legs, meta: parseMeta(found[0]!.meta) };
}

// How much a stored leg changed its account's balance. Leg amounts are all stored in one
// shared sign convention (positive for a debit). To get the effect on this particular
// account's balance, rebuild the leg and apply that account's sign rule: some accounts go
// up on a debit, others go up on a credit.
function naturalDelta(account: AccountRef, row: Row): Amount {
  let leg: Leg = {
    account,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  };
  return balanceDelta(leg);
}

// --- Idempotency store ------------------------------------------------------------

// Makes a request safe to retry: the same idempotency key is processed at most once, and a
// retry returns the original result instead of doing the work again.
//
// `claim` is the gate. The key is the primary key of the `idempotency` table, so the
// database allows only one row per key. The first caller inserts a placeholder row (no
// result yet) and is told to proceed. A later caller with the same key finds that row:
//   - If the first call has finished and saved its result, the later caller gets that
//     result back instead of running again.
//   - If the first call is still in progress, the later caller blocks on the placeholder
//     row (it is locked by the unfinished transaction) until that call commits or rolls
//     back.
// If the first call rolls back, its placeholder row disappears with it, so a failed
// attempt does not consume the key — the request can be retried cleanly.
function createIdempotencyStore(exec: MysqlExecutor): IdempotencyStore {
  return {
    claim: async (key) => {
      let existing = await rows(
        exec,
        'SELECT transaction FROM idempotency WHERE `key` = ? FOR UPDATE',
        [key],
      );
      if (existing.length) {
        let recorded = existing[0]!.transaction;
        if (recorded !== null) {
          return {
            claimed: false,
            transaction: parseTransaction(recorded),
          };
        }
        return { claimed: true };
      }
      await rows(
        exec,
        'INSERT INTO idempotency (`key`, transaction) VALUES (?, NULL)',
        [key],
      );
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

// Records each completed sale, keyed by its order id. This is separate from the
// idempotency key above: it stores the sale's details (including the exact ledger legs)
// so that a later refund can look the sale up by order id and reverse precisely what was
// posted.
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
      let found = await rows(
        exec,
        'SELECT * FROM sales WHERE order_id = ? LIMIT 1',
        [orderId],
      );
      return found.length ? rowToSale(found[0]!) : null;
    },
  };
}

// --- Outbox store -----------------------------------------------------------------

// Reliable event publishing using the "transactional outbox" pattern. The event is saved
// (`enqueue`) in the same transaction as the money posting, so the event exists exactly
// when the posting does. A separate relay process later picks up a batch of pending events
// to publish (`claimBatch`); FOR UPDATE SKIP LOCKED lets several relay workers grab
// different rows at once without stepping on each other. The downstream consumer
// de-duplicates by event id, so an event published more than once is delivered once.
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
      let result = await rows(
        exec,
        `SELECT id, event, status, attempts FROM outbox
          WHERE status = 'pending' ORDER BY created_at, id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      return result.map(rowToOutbox);
    },
    markRelayed: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      let placeholders = ids.map(() => '?').join(', ');
      await rows(
        exec,
        `UPDATE outbox SET status = 'relayed' WHERE id IN (${placeholders})`,
        [...ids],
      );
    },
    // Record a failed delivery attempt: bump `attempts` by one and leave the row pending so
    // the next sweep retries it. The `AND status = 'pending'` guard makes this a no-op on a
    // row that is missing, already relayed, or already dead-lettered — matching the in-memory
    // reference, which silently skips a non-'pending' row.
    recordFailure: async (id) => {
      await rows(
        exec,
        "UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Give up on a poison message: flip it to 'failed' so claimBatch never hands it back, and
    // keep the reason for operators. The same `AND status = 'pending'` guard makes a missing or
    // already-terminal row a no-op, mirroring the saga store and the in-memory reference.
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE outbox SET status = 'failed', dead_letter_reason = ? WHERE id = ? AND status = 'pending'",
        [reason, id],
      );
    },
  };
}

// --- Saga store -------------------------------------------------------------------

// Tracks each payout as a small state machine that advances over several steps (a "saga").
// `advance` only changes the saga's state if it is still in the state the caller expected:
// the UPDATE's WHERE clause requires the current state to equal `from`. If two workers try
// to advance the same saga at once, only one matches a row and succeeds; the other changes
// zero rows and learns it lost the race, so a payout can't be advanced twice.
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
      let found = await rows(
        exec,
        'SELECT * FROM payout_sagas WHERE id = ? LIMIT 1',
        [id],
      );
      return found.length ? rowToSaga(found[0]!) : null;
    },
    claimDue: async (now, limit) => {
      let result = await rows(
        exec,
        `SELECT * FROM payout_sagas
          WHERE due_at <= ? AND state IN ('RESERVED', 'SUBMITTED')
          ORDER BY due_at LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.map(rowToSaga);
    },
    // The store methods omit the interface's optional trailing `options` param: it is never
    // read here, and structural typing satisfies each Store interface without it (a function
    // with fewer trailing optional params is still assignable).
    advance: async (id, from, to, patch) => {
      let next = { ...(await loadSagaOrThrow(exec, id)), ...patch, state: to };
      let affected = await execWrite(
        exec,
        `UPDATE payout_sagas SET
           reserve = ?, rate_id = ?, state = ?, provider_ref = ?,
           attempts = ?, due_at = ?, updated_at = ?
         WHERE id = ? AND state = ?`,
        [
          next.reserve.minor.toString(),
          next.rateId,
          to,
          next.providerRef,
          next.attempts,
          next.dueAt,
          next.updatedAt,
          id,
          from,
        ],
      );
      return affected > 0;
    },
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE payout_sagas SET state = 'FAILED', dead_letter_reason = ? WHERE id = ?",
        [reason, id],
      );
    },
    lastPayoutAt: (userId) => lastPayoutOf(exec, userId),
  };
}

// The time of a user's most recent payout request, as the MAX(updated_at) over ALL of their
// sagas in any state (the requestPayout min-interval check reads this). MySQL's MAX over no
// matching rows yields NULL, so a user with no sagas reads back null and their first request
// always passes — exactly the in-memory reference's behavior.
async function lastPayoutOf(
  exec: MysqlExecutor,
  userId: string,
): Promise<number | null> {
  let found = await rows(
    exec,
    'SELECT MAX(updated_at) AS last FROM payout_sagas WHERE user_id = ?',
    [userId],
  );
  let last = found[0]?.last;
  return last === null || last === undefined ? null : Number(last);
}

// Load a saga, throwing if it doesn't exist. `advance` calls this to get the saga's
// current field values, then overlays the few fields it is changing. A missing saga here
// means a bug in the caller; under normal use the saga always exists by the time advance
// runs.
async function loadSagaOrThrow(exec: MysqlExecutor, id: string): Promise<Saga> {
  let found = await rows(
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

// Tracks what each user owns (entitlements), which is ownership state rather than money
// movement, so it touches no ledger. `revoke` is a soft delete: rather than deleting the
// row it sets `revoked = true` and keeps the row, so the ownership history a refund or
// clawback may need survives for auditing; a later re-grant clears `revoked` through the
// on-conflict path, so buying the same thing again re-activates it. `owns` also honors an
// entitlement's expiry: a user still owns it up to and including `expiresAt` (owned while
// now <= expiresAt, lost once now > expiresAt), checked against the injected clock, matching
// the older reference implementation.
function createEntitlementStore(deps: ExecDeps): EntitlementStore {
  let exec = deps.exec;
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
    // Soft-revoke: keep the row, flip the flag. `owns` filters on `revoked = false`, so this
    // takes ownership away while preserving the audit trail; a later re-grant clears it.
    revoke: async (userId, sku) => {
      await rows(
        exec,
        'UPDATE entitlements SET revoked = true WHERE user_id = ? AND sku = ?',
        [userId, sku],
      );
    },
    owns: async (userId, sku) => {
      // `expires_at IS NULL` means a perpetual grant; otherwise it stays owned up to and
      // including `expiresAt` (>= now), expiring only once the clock has passed it.
      let found = await rows(
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

// Tracks recurring subscriptions and supports the background job that renews them: it
// finds subscriptions whose next charge is due (`claimDue`), records a successful charge
// and schedules the next one (`markBilled`), or ends a subscription that can't be funded
// (`markLapsed`) or that the user cancels.
function createSubscriptionStore(exec: MysqlExecutor): SubscriptionStore {
  return {
    open: async (sub) => {
      // `open` is an upsert (the worker re-opens an existing subscription to persist a bumped
      // retry count), so the duplicate-key branch must overwrite `attempts` too — otherwise a
      // re-open with attempts: n+1 would silently keep the old count and the retry cap would
      // never advance, diverging from the in-memory reference's full-row overwrite.
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
      let found = await rows(
        exec,
        'SELECT * FROM subscriptions WHERE id = ? LIMIT 1',
        [id],
      );
      return found.length ? rowToSubscription(found[0]!) : null;
    },
    // The one ACTIVE subscription for this (user, sku, seller) triple, or null. The subscribe
    // handler reads this to refuse a duplicate active subscription that would double-bill.
    activeFor: async (userId, sku, sellerId) => {
      let found = await rows(
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
    claimDue: async (now, limit) => {
      let result = await rows(
        exec,
        `SELECT * FROM subscriptions WHERE state = 'ACTIVE' AND next_due_at <= ?
          ORDER BY next_due_at LIMIT ?`,
        [now, limit],
      );
      return result.map(rowToSubscription);
    },
    markBilled: async (id, nextDueAt, expectedDueAt) => {
      // Update the due date only if it still holds the value this caller expects (the UPDATE's
      // WHERE requires next_due_at to equal `expectedDueAt`). This guards against two renewal
      // workers acting on the same subscription at once: whichever updates first changes the due
      // date, so the second — which expected the now-stale old date — matches no row
      // (affectedRows = 0) and returns false, treats the renewal as already done, and never
      // double-charges. The saga store's `advance` guards itself the same way. A successful
      // renewal also resets `attempts` (the count of consecutive failed charges) to 0, so a
      // subscription that recovered starts fresh against the retry limit.
      let affected = await execWrite(
        exec,
        `UPDATE subscriptions SET next_due_at = ?, period = period + 1, attempts = 0
          WHERE id = ? AND next_due_at = ?`,
        [nextDueAt, id, expectedDueAt],
      );
      return affected > 0;
    },
    // End a subscription because a renewal charge couldn't be funded. This is a
    // different ending from the user choosing to cancel. The UPDATE only applies when the
    // subscription is still active, so it moves it from active to lapsed exactly once; once
    // lapsed it no longer matches the renewal job (which looks only for active ones), so it
    // stops being billed.
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

// Tracks each marketing promo grant so the promo-expiry sweep can reverse whatever the
// user hasn't spent once the grant expires. `grantPromo` records the grant here in the
// same transaction as the credit posting; the sweep later claims due grants oldest-first
// and reverses the unspent remainder, then marks each reversed so it is never reversed
// twice.
function createPromoStore(exec: MysqlExecutor): PromoStore {
  return {
    // Idempotent on `id`: opening the same grant twice is a no-op and never overwrites or
    // duplicates the first row. `ON DUPLICATE KEY UPDATE id = id` is the MySQL idempotent-
    // insert idiom — a no-op assignment that swallows the duplicate-key conflict without
    // touching any column, so a second open() of the same grant leaves the original row
    // exactly as it was. This differs from the saga/subscription `open` upserts above, which
    // overwrite on conflict; a promo grant must NOT be clobbered.
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
      let result = await rows(
        exec,
        `SELECT * FROM promo_grants
          WHERE expires_at <= ? AND reversed = false
          ORDER BY expires_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.map(rowToPromoGrant);
    },
    // Mark a grant reversed so `claimDue` never hands it back again. The `AND reversed = false`
    // guard makes this a no-op on a row that is missing or already reversed, mirroring the
    // saga/outbox dead-letter guards and the in-memory reference.
    markReversed: async (id) => {
      await rows(
        exec,
        'UPDATE promo_grants SET reversed = true WHERE id = ? AND reversed = false',
        [id],
      );
    },
  };
}

// --- Trust store (kept outside money transactions) --------------------------------

// Records spending attempts per subject (a user or similar) so spending-velocity limits
// can be enforced. These rows are written on the pool directly, outside the money
// transaction, so that even an attempt that gets rejected still counts toward the limit
// (it isn't rolled back along with the money). `bump` uses each attempt's idempotency key
// as the primary key (with INSERT IGNORE), so retrying the same attempt doesn't count it
// twice. `read` sums up a subject's recorded attempts.
function createTrustStore(
  pool: MysqlPool,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    // Read the subject's spend inside the sliding window ending now: only attempts newer than
    // `now - windowMs` are summed, so each ages out of the limit on its own. The cutoff uses the
    // injected clock (not SQL NOW()) so tests stay deterministic.
    read: async (subject) => {
      let cutoff = clock.now() - windowMs;
      let found = await rows(
        pool,
        `SELECT COALESCE(MIN(at), 0) AS window_start,
                COALESCE(SUM(amount), 0) AS spent,
                COUNT(*) AS attempts
           FROM trust_attempts WHERE subject = ? AND at > ?`,
        [subject, cutoff],
      );
      let row = found[0]!;
      return {
        subject,
        windowStart: Number(row.window_start),
        spent: toAmount('CREDIT', readMinor(row.spent)),
        attempts: Number(row.attempts),
      } satisfies Velocity;
    },
    bump: async (subject, attempt) => {
      await rows(
        pool,
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
    },
    // Record-and-measure atomically. Borrow one connection, take a per-subject named lock so two
    // concurrent same-subject calls run one at a time, insert the attempt (INSERT IGNORE, deduped
    // on the idempotency-key primary key, exactly as `bump` does), then run the same windowed SUM
    // `read` uses — now including this attempt. The named lock is released and the connection
    // returned in `finally`, so a borrower never inherits a stale lock. Serializing the insert and
    // the SUM behind one lock is what closes the velocity-limit TOCTOU the separate read+bump left.
    record: async (subject, attempt) => {
      let cutoff = clock.now() - windowMs;
      let connection = await pool.getConnection();
      try {
        await rows(connection, 'SELECT GET_LOCK(?, 10)', [
          subjectLockName(subject),
        ]);
        await rows(
          connection,
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
        let found = await rows(
          connection,
          `SELECT COALESCE(MIN(at), 0) AS window_start,
                  COALESCE(SUM(amount), 0) AS spent,
                  COUNT(*) AS attempts
             FROM trust_attempts WHERE subject = ? AND at > ?`,
          [subject, cutoff],
        );
        let row = found[0]!;
        return {
          subject,
          windowStart: Number(row.window_start),
          spent: toAmount('CREDIT', readMinor(row.spent)),
          attempts: Number(row.attempts),
        } satisfies Velocity;
      } finally {
        await releaseLocks(connection);
        connection.release();
      }
    },
  };
}

// Turn a risk subject (a user id) into a name for MySQL's named lock, so same-subject `record`
// calls serialize. Same 64-byte cap and prefix#length scheme as `lockName`, kept separate so a
// subject lock can never collide with an account lock of the same string.
function subjectLockName(subject: string): string {
  let tagged = `trust:${subject}`;
  return tagged.length <= 56
    ? tagged
    : `${tagged.slice(0, 48)}#${tagged.length}`;
}

// --- Checkpoint store (used only by background workers) ---------------------------

// Stores checkpoints (periodic signed snapshots of the ledger's state). Writes append a
// new row and never take part in a money transaction: a checkpoint, once recorded, must
// survive even if some money transaction later rolls back, so it is written on the pool
// directly (committed on its own).
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
      let found = await rows(
        pool,
        'SELECT * FROM checkpoints ORDER BY seq DESC LIMIT 1',
      );
      return found.length ? rowToCheckpoint(found[0]!) : null;
    },
  };
}

// --- Webhook replay store (kept outside money transactions) -----------------------

// Makes processing an inbound provider webhook happen at most once, keyed by the provider's
// own event id. This is a separate set of ids from the application's own idempotency keys.
// The webhook handler claims the `eventId` here only after it has already checked the
// delivery is authentic and recent, and it does so as a standalone write on the pool — not
// inside a money transaction. That ordering means a rejected or forged delivery that never
// reaches this point cannot use up the id, while a claim that does land stays recorded even
// if some later money posting rolls back.
//
// `claim` inserts the id only if it is not already present: `INSERT IGNORE` adds the row the
// first time and quietly does nothing on a redelivery, instead of raising a duplicate-key
// error (the same effect as the postgres adapter's `on conflict do nothing`). The driver
// reports affectedRows = 1 on the call that inserted and 0 on every later one, so that count
// alone distinguishes a first delivery from a duplicate.
function createReplayStore(pool: MysqlPool): ReplayStore {
  return {
    claim: async (eventId) => {
      let affected = await execWrite(
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
  };
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

// Serialize a transaction to a JSON string for storage. Money amounts are turned into
// decimal strings first, for two reasons: JSON.stringify can't handle bigint values
// directly, and encoding them as strings means a stored transaction reads back byte-for-
// byte identical, so a replayed duplicate request returns exactly the original result.
function encodeTransaction(transaction: Transaction): string {
  return JSON.stringify({
    id: transaction.id,
    postedAt: transaction.postedAt,
    legs: encodeLegs(transaction.legs),
    links: transaction.links,
  });
}

function parseTransaction(value: unknown): Transaction {
  let parsed = parseJson(value) as {
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

// Turn legs into a plain JSON-friendly form for storage. Each leg's money amount becomes a
// "CURRENCY:minor" string (for example "CREDIT:500"), which both records the currency and
// keeps the exact integer value across the round-trip.
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
    let colon = leg.amount.indexOf(':');
    let currencyTag = leg.amount.slice(0, colon) as Amount['currency'];
    let minor = BigInt(leg.amount.slice(colon + 1));
    return {
      account: leg.account as AccountRef,
      amount: toAmount(currencyTag, minor),
    };
  });
}

// Read a JSON column's value. The mysql2 driver normally hands back JSON columns already
// parsed into objects, so we use the value as-is; if some driver configuration returns it
// as a raw string instead, parse it. Either way the caller gets parsed data.
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseMeta(value: unknown): Record<string, unknown> {
  let parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {};
}

// --- Grouping the stores into one transactional unit ------------------------------

// Bundle the stores a request handler may use, all sharing one database connection, so
// every write a handler makes commits or rolls back together as one transaction. The
// trust and checkpoint stores are deliberately left out: they are written outside the
// money transaction (see their comments above).
function buildUnit(deps: ExecDeps): Unit {
  return {
    ledger: createLedgerStore(deps),
    idempotency: createIdempotencyStore(deps.exec),
    sales: createSaleStore(deps.exec),
    outbox: createOutboxStore(deps.exec),
    sagas: createSagaStore(deps.exec),
    entitlements: createEntitlementStore(deps),
    subscriptions: createSubscriptionStore(deps.exec),
    promos: createPromoStore(deps.exec),
  };
}

// --- The assembled store ----------------------------------------------------------

/**
 * Build the full MySQL-backed store on top of a `mysql2` connection pool the caller
 * creates and owns.
 *
 * `transaction(work)` borrows one connection, wraps `work` in START TRANSACTION ... COMMIT,
 * and rolls back if `work` throws. On the way out it releases any named locks the
 * connection acquired, so a connection returned to the pool never carries leftover locks.
 * Anything done outside a transaction (plain reads and writes, plus the trust and
 * checkpoint stores) runs directly on the pool and commits on its own.
 *
 * The hashing and clock services default to the deterministic web-standard ones, so
 * creating a store with just a pool, `mysqlStore({ pool })`, produces reproducible results.
 */
export function mysqlStore(deps: {
  pool: MysqlPool;
  digest?: Digest;
  clock?: Clock;
  velocityWindowMs?: number;
}): Store {
  let pool = deps.pool;
  let digest = deps.digest ?? defaultDigest();
  let clock = deps.clock ?? defaultClock();
  let velocityWindowMs = deps.velocityWindowMs ?? 60 * 60_000;
  let poolDeps: ExecDeps = { exec: pool, digest, clock };

  let auto = buildUnit(poolDeps);

  return {
    ledger: auto.ledger,
    idempotency: auto.idempotency,
    sales: auto.sales,
    outbox: auto.outbox,
    sagas: auto.sagas,
    entitlements: auto.entitlements,
    subscriptions: auto.subscriptions,
    promos: auto.promos,
    trust: createTrustStore(pool, clock, velocityWindowMs),
    checkpoints: createCheckpointStore(pool),
    replay: createReplayStore(pool),

    transaction: async (work) => {
      let connection = await pool.getConnection();
      try {
        await connection.query('START TRANSACTION');
        let unit = buildUnit({ exec: connection, digest, clock });
        let result = await work(unit);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await safeRollback(connection);
        throw error;
      } finally {
        await releaseLocks(connection);
        connection.release();
      }
    },

    close: async () => {
      await pool.end();
    },
  };
}

// Roll back, ignoring any error from the rollback itself. We get here because `work`
// already threw, and that original error is the one to report; if the rollback also fails,
// we don't want it to replace the original error.
async function safeRollback(connection: MysqlConnection): Promise<void> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    // The original error is the one that matters; ignore a failed rollback.
  }
}

// Drop every named lock the connection holds before it goes back to the pool. MySQL's
// named locks stay held until explicitly released or the connection closes, so without
// this a later borrower of the same connection would inherit locks it never asked for.
async function releaseLocks(connection: MysqlConnection): Promise<void> {
  try {
    await connection.query('SELECT RELEASE_ALL_LOCKS()');
  } catch {
    // The connection is being released anyway; a failed unlock can't keep it tied up.
  }
}

// --- Creating the database schema -------------------------------------------------

/**
 * Create all the tables and stored routines this adapter needs, from the canonical schema
 * file `db/mysql-schema.sql` (the MySQL counterpart to `db/postgresql-schema.sql`). The file drops the
 * tables first and recreates them, so running this resets to a clean schema — convenient for
 * tests. Run it once during setup (by operations tooling or CI), never automatically at app
 * startup.
 *
 * mysql2 sends one statement per `query`, so the file is split into its individual
 * statements first (see {@link splitSqlStatements}), then each is run in order.
 */
export async function applyMysqlSchema(pool: MysqlPool): Promise<void> {
  let path = fileURLToPath(
    new URL('../../db/mysql-schema.sql', import.meta.url),
  );
  let sql = await readFile(path, 'utf8');
  await pool.query(
    'ALTER DATABASE CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci',
  );
  for (let statement of splitSqlStatements(sql)) {
    await pool.query(statement);
  }
}

// Split a `.sql` file into its individual statements so each can be sent on its own (mysql2
// runs one statement per `query`). Statements are separated by the current delimiter — `;` by
// default. A `DELIMITER xxx` line changes it (the same directive the mysql CLI uses), which is
// how a stored routine whose body contains `;` is kept as one statement: it is wrapped in
// `DELIMITER $$ … $$` so the inner semicolons are not read as statement ends. The directive line
// itself is not sent to the server. Blank lines and `--` comment lines between statements are
// skipped; a comment inside a statement stays with it.
function splitSqlStatements(sql: string): string[] {
  let statements: string[] = [];
  let delimiter = ';';
  let buffer = '';
  for (let line of sql.split('\n')) {
    let trimmed = line.trim();
    if (/^DELIMITER\s+/i.test(trimmed)) {
      delimiter = trimmed.replace(/^DELIMITER\s+/i, '').trim();
      continue;
    }
    if (buffer.trim() === '' && (trimmed === '' || trimmed.startsWith('--'))) {
      continue;
    }
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      let end = buffer.trimEnd();
      let statement = end.slice(0, end.length - delimiter.length).trim();
      if (statement !== '') {
        statements.push(statement);
      }
      buffer = '';
    }
  }
  return statements;
}

/**
 * Create a `mysql2` connection pool from a connection URL. `mysql2` is imported here, only
 * when this function runs, because it is an optional dependency the rest of the code never
 * needs. The pool is configured to return large integer columns (the money columns, stored
 * as 64-bit integers) as strings, which the adapter then converts to bigint exactly.
 */
export async function createMysqlPool(url: string): Promise<MysqlPool> {
  // Hold the module name in a variable instead of writing it directly in import(), so the
  // type-checker doesn't try to resolve this optional dependency at build time. It only
  // needs to be installed wherever this adapter actually runs.
  let specifier = 'mysql2/promise';
  let mysql = (await import(specifier)) as unknown as {
    createPool(config: unknown): MysqlPool;
  };
  return mysql.createPool({
    uri: url,
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false,
  });
}
