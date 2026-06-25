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
import { toAmount, encodeAmount, decodeAmount, isAmount } from '#src/money.ts';
import { currency } from '#src/accounts.ts';
import { fromHex } from '#src/bytes.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import {
  callProcedure,
  callFunction,
  postEntryArgs,
} from '#src/engines/sql-routines.ts';
import {
  defaultDigest,
  defaultClock,
  GENESIS_HEX,
  readMinor,
  distinctAccounts,
  rowToSaga,
  rowToSubscription,
  rowToCheckpoint,
} from '#src/engines/sql-shared.ts';
import { metaString, metaNumber } from '#src/meta.ts';

import type { Link } from '#src/engines/sql-shared.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Operation, Transaction } from '#src/contract.ts';
import type {
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

// What each store-building function needs: something to run SQL on (the pool for standalone
// statements, or a connection inside a transaction) plus the injected hash and clock.
interface ExecDeps {
  exec: MysqlExecutor;
  digest: Digest;
  clock: Clock;
}

// Run a SELECT and return just its rows, dropping the column-metadata object.
async function rows(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<Row[]> {
  let [result] = await exec.query(sql, params);
  return result as Row[];
}

// Run an INSERT/UPDATE/DELETE and return affectedRows. MySQL has no RETURNING, so this count
// is the only signal of whether a conditional UPDATE matched: a WHERE matching nothing reports 0.
async function execWrite(
  exec: MysqlExecutor,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<number> {
  let [header] = await exec.query(sql, params);
  return (header as ResultHeader).affectedRows ?? 0;
}

// --- The ledger store -------------------------------------------------------------

// Store methods below omit the interface's optional trailing `options` params: never read here,
// and structural typing accepts a function with fewer trailing optional params.

// Whether an account may appear in a posting: either a user account (id ending ':spendable',
// ':earned', or ':promo') or a platform account already in `accounts` (inserted at schema setup).
// Anything else makes postEntry raise UNKNOWN_ACCOUNT.
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

// Head hash of each account's chain, in one query. `account_balances.head_hash` is the maintained
// head pointer: post_entry advances it to the account's new link hash in the same transaction it
// writes chain_links, so this is an O(1) primary-key read per account instead of the old
// ROW_NUMBER-over-the-whole-chain join-and-sort. Accounts with no balance row are absent from the
// result; the caller treats a missing account as the genesis hash (a new account's head). The
// chain_links table stays the source of truth — prove() still re-walks it — so a head pointer
// drifting from the chain surfaces there.
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
    `SELECT account_id, head_hash FROM account_balances
      WHERE account_id IN (${marks})`,
    accounts,
  );
  for (let row of found) {
    heads.set(row.account_id as string, row.head_hash as string);
  }
  return heads;
}

// Compute the new chain link for every account a posting touches. Read all current head hashes in
// one query, then chainHash (ledger.ts) derives each account's new hash from that previous hash
// plus the posting details. The previous hash arrives as hex and is decoded back to bytes, except
// a first-ever posting whose predecessor is the raw genesis bytes. Hashes are independent across
// accounts, so batching the reads doesn't change the result.
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

// Write a posting and everything derived from it: the posting row, all legs, one chain-link row
// per distinct account touched (old and new chain hashes), and the per-leg balance update.
//
// Legs and chain links are stored at different granularity on purpose. A posting may have several
// legs to one account (e.g. a promo-funded spend) but advances that account's chain only once.
// Every leg is stored because re-deriving an account's hash later (lineageOf) needs the full leg
// set, kept identical to the in-memory adapter. The chain link is stored once per account, not per
// leg, because the database enforces that a given previous-hash may be extended only once: per-leg
// links would make a legitimate second leg to the same account look like a second extension of the
// same previous hash and be rejected. advanceChain already returns one link per distinct account,
// so `links` matches chain_links exactly.
async function insertPosting(
  deps: ExecDeps,
  posting: Posting,
): Promise<Transaction> {
  let postedAt = deps.clock.now();
  let links = await advanceChain(deps, posting);

  // One CALL persists the whole posting. The application has already decided everything (chain
  // hashes, per-account net balance deltas, which user accounts are new); `post_entry` writes the
  // posting, legs, chain links, and balance changes as one set-based unit in this transaction,
  // replacing a per-leg loop that cost a dozen-plus round-trips. JSON arrays carry the bigint
  // amounts as strings to keep values past 2^53.
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
// needs no account row up front the way the Postgres adapter's row lock does.

// NOTE: the per-account balance fold (UPDATE existing rows first so the non-negative CHECK tests
// the new total, then INSERT first-time rows) lives inside the `post_entry` stored procedure
// (db/mysql-schema.sql), which applies every account's net delta in one set-based step. The
// application decides each delta via `balanceDelta` (see postEntryArgs in sql-routines.ts); the
// procedure only persists it.

function createLedgerStore(deps: ExecDeps): Ledger {
  return {
    hasAccount: async (account) => isKnownAccount(deps.exec, account),

    // Named lock on an account so concurrent transactions touching it run one at a time. Lock name
    // derived from the account id. The same connection can re-take the same named lock without
    // blocking on itself, so locking one account twice is safe. Dropped on commit or rollback.
    lock: async (account) => {
      await rows(deps.exec, 'SELECT GET_LOCK(?, 10)', [lockName(account)]);
    },

    append: async (posting) => insertPosting(deps, posting),

    balance: async (account) => {
      // Cached balance via the `account_balance` function (0 when the account has no row yet).
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
      // One row per account paired with its chain-tip hash: the chain_links row with the highest
      // posting seq for that account. The subquery finds max seq per account; the join pulls its
      // hash. MySQL has no DISTINCT ON, so this is the portable equivalent.
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
      // Every account with a cached balance row. `account_balances` is a cache; the legs it sums
      // from are the source of truth. Listing from the cache (not postings) surfaces a stale or
      // phantom balance row with no entries behind it, which a postings scan (`heads`, below) would
      // never reach. The integrity checker sums each account's entries first, then treats anything
      // seen only here as "should be zero", so such a row shows up as a cached-vs-summed mismatch.
      for (let row of await rows(
        deps.exec,
        'SELECT account_id FROM account_balances',
      )) {
        yield row.account_id as AccountRef;
      }
    },

    lineage: (account) => lineageOf(deps.exec, account),

    posting: (txnId) => postingOf(deps.exec, txnId),

    list: () => listPostingsOf(deps.exec),
  };
}

// Account id → MySQL named-lock name. MySQL caps lock names at 64 bytes; for longer ids use a
// fixed-length prefix plus the id's full length. The length keeps two ids sharing a prefix from
// colliding on one lock.
function lockName(account: AccountRef): string {
  return account.length <= 56
    ? account
    : `${account.slice(0, 48)}#${account.length}`;
}

// Statement for an account over a time range (start inclusive, end exclusive). Each entry's
// amount is the effect on this account's balance, so money into a user account reads positive.
// Conformance fixtures fit one page, so there's no next-page cursor.
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

// Stream an account's funds as dated lots, oldest first, for the maturity logic that decides
// when funds become spendable. Yields one lot per posting that increased the balance; legs that
// decreased it are skipped. The maturity rule lives in maturity.ts; here we carry over what each
// posting recorded. A posting with no source or maturity time falls back to "unknown" and to
// mature-now (the safe default).
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

// Stream an account's history in a form the chain verifier can re-hash. For each posting that
// touched the account, in commit order, yields the posting's legs and metadata as written plus the
// account's head hash before and after. The verifier recomputes the "after" hash from legs and
// metadata and checks it still matches.
async function* lineageOf(
  exec: MysqlExecutor,
  account: AccountRef,
): AsyncIterable<StoredLink> {
  // One chain_links row per posting that touched this account (a posting advances the chain once,
  // however many legs it has), so this yields one StoredLink per posting, like the in-memory adapter.
  let postings = await rows(
    exec,
    `SELECT c.posting_id AS txn_id, p.meta AS meta,
            c.prev_hash AS prev_hash, c.hash AS hash
       FROM chain_links c JOIN postings p ON p.id = c.posting_id
      WHERE c.account_id = ? ORDER BY p.seq ASC`,
    [account],
  );
  for (let posting of postings) {
    // The whole posting's legs, not just this account's: chainPreimage filters them itself, so the
    // recompute matches the in-memory reference.
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

// Every leg of one posting, in stable order. The hash recomputation needs all legs, not just
// the verified account's, since it selects the relevant ones itself when rebuilding the input.
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

// Load one whole posting by txn id with all its legs (not filtered to one account, unlike
// lineageOf). `reverse` reads this to post the exact opposite entry. Metadata comes from the
// posting row, legs from legsOf. Returns null when no posting has that id.
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

// Stream every posting, newest commit first (see Ledger.list). Orders by `seq` DESC — the
// ever-increasing commit number (`AUTO_INCREMENT UNIQUE`, a single indexed access path), a total
// order with no tie to break, the SQL mirror of `payout_sagas ORDER BY updated_at DESC`. Each
// posting carries its full legs, the way postingOf returns them, so a reader can expand a row
// without a second round-trip.
async function* listPostingsOf(
  exec: MysqlExecutor,
): AsyncIterable<Posting> {
  for (let row of await rows(
    exec,
    'SELECT id, meta FROM postings ORDER BY seq DESC',
  )) {
    let legs = await legsOf(exec, row.id as string);
    yield { txnId: row.id as string, legs, meta: parseMeta(row.meta) };
  }
}

// How much a stored leg changed its account's balance. Leg amounts use a shared sign convention
// (positive for a debit). Rebuild the leg and apply the account's sign rule: some accounts go up on
// a debit, others on a credit.
function naturalDelta(account: AccountRef, row: Row): Amount {
  let leg: Leg = {
    account,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  };
  return balanceDelta(leg);
}

// --- Idempotency store ------------------------------------------------------------

// Makes a request safe to retry: a given idempotency key is processed at most once, and a retry
// returns the original result.
//
// `claim` is the gate. The key is the `idempotency` primary key, so one row per key. The first
// caller inserts a placeholder row (no result yet) and proceeds. A later caller with the same key
// finds that row:
//   - If the first call finished and saved its result, the later caller gets that result back.
//   - If the first call is still in progress, the later caller blocks on the placeholder row
//     (locked by the unfinished transaction) until that call commits or rolls back.
// If the first call rolls back, its placeholder row disappears with it, so a failed attempt doesn't
// consume the key and the request can be retried.
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

// Reliable event publishing via the transactional-outbox pattern. The event is saved
// (`enqueue`) in the same transaction as the money posting, so it exists exactly when the
// posting does. A relay process later picks up a batch of pending events (`claimBatch`); FOR
// UPDATE SKIP LOCKED lets several relay workers grab different rows at once. The consumer
// de-duplicates by event id, so an event published twice is delivered once.
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
        `SELECT id, event, status, attempts, dead_letter_reason FROM outbox
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
    // Record a failed delivery: bump `attempts` and leave the row pending so the next sweep
    // retries it. The `AND status = 'pending'` guard makes this a no-op on a missing, relayed,
    // or dead-lettered row, matching the in-memory reference (which skips a non-'pending' row).
    recordFailure: async (id) => {
      await rows(
        exec,
        "UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Give up on a poison message: flip to 'failed' so claimBatch never hands it back, keep the
    // reason for operators. The `AND status = 'pending'` guard makes a missing or already-terminal
    // row a no-op, mirroring the saga store and the in-memory reference.
    deadLetter: async (id, reason) => {
      await rows(
        exec,
        "UPDATE outbox SET status = 'failed', dead_letter_reason = ? WHERE id = ? AND status = 'pending'",
        [reason, id],
      );
    },
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox: a verified provider event, already mapped to the Operation it
// applies, is saved (`enqueueInbound`) in the same transaction as the webhook ingress that claimed
// it, so it exists exactly when that ingress commits. A separate apply worker later claims a batch
// of pending rows (`claimInbound`); FOR UPDATE SKIP LOCKED lets several workers grab different rows
// at once. Dedupe is on `key` (the provider event id, UNIQUE in SQL): a redelivered event is a
// no-op insert and returns the existing row, so the event is applied at most once.
function createInboxStore(exec: MysqlExecutor): InboxStore {
  return {
    // INSERT IGNORE swallows the duplicate-key conflict on the UNIQUE `key`, so a redelivered event
    // adds no second row. Either way the row stored under that key is read back and returned, so a
    // duplicate enqueue is a no-op that resolves to the existing row (the idempotency story),
    // mirroring the in-memory reference. MySQL has no RETURNING, so the row is fetched in a second
    // read rather than handed back from the insert the way the postgres twin does. The operation's
    // bigint amounts are carried as decimal strings (encodeOperation) since JSON.stringify can't hold
    // a BigInt.
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
      let found = await rows(
        exec,
        'SELECT id, `key`, operation, status, attempts, received_at, dead_letter_reason FROM inbox WHERE `key` = ? LIMIT 1',
        [entry.key],
      );
      return rowToInbox(found[0]!);
    },
    // Pending rows oldest received_at first, capped at `limit`, row-locked for this worker. FOR
    // UPDATE SKIP LOCKED lets overlapping apply workers grab disjoint batches. `input.now` is
    // accepted for parity with the saga/relay claim; the inbox has no due-time gate, so every
    // pending row is immediately claimable.
    claimInbound: async (input) => {
      let result = await rows(
        exec,
        `SELECT id, \`key\`, operation, status, attempts, received_at, dead_letter_reason FROM inbox
          WHERE status = 'pending' ORDER BY received_at, id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [input.limit],
      );
      return result.map(rowToInbox);
    },
    // Flip a still-pending row to 'applied' so claimInbound never hands it back. The
    // `AND status = 'pending'` guard makes this a no-op on a missing or already-terminal
    // (applied/dead) row, matching the in-memory reference.
    markApplied: async (id) => {
      await rows(
        exec,
        "UPDATE inbox SET status = 'applied' WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Record a failed apply: bump `attempts` and leave the row pending so the next sweep retries it.
    // The `AND status = 'pending'` guard makes this a no-op on a missing or already-terminal row,
    // and (like the outbox) it never touches status — only deadLetter does that.
    bumpAttempt: async (id) => {
      await rows(
        exec,
        "UPDATE inbox SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
        [id],
      );
    },
    // Give up on a poison event: flip to 'dead' so claimInbound never hands it back, keep the reason
    // for operators. The `AND status = 'pending'` guard makes a missing or already-terminal row a
    // no-op, mirroring the outbox/saga dead-letter guards and the in-memory reference.
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

// Whole payout board, newest first (see SagaStore.list). Read-only enumeration, so no FOR UPDATE;
// mirrors postgres. `rows` returns everything in one round trip, yielded one at a time so a
// consumer can stop early. Module-level (like loadSagaOrThrow) to keep createSagaStore short.
async function* listSagasOf(exec: MysqlExecutor): AsyncIterable<Saga> {
  for (let row of await rows(
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
      let found = await rows(
        exec,
        'SELECT * FROM payout_sagas WHERE id = ? LIMIT 1',
        [id],
      );
      return found.length ? rowToSaga(found[0]!) : null;
    },
    list: () => listSagasOf(exec),
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
    advance: async (id, from, to, patch) => {
      // Read-modify-write the whole row (MySQL has no partial UPDATE the way the postgres twin
      // coalesces), overlaying the patch's fields. `payout_usd` is the terminal settle outcome,
      // carried as a USD Amount when settlePayout marks the saga SETTLED and null otherwise.
      let next = { ...(await loadSagaOrThrow(exec, id)), ...patch, state: to };
      let affected = await execWrite(
        exec,
        `UPDATE payout_sagas SET
           reserve = ?, rate_id = ?, state = ?, provider_ref = ?,
           attempts = ?, due_at = ?, updated_at = ?, payout_usd = ?
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
          id,
          from,
        ],
      );
      return affected > 0;
    },
    deadLetter: async (id, reason) => {
      // Record the failure reason on the saga's terminal-outcome `reason` field, so it's read straight
      // off the record instead of re-derived from posting meta.
      await rows(
        exec,
        "UPDATE payout_sagas SET state = 'FAILED', reason = ? WHERE id = ?",
        [reason, id],
      );
    },
    lastPayoutAt: (userId) => lastPayoutOf(exec, userId),
  };
}

// Time of a user's most recent payout request: MAX(updated_at) over all their sagas in any
// state (read by the requestPayout min-interval check). MAX over no rows yields NULL, so a user
// with no sagas reads back null and their first request always passes, like the in-memory
// reference.
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

// Load a saga, throwing if absent. `advance` calls this to get current field values, then
// overlays the few it's changing. A missing saga here means a caller bug; under normal use the
// saga exists by the time advance runs.
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

// Tracks what each user owns (entitlements): ownership state, not money movement, so it touches
// no ledger. `revoke` is a soft delete (set `revoked = true`, keep the row) so audit history a
// refund or clawback may need survives; a later re-grant clears `revoked` via the on-conflict
// path, so re-buying re-activates. `owns` honors expiry: owned while now <= expiresAt, lost once
// now > expiresAt, checked against the injected clock, matching the older reference.
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
    // owns() filters on revoked = false, so this removes ownership while keeping the row.
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

// Tracks recurring subscriptions for the renewal job: find subscriptions whose next charge is
// due (`claimDue`), record a successful charge and schedule the next (`markBilled`), or end one
// that can't be funded (`markLapsed`) or that the user cancels.
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
    // FOR UPDATE SKIP LOCKED, like the saga/promo claimDue, lets overlapping sweepers grab
    // disjoint batches instead of contending over the same due rows.
    claimDue: async (now, limit) => {
      let result = await rows(
        exec,
        `SELECT * FROM subscriptions WHERE state = 'ACTIVE' AND next_due_at <= ?
          ORDER BY next_due_at LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.map(rowToSubscription);
    },
    markBilled: async (id, nextDueAt, expectedDueAt) => {
      // Update the due date only if it still holds the value this caller expects (the UPDATE's
      // WHERE requires next_due_at = `expectedDueAt`). Guards against two renewal workers acting on
      // the same subscription at once: whichever updates first changes the due date, so the second
      // (which expected the now-stale old date) matches no row (affectedRows = 0), returns false,
      // and treats the renewal as already done, never double-charging. The saga store's `advance`
      // guards itself the same way. A successful renewal also resets `attempts` (consecutive failed
      // charges) to 0, so a recovered subscription starts fresh against the retry limit.
      let affected = await execWrite(
        exec,
        `UPDATE subscriptions SET next_due_at = ?, period = period + 1, attempts = 0
          WHERE id = ? AND next_due_at = ?`,
        [nextDueAt, id, expectedDueAt],
      );
      return affected > 0;
    },
    // End a subscription because a renewal charge couldn't be funded (distinct from the user
    // canceling). The UPDATE only applies while still active, so it moves active → lapsed exactly
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

// Tracks each marketing promo grant so the promo-expiry sweep can reverse whatever the user hasn't
// spent once the grant expires. `grantPromo` records the grant here in the same transaction as the
// credit posting; the sweep later claims due grants oldest-first, reverses the unspent remainder,
// then marks each reversed so it isn't reversed twice.
function createPromoStore(exec: MysqlExecutor): PromoStore {
  return {
    // Idempotent on `id`: opening the same grant twice is a no-op, never overwriting or duplicating
    // the first row. `ON DUPLICATE KEY UPDATE id = id` is the MySQL idempotent-insert idiom, a
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

// Records spending attempts per subject (a user or similar) to enforce spending-velocity limits.
// Rows are written on the pool directly, outside the money transaction, so a rejected attempt still
// counts toward the limit (it isn't rolled back with the money). `bump` uses each attempt's
// idempotency key as the primary key (INSERT IGNORE), so retrying the same attempt doesn't
// double-count. `read` sums a subject's recorded attempts.
function createTrustStore(
  pool: MysqlPool,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    // Read the subject's spend inside the sliding window ending now: only attempts newer than
    // `now - windowMs` are summed, so each ages out on its own. The cutoff uses the injected clock
    // (not SQL NOW()) so tests stay deterministic.
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
    // concurrent same-subject calls serialize, insert the attempt (INSERT IGNORE, deduped on the
    // idempotency-key primary key like `bump`), then run the same windowed SUM `read` uses, now
    // including this attempt. The lock is released and the connection returned in `finally`, so a
    // borrower never inherits a stale lock. Serializing the insert and SUM behind one lock closes
    // the velocity-limit TOCTOU that separate read+bump left.
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

// Risk subject (a user id) → MySQL named-lock name, so same-subject `record` calls serialize. Same
// 64-byte cap and prefix#length scheme as `lockName`, kept separate so a subject lock can't collide
// with an account lock of the same string.
function subjectLockName(subject: string): string {
  let tagged = `trust:${subject}`;
  return tagged.length <= 56
    ? tagged
    : `${tagged.slice(0, 48)}#${tagged.length}`;
}

// --- Checkpoint store (used only by background workers) ---------------------------

// Stores checkpoints (periodic signed snapshots of ledger state). Writes append a new row and never
// join a money transaction: once recorded, a checkpoint must survive even if a later money
// transaction rolls back, so it is written on the pool directly (committed on its own).
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

// Makes processing an inbound provider webhook happen at most once, keyed by the provider's own
// event id (a separate id space from the application's idempotency keys). The webhook handler claims
// the `eventId` here only after checking the delivery is authentic and recent, as a standalone write
// on the pool, not inside a money transaction. So a rejected or forged delivery that never reaches
// this point can't use up the id, while a claim that does land stays recorded even if a later money
// posting rolls back.
//
// `claim` inserts the id only if not already present: `INSERT IGNORE` adds the row the first time
// and does nothing on a redelivery, rather than raising a duplicate-key error (same effect as the
// postgres adapter's `on conflict do nothing`). The driver reports affectedRows = 1 on the call
// that inserted and 0 on every later one, so the count distinguishes first delivery from duplicate.
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

// JSON-safe form of the Operation stored in the inbox row's `operation` JSON column. JSON.stringify
// throws on the BigInt inside each Amount, so encodeOperation walks the operation and swaps every
// branded Amount for its `CREDIT:12.34` string (encodeAmount); decodeOperation reverses it,
// rebuilding an Operation with real Amounts equal to the original so the apply worker submits the
// same money move. Same approach as encodeTransaction/decodeTransaction below, generalized over the
// Operation union: walking by the Amount brand keeps the codec working whichever variant (and
// whichever amount-bearing fields) the operation has, with no per-kind branch to drift. Kept local
// here for engine symmetry with the postgres twin (which carries its own copy), not shared.
type EncodedOperation = Record<string, unknown>;

function encodeOperation(operation: Operation): EncodedOperation {
  return encodeAmounts(operation) as EncodedOperation;
}

function decodeOperation(encoded: EncodedOperation): Operation {
  return decodeAmounts(encoded) as Operation;
}

// Deep-copy a value, replacing every branded Amount with its encoded string. Recurses through plain
// objects and arrays; leaves all other scalars untouched. The Amount test comes first so an Amount
// (itself an object) is encoded rather than walked field-by-field.
function encodeAmounts(value: unknown): unknown {
  if (isAmount(value)) {
    return encodeAmount(value);
  }
  if (Array.isArray(value)) {
    return value.map(encodeAmounts);
  }
  if (value !== null && typeof value === 'object') {
    let out: Record<string, unknown> = {};
    for (let [key, inner] of Object.entries(value)) {
      out[key] = encodeAmounts(inner);
    }
    return out;
  }
  return value;
}

// Reverse of encodeAmounts: deep-copy a parsed JSON value, turning every encoded-amount string back
// into an Amount. A string is an encoded amount only when it parses as `CURRENCY:decimal`
// (tryDecodeAmountString); any other string passes through unchanged, so plain string fields
// (idempotencyKey, sku, reason, …) are left alone.
function decodeAmounts(value: unknown): unknown {
  if (typeof value === 'string') {
    let amount = tryDecodeAmountString(value);
    return amount ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeAmounts);
  }
  if (value !== null && typeof value === 'object') {
    let out: Record<string, unknown> = {};
    for (let [key, inner] of Object.entries(value)) {
      out[key] = decodeAmounts(inner);
    }
    return out;
  }
  return value;
}

// Decode an encoded-amount string (`CREDIT:12.34`) back into an Amount, or null if it isn't one. An
// encoded amount is exactly `CURRENCY:decimal`; a colon alone isn't enough, so the decimal part must
// parse (decodeAmount throws on a non-numeric tail) — caught here so an ordinary string that merely
// contains a colon falls through to "not an amount" instead of throwing.
function tryDecodeAmountString(encoded: string): Amount | null {
  let colon = encoded.indexOf(':');
  if (colon < 0) {
    return null;
  }
  let currencyTag = encoded.slice(0, colon) as Amount['currency'];
  let decimal = encoded.slice(colon + 1);
  try {
    return decodeAmount(decimal, currencyTag);
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

// Serialize a transaction to a JSON string for storage. Money amounts become decimal strings first:
// JSON.stringify can't handle bigint, and string-encoding makes a stored transaction read back
// byte-for-byte identical, so a replayed duplicate request returns the original result.
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

// Turn legs into JSON-friendly form for storage. Each leg's amount becomes a "CURRENCY:minor"
// string (e.g. "CREDIT:500"), recording the currency and keeping the exact integer value across the
// round-trip.
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

// Read a JSON column's value. mysql2 normally returns JSON columns already parsed into objects, so
// use the value as-is; if a driver config returns a raw string instead, parse it.
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

// Bundle the stores a request handler may use, all sharing one database connection, so every write
// commits or rolls back together as one transaction. The trust and checkpoint stores are left out:
// they're written outside the money transaction (see their comments above).
function buildUnit(deps: ExecDeps): Unit {
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
 * The hashing and clock services default to the deterministic web-standard ones, so `mysqlStore({
 * pool })` produces reproducible results.
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
    inbox: auto.inbox,
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

// Roll back, ignoring any error from the rollback itself. We're here because `work` threw; that
// original error is the one to report, so a failing rollback must not replace it.
async function safeRollback(connection: MysqlConnection): Promise<void> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    // The original error is the one that matters; ignore a failed rollback.
  }
}

// Drop every named lock the connection holds before it returns to the pool. MySQL named locks stay
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
 * Read the database's stamped schema version from `schema_meta`, or `null` when that table is
 * absent — an un-migrated or pre-versioning database. The composition layer (selectStore) passes the
 * result to {@link assertSchemaCurrent} to fail fast on a schema that has drifted from this code.
 */
export async function readSchemaVersion(pool: MysqlPool): Promise<string | null> {
  try {
    let [rows] = await pool.query('SELECT version FROM schema_meta LIMIT 1');
    let row = (rows as Array<{ version?: string }>)[0];
    return row?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Create all tables and stored routines this adapter needs, from the canonical schema file
 * `db/mysql-schema.sql` (the MySQL counterpart to `db/postgresql-schema.sql`). The file drops and
 * recreates the tables, so running this resets to a clean schema (convenient for tests). Run once
 * during setup (operations tooling or CI), never automatically at app startup.
 *
 * mysql2 sends one statement per `query`, so the file is split into individual statements first
 * (see {@link splitSqlStatements}), then each is run in order.
 */
export async function applyMysqlSchema(pool: MysqlPool): Promise<void> {
  let path = fileURLToPath(
    new URL('../../db/mysql-schema.sql', import.meta.url),
  );
  let sql = await readFile(path, 'utf8');
  // The schema file pins the database collation (its leading ALTER DATABASE) before any DROP/CREATE,
  // so the freshly created tables match the utf8mb4_0900_ai_ci strings JSON_TABLE produces inside
  // post_entry — the same pin `mysql < db/mysql-schema.sql` (scripts/migrate.sh) applies. This just
  // runs the file statement by statement.
  for (let statement of splitSqlStatements(sql)) {
    await pool.query(statement);
  }
}

// Split a `.sql` file into individual statements so each can be sent on its own (mysql2 runs one
// statement per `query`). Statements are separated by the current delimiter, `;` by default. A
// `DELIMITER xxx` line changes it (the same directive the mysql CLI uses); that's how a stored
// routine whose body contains `;` stays one statement: wrapped in `DELIMITER $$ … $$` so the inner
// semicolons aren't read as statement ends. The directive line itself isn't sent to the server.
// Blank lines and `--` comment lines between statements are skipped; a comment inside a statement
// stays with it.
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
 * Create a `mysql2` connection pool from a connection URL. `mysql2` is imported here, only when
 * this function runs, since it's an optional dependency the rest of the code never needs. The pool
 * returns large integer columns (the money columns, stored as 64-bit integers) as strings, which
 * the adapter then converts to bigint exactly.
 */
export async function createMysqlPool(url: string): Promise<MysqlPool> {
  // Hold the module name in a variable instead of writing it directly in import(), so the
  // type-checker doesn't try to resolve this optional dependency at build time (it need only be
  // installed wherever this adapter runs). `@vite-ignore` tells a bundler (Vite/Rollup) the same
  // thing — leave it a runtime import: mysql2 is a server-only optional driver consumers externalize,
  // never bundled — rather than warning that it can't statically analyze the variable specifier.
  let specifier = 'mysql2/promise';
  let mysql = (await import(/* @vite-ignore */ specifier)) as unknown as {
    createPool(config: unknown): MysqlPool;
  };
  return mysql.createPool({
    uri: url,
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false,
    // Pin the connection collation to MySQL 8's utf8mb4 default. Strings produced by JSON_TABLE in
    // post_entry take their collation from the connection; left at mysql2's default the connection is
    // utf8mb4_unicode_ci, which clashes with the utf8mb4_0900_ai_ci table columns on every
    // `ab.account_id = d.account` join ("Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and
    // (utf8mb4_unicode_ci,IMPLICIT)"). Matching the connection to the table/JSON side keeps every `=`
    // in a single collation. (applyMysqlSchema pins the database default to the same collation.)
    charset: 'UTF8MB4_0900_AI_CI',
  });
}
