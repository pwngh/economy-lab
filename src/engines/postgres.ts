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

// `pg` ships no types and this project disables auto-loaded @types, so its default import is
// untyped. Re-typed as PgModule at the binding below.
// @ts-expect-error -- untyped default import; typed at the binding via PgModule.
import pgUntyped from 'pg';

// The slice of `pg` this engine uses: a Pool constructor and types.setTypeParser (overrides
// how a Postgres column type converts to a JS value). Declaring only what we call avoids
// depending on the full vendor types.
interface PgModule {
  Pool: new (config: {
    connectionString: string;
    options?: string;
    max?: number;
    connectionTimeoutMillis?: number;
  }) => PgPool;
  types: {
    setTypeParser(oid: number, parse: (value: string) => unknown): void;
  };
}
const pg = pgUntyped as PgModule;

import { chainHash, balanceDelta, GENESIS } from '#src/ledger.ts';
import {
  toAmount,
  encodeAmount,
  decodeAmountWire,
  isAmount,
} from '#src/money.ts';
import { currency, baseOf } from '#src/accounts.ts';
import { assertSchemaCurrent } from '#src/schema.ts';
import { byCodeUnit, fromHex } from '#src/bytes.ts';
import {
  callProcedure,
  callFunction,
  postEntryArgs,
} from '#src/engines/sql-routines.ts';
import {
  defaultDigest,
  defaultClock,
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
  SaleStore,
  Sale,
  Saga,
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

// Sub-stores query against one of two runtime shapes. A checked-out client is one connection you
// must release. A pool hands clients out.
interface PgClient {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgResult>;
  release(): void;
}
interface PgResult {
  rows: Array<Record<string, unknown>>;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgResult>;
  end(): Promise<void>;
}

// Anything queryable, either the pool (for queries outside a transaction) or a checked-out client
// (for queries inside one). Sub-stores target this so the same code works either way.
type Queryable = Pick<PgPool, 'query'>;

// Return Postgres BIGINT and NUMERIC columns as JS BigInt instead of pg's default strings.
// Balances can exceed 2^53 (largest integer a JS Number holds exactly), which Number would
// lose. Parsers are global per process; resetting is harmless, so calling postgresStore more
// than once is safe.
function configureBigIntParsers(): void {
  pg.types.setTypeParser(20, (value: string) => BigInt(value));
  pg.types.setTypeParser(1700, (value: string) => BigInt(value));
}

// --- Schema isolation -------------------------------------------------------------

// Read db/postgresql-schema.sql, the single SQL file defining all tables. Path resolved
// relative to this module so it works regardless of the process's start directory.
async function loadSchemaSql(): Promise<string> {
  const path = fileURLToPath(
    new URL('../../db/postgresql-schema.sql', import.meta.url),
  );
  return readFile(path, 'utf8');
}

// Reads the database's stamped schema version from schema_meta. Returns null when that table is
// absent, which means an un-migrated or pre-versioning database. This lets the store fail fast (see
// assertSchemaCurrent) rather than silently query a schema that doesn't match this code.
async function readSchemaVersion(pool: PgPool): Promise<string | null> {
  try {
    const result = await pool.query('select version from schema_meta limit 1');
    const row = result.rows[0] as { version?: string } | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

// A schema name can't be a query parameter in CREATE SCHEMA or SET search_path, so it's
// pasted into the SQL text. Guard against injection: lowercase letters, digits, underscores
// only.
function safeSchemaName(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe Postgres schema name: ${JSON.stringify(name)}`);
  }
  return name;
}

// --- The ledger store -------------------------------------------------------------

// True if the account id ends in a user-account kind (spendable, earned, or promo). An id
// looks like `usr_123:spendable`; the part after the last colon is the kind. Distinguishes a
// user account from a platform account.
function isKnownSuffix(account: AccountRef): boolean {
  const colon = account.lastIndexOf(':');
  if (colon < 0) {
    return false;
  }
  const suffix = account.slice(colon + 1);
  return suffix === 'spendable' || suffix === 'earned' || suffix === 'promo';
}

// Reads the tip hash of each given account's chain in one query. `account_balances.head_hash` is
// the maintained head pointer: post_entry advances it to the account's new link hash in the same
// transaction it writes chain_links, so this is an O(1) primary-key read per account. Accounts with
// no balance row are absent, and the caller treats a missing account as the genesis hash (a new
// account's head). The chain_links table stays the source of truth (prove() still re-walks it), so
// a head pointer drifting from the chain surfaces there.
async function headsForAccounts(
  q: Queryable,
  accounts: ReadonlyArray<AccountRef>,
): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  if (accounts.length === 0) {
    return heads;
  }
  const result = await q.query(
    `select account_id, head_hash
       from account_balances
      where account_id = any($1::text[])`,
    [accounts],
  );
  for (const row of result.rows) {
    heads.set(row.account_id as string, row.head_hash as string);
  }
  return heads;
}

// New chain hash for each account this posting touches. Read every tip hash in one query,
// decode the hex to bytes (or genesis bytes for a new account), and pass it plus the posting
// to chainHash (ledger.ts). Pairs each account with its old and new hash so writePosting can
// store them. Hashes are independent across accounts, so batching the head reads matches the
// per-account result.
async function advanceChain(
  q: Queryable,
  digest: Digest,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  const accounts = distinctAccounts(posting.legs);
  const heads = await headsForAccounts(q, accounts);
  const links: Link[] = [];
  for (const account of accounts) {
    const prevHex = heads.get(account) ?? GENESIS_HEX;
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

// A shard of a schema-seeded platform account (`platform:revenue#3`). Bare ids are seeded; a
// shard row is created on first use. A typo with no seeded base stays excluded and faults upstream.
function isPlatformShard(account: AccountRef): boolean {
  const base = baseOf(account);
  return base !== account && isSeededSystemAccount(base);
}

// The row a first-use id gets: kind is the `:kind` suffix for users, 'system' for shards.
function accountRow(account: AccountRef) {
  const kind = isKnownSuffix(account)
    ? account.slice(account.lastIndexOf(':') + 1)
    : 'system';
  return { id: account, kind, currency: currency(account) };
}

// Create the account row if absent (user accounts and platform shards; bare platform ids are
// schema-seeded, so skipped). `on conflict do nothing` keeps repeat calls safe.
async function ensureAccount(q: Queryable, account: AccountRef): Promise<void> {
  if (!isKnownSuffix(account) && !isPlatformShard(account)) {
    return;
  }
  const row = accountRow(account);
  await q.query(
    `insert into accounts (id, kind, currency) values ($1, $2, $3)
       on conflict (id) do nothing`,
    [row.id, row.kind, row.currency],
  );
}

// Batched twin of ensureAccount: one round trip for every first-use account; see ensureAccount.
async function ensureAccounts(
  q: Queryable,
  accounts: ReadonlyArray<AccountRef>,
): Promise<void> {
  const firstUse = accounts.filter(
    (account) => isKnownSuffix(account) || isPlatformShard(account),
  );
  if (firstUse.length === 0) {
    return;
  }
  const newRows = firstUse.map(accountRow);
  await q.query(
    `insert into accounts (id, kind, currency)
       select a.id, a.kind, a.currency
         from jsonb_to_recordset($1::jsonb) as a(id text, kind text, currency text)
       on conflict (id) do nothing`,
    [JSON.stringify(newRows)],
  );
}

// NOTE: the per-leg balance fold (UPDATE the existing row first so the non-negative CHECK runs
// against the new total, then INSERT a first-time row) lives in the `post_entry` stored
// procedure (db/postgresql-schema.sql), which applies every account's net delta in one
// set-based step. The application still decides each delta via `balanceDelta` (postEntryArgs
// in sql-routines.ts); the procedure only persists it.

// Legs and the chain are stored at different granularities: a posting may have several legs to
// one account (e.g. a promo-funded spend) but advances that account's hash chain once. chain_links
// is keyed by (posting, account) — one link per distinct account, never one per leg — and
// advanceChain yields exactly that. Storing every leg keeps lineageOf's recompute byte-identical
// to the in-memory adapter.
// @see https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/
async function writePosting(
  q: Queryable,
  posting: Posting,
  postedAt: number,
  links: ReadonlyArray<Link>,
): Promise<void> {
  // JSON arrays carry the bigint amounts as strings to avoid loss past 2^53.
  const query = (sql: string, params: ReadonlyArray<unknown>) =>
    q.query(sql, params);
  const args = postEntryArgs(posting, links);
  await callProcedure(query, 'postgres', 'post_entry', [
    posting.txnId,
    postedAt,
    JSON.stringify(posting.meta),
    JSON.stringify(args.legs),
    JSON.stringify(args.links),
    JSON.stringify(args.balances),
    JSON.stringify(args.newAccounts),
  ]);
}

function createLedgerStore(q: Queryable, digest: Digest, clock: Clock): Ledger {
  return {
    hasAccount: async (account) => {
      if (isKnownSuffix(account) || isSeededSystemAccount(account)) {
        return true;
      }
      const result = await q.query(`select 1 from accounts where id = $1`, [
        account,
      ]);
      return result.rows.length > 0;
    },

    // No-op here. Locking only makes sense inside a transaction; lockingLedger below is the
    // real implementation, on a transaction client.
    lock: async () => {},

    append: async (posting) => {
      const postedAt = clock.now();
      const links = await advanceChain(q, digest, posting);
      await writePosting(q, posting, postedAt, links);
      return { id: posting.txnId, postedAt, legs: posting.legs, links };
    },

    balance: async (account) => {
      const raw = await callFunction(
        (sql, params) => q.query(sql, params),
        'postgres',
        'account_balance',
        [account],
      );
      return toAmount(currency(account), readMinor(raw));
    },

    statement: async (account, range) => buildStatement(q, account, range),

    balanceAccounts: () => balanceAccountsOf(q),

    timeline: (account, options) => timelineOf(q, account, options),

    heads: () => headsOf(q),

    lineage: (account) => lineageOf(q, account),

    posting: async (txnId) => postingOf(q, txnId),

    list: () => listPostingsOf(q),
  };
}

// Same as createLedgerStore but with a working `lock`: a row-level lock on the account's
// balance row (`for update`), so two transactions writing the same account take turns instead
// of interleaving. Changes no data and advances no hash chain. Only used on a transaction
// client, where the lock releases at commit.
function lockingLedger(q: Queryable, digest: Digest, clock: Clock): Ledger {
  const base = createLedgerStore(q, digest, clock);
  return {
    ...base,
    lock: async (account) => {
      await ensureAccount(q, account);
      await q.query(
        `select 1 from account_balances where account_id = $1 for update`,
        [account],
      );
    },
    lockMany: async (accounts) => {
      // Batched twin of `lock`: ensure the first-use rows exist, then lock every account's balance
      // row in one statement. `order by account_id` makes Postgres take the locks in one global order
      // (the LockRows node pulls already-sorted rows from the Sort beneath it), so operations sharing
      // accounts serialize instead of deadlocking — same guarantee as locking per-account in sorted
      // order, now in a single round trip. A first-use account has no account_balances row yet
      // (post_entry creates it), so it locks nothing here, exactly like `lock`; the chain-fork unique
      // index plus withTransientRetry still cover that cold-start race.
      await ensureAccounts(q, accounts);
      await q.query(
        `select 1 from account_balances
          where account_id = any($1::text[])
          order by account_id
            for update`,
        [[...accounts]],
      );
    },
  };
}

// Amounts are signed by how they changed this account's balance (a credit to a user account reads
// positive). Cursor is always null: the conformance fixtures fit one page.
async function buildStatement(
  q: Queryable,
  account: AccountRef,
  range: Range,
): Promise<Statement> {
  const result = await q.query(
    `select l.posting_id, l.amount, l.currency, p.posted_at
       from legs l
       join postings p on p.id = l.posting_id
      where l.account_id = $1 and p.posted_at >= $2 and p.posted_at < $3
      order by p.seq asc`,
    [account, range.from, range.to],
  );
  const entries = result.rows.map((row) => ({
    txnId: row.posting_id as string,
    amount: balanceDelta({
      account,
      amount: toAmount(
        row.currency as Amount['currency'],
        readMinor(row.amount),
      ),
    }),
    postedAt: Number(row.posted_at),
  }));
  return { account, entries, cursor: null };
}

// Stream an account's incoming funds as lots (one per entry that increased it) so maturity.ts can
// decide how much has matured. Ordered by `l.id` (legs.id, a bigserial) so the composite index
// `legs(account_id, id)` serves the bounded `order by id desc limit n` the maturity tail asks for;
// legs.id and postings.seq share commit order, so for one account this is the same FIFO order.
// Balance-lowering legs (spends) aren't lots and are filtered in code (the credit/debit sign is a
// domain rule, not a column predicate), so the lot-granularity offset/limit apply after that filter.
// @see https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/
async function* timelineOf(
  q: Queryable,
  account: AccountRef,
  options?: TimelineOptions,
): AsyncIterable<Lot> {
  const direction = options?.order === 'desc' ? 'desc' : 'asc';
  const lotOffset = options?.offset ?? 0;
  const lotLimit = options?.limit ?? Infinity;

  // Rows scanned per DB round-trip. Most balances are covered by the first page, so the second
  // query is rarely issued; a finite caller limit caps the page so we never over-fetch.
  const pageSize = Number.isFinite(lotLimit)
    ? Math.max(lotOffset + lotLimit, 1)
    : 256;

  let skipped = 0;
  let yielded = 0;
  for (let rowOffset = 0; yielded < lotLimit; rowOffset += pageSize) {
    const result = await q.query(
      `select l.posting_id, l.amount, l.currency, p.posted_at, p.meta
         from legs l
         join postings p on p.id = l.posting_id
        where l.account_id = $1
        order by l.id ${direction}
        limit $2 offset $3`,
      [account, pageSize, rowOffset],
    );
    if (result.rows.length === 0) {
      return;
    }
    for (const row of result.rows) {
      const lot = rowToLot(account, row);
      // A balance-lowering leg (a spend) is not a lot; skip it without consuming an offset/limit
      // slot, so the lot-granularity `offset`/`limit` count only real lots.
      if (lot === null) {
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
      yield lot;
    }
    // A short page means the table is exhausted; no later page can exist.
    if (result.rows.length < pageSize) {
      return;
    }
  }
}

// Turn one raw legs+postings row into a Lot, or null when the leg lowered the account's balance (a
// spend), which is not a lot. The credit/debit sign is the account's domain rule, so this filter
// lives in code, not SQL. Maturity/source come from the posting meta, defaulting to an immediately
// available 'unknown' source when absent (see the timeline doc-comment).
function rowToLot(
  account: AccountRef,
  row: Record<string, unknown>,
): Lot | null {
  const delta = balanceDelta({
    account,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  });
  if (delta.minor <= 0n) {
    return null;
  }
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const postedAt = Number(row.posted_at);
  return {
    txnId: row.posting_id as string,
    amount: delta,
    source: metaString(meta, 'source', 'unknown'),
    toppedUpAt: postedAt,
    maturesAt: metaNumber(meta, 'maturesAt', postedAt),
  };
}

async function* headsOf(
  q: Queryable,
): AsyncIterable<readonly [AccountRef, string]> {
  const result = await q.query(
    `select distinct on (c.account_id) c.account_id, c.hash
       from chain_links c
       join postings p on p.id = c.posting_id
      order by c.account_id, p.seq desc`,
  );
  // Code-unit order in the app (not the DB's collation) so every engine lists accounts identically.
  result.rows.sort((a, b) =>
    byCodeUnit(a.account_id as string, b.account_id as string),
  );
  for (const row of result.rows) {
    yield [row.account_id as AccountRef, row.hash as string] as const;
  }
}

// Stream every account whose account_balances row reflects real activity. The cached running total
// can drift from the sum of the account's entry lines (the source of truth); this scan is how the
// integrity checker reaches a cached balance with no entries behind it, since heads() (built from
// the hash chain) never lists such an account.
//
// Skip the seeded house-account placeholders. We plant an empty row for each house account (genesis
// head, zero balance) only so lockAccounts' `for update` has something to grab on the first write; it
// carries no history and reads exactly like no row, so leaving it out keeps this listing matching the
// pre-seed behavior and the in-memory adapter. The `or balance <> 0` is the exception: a genesis-head
// row with a non-zero balance is no longer a placeholder, it is the drift this scan looks for.
async function* balanceAccountsOf(q: Queryable): AsyncIterable<AccountRef> {
  const result = await q.query(
    `select account_id from account_balances
       where head_hash <> repeat('0', 64) or balance <> 0`,
  );
  // Code-unit order in the app (not the DB's collation) so every engine lists accounts identically.
  result.rows.sort((a, b) =>
    byCodeUnit(a.account_id as string, b.account_id as string),
  );
  for (const row of result.rows) {
    yield row.account_id as AccountRef;
  }
}

// See https://economy-lab-docs.pages.dev/economy/concepts/integrity/ for the per-account chain
// this streams.
async function* lineageOf(
  q: Queryable,
  account: AccountRef,
): AsyncIterable<StoredLink> {
  // One chain_links row per posting that touched this account (a posting advances the chain
  // once however many legs it has to the account), so this yields one StoredLink per such
  // posting, matching the in-memory adapter.
  const result = await q.query(
    `select c.posting_id, c.prev_hash, c.hash, p.meta
       from chain_links c
       join postings p on p.id = c.posting_id
      where c.account_id = $1
      order by p.seq asc`,
    [account],
  );
  // Batch every posting's legs in one query instead of a legsOf round trip per row (an N+1 on the
  // audit path, which walks the whole chain anyway). The whole posting's legs, not just this
  // account's: chainPreimage filters to the account's own legs, so the recompute matches the
  // in-memory reference.
  const legsByTxn = await legsByPosting(
    q,
    result.rows.map((row) => row.posting_id as string),
  );
  for (const row of result.rows) {
    const txnId = row.posting_id as string;
    yield {
      txnId,
      legs: legsByTxn.get(txnId) ?? [],
      meta: (row.meta ?? {}) as Record<string, unknown>,
      prevHash: row.prev_hash as string,
      hash: row.hash as string,
    };
  }
}

// Load a whole posting by transaction id: its metadata and all entry lines (not just one
// account's, the way lineageOf works). Undoing a transaction needs every line to post the
// opposite. Returns null when no posting has that id.
async function postingOf(q: Queryable, txnId: string): Promise<Posting | null> {
  const result = await q.query(`select meta from postings where id = $1`, [
    txnId,
  ]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const legs = await legsOf(q, txnId);
  return {
    txnId,
    legs,
    meta: (row.meta ?? {}) as Record<string, unknown>,
  };
}

// Newest commit first via `order by seq desc` (bigserial unique: a total order, no tie to break).
// Each posting carries its full legs so a reader can expand a row without a second round trip.
async function* listPostingsOf(q: Queryable): AsyncIterable<Posting> {
  const result = await q.query(
    `select id, meta from postings order by seq desc`,
  );
  // One batched legs read instead of a legsOf round trip per posting (the same N+1 fold as lineageOf).
  // ledger.list() consumers buffer the whole stream, so reading the legs up front changes nothing they
  // observe.
  const legsByTxn = await legsByPosting(
    q,
    result.rows.map((row) => row.id as string),
  );
  for (const row of result.rows) {
    const txnId = row.id as string;
    yield {
      txnId,
      legs: legsByTxn.get(txnId) ?? [],
      meta: (row.meta ?? {}) as Record<string, unknown>,
    };
  }
}

// Load all entry lines of one posting in stored order, each rebuilt as a signed Leg (account
// plus signed amount). postingOf and lineageOf both use this; the hash is computed from the
// whole posting, so every line is needed.
async function legsOf(q: Queryable, txnId: string): Promise<Leg[]> {
  const result = await q.query(
    `select account_id, amount, currency from legs
      where posting_id = $1 order by id asc`,
    [txnId],
  );
  return result.rows.map((row) => ({
    account: row.account_id as AccountRef,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  }));
}

// Batched twin of legsOf: every leg of many postings in one round trip, grouped by posting id and
// rebuilt exactly as legsOf does, so batched and per-posting paths return byte-identical legs.
async function legsByPosting(
  q: Queryable,
  postingIds: ReadonlyArray<string>,
): Promise<Map<string, Leg[]>> {
  const byPosting = new Map<string, Leg[]>();
  if (postingIds.length === 0) {
    return byPosting;
  }
  const result = await q.query(
    `select posting_id, account_id, amount, currency from legs
      where posting_id = any($1::text[]) order by posting_id, id asc`,
    [[...postingIds]],
  );
  for (const row of result.rows) {
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

// --- Idempotency store ------------------------------------------------------------

// Makes a request sent twice run only once, keyed per request. `claim` replays the stored result
// if a row exists; otherwise it takes a request-keyed lock (pg_advisory_xact_lock) and rechecks, so
// a second same-key caller waits for the first's transaction and then either replays it (committed)
// or does the work (rolled back). `record` inserts the result row in the same transaction as the
// posting, so a rollback leaves no row and the key stays usable for a real retry.
// @see https://economy-lab-docs.pages.dev/economy/concepts/idempotency/
function createIdempotencyStore(q: Queryable): IdempotencyStore {
  return {
    claim: async (key) => {
      const existing = await q.query(
        `select transaction from idempotency where key = $1`,
        [key],
      );
      const prior = existing.rows[0];
      if (prior) {
        return {
          claimed: false,
          transaction: decodeTransaction(
            prior.transaction as EncodedTransaction,
          ),
        };
      }
      await q.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        key,
      ]);
      const recheck = await q.query(
        `select transaction from idempotency where key = $1`,
        [key],
      );
      const recorded = recheck.rows[0];
      if (recorded) {
        return {
          claimed: false,
          transaction: decodeTransaction(
            recorded.transaction as EncodedTransaction,
          ),
        };
      }
      return { claimed: true };
    },
    record: async (key, transaction) => {
      await q.query(
        `insert into idempotency (key, transaction) values ($1, $2::jsonb)`,
        [key, JSON.stringify(encodeTransaction(transaction))],
      );
    },
  };
}

// JSON-safe Transaction for the idempotency row: JSON.stringify throws on BigInt, so each amount
// becomes a string (encodeAmount); decode reverses it so a replay returns the same result.
interface EncodedLeg {
  account: string;
  amount: string;
}
interface EncodedTransaction {
  id: string;
  postedAt: number;
  legs: ReadonlyArray<EncodedLeg>;
  links: Transaction['links'];
}

function encodeTransaction(transaction: Transaction): EncodedTransaction {
  return {
    id: transaction.id,
    postedAt: transaction.postedAt,
    legs: transaction.legs.map((leg) => ({
      account: leg.account,
      amount: encodeAmount(leg.amount),
    })),
    links: transaction.links,
  };
}

function decodeTransaction(encoded: EncodedTransaction): Transaction {
  return {
    id: encoded.id,
    postedAt: encoded.postedAt,
    legs: encoded.legs.map((leg) => ({
      account: leg.account as AccountRef,
      amount: decodeAmountWire(leg.amount),
    })),
    links: encoded.links,
  };
}

// --- Replay store -----------------------------------------------------------------

// Dedups raw inbound provider webhooks by the provider's event id, separate from the domain
// idempotency key space. `claim` is an atomic insert-if-absent over seen_webhooks: `on conflict
// do nothing` plus `returning event_id` inserts the id and reports whether it was new in one
// statement. A returned row means first sighting (claimed); no row means a redelivery. Run as
// the last webhook gate, after the signature check (payload came from the provider) and the
// freshness check (rejects stale ones), so a rejected delivery never burns the id and a later
// genuine redelivery still processes.
function createReplayStore(q: Queryable): ReplayStore {
  return {
    claim: async (eventId) => {
      const result = await q.query(
        `insert into seen_webhooks (event_id) values ($1)
           on conflict (event_id) do nothing
           returning event_id`,
        [eventId],
      );
      return { claimed: result.rows.length > 0 };
    },
  };
}

// --- Sale store -------------------------------------------------------------------

// Entry lines stored as JSON, each amount as its minor-units string, since JSON can't hold BigInt.
// @see https://economy-lab-docs.pages.dev/economy/reference/operations/refund/
function createSaleStore(q: Queryable): SaleStore {
  return {
    put: async (sale) => {
      await q.query(
        `insert into sales (order_id, buyer_id, recipient_id, sku, price, fee, legs, txn_id, posted_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           on conflict (order_id) do update set
             buyer_id = excluded.buyer_id, recipient_id = excluded.recipient_id,
             sku = excluded.sku, price = excluded.price, fee = excluded.fee,
             legs = excluded.legs, txn_id = excluded.txn_id, posted_at = excluded.posted_at`,
        [
          sale.orderId,
          sale.buyerId,
          sale.recipientId ?? null,
          sale.sku,
          sale.price.minor,
          sale.fee.minor,
          JSON.stringify(encodeLegs(sale.legs)),
          sale.txnId,
          sale.postedAt,
        ],
      );
    },
    get: async (orderId) => {
      const result = await q.query(`select * from sales where order_id = $1`, [
        orderId,
      ]);
      const row = result.rows[0];
      return row ? rowToSale(row) : null;
    },
  };
}

// Convert entry lines into a JSON-safe array, each BigInt amount as a string. rowToSale
// reverses this.
function encodeLegs(
  legs: ReadonlyArray<Leg>,
): Array<{ account: string; currency: string; minor: string }> {
  return legs.map((leg) => ({
    account: leg.account,
    currency: leg.amount.currency,
    minor: leg.amount.minor.toString(),
  }));
}

function rowToSale(row: Record<string, unknown>): Sale {
  const raw = row.legs as Array<{
    account: string;
    currency: string;
    minor: string;
  }>;
  const legs: Leg[] = raw.map((leg) => ({
    account: leg.account as AccountRef,
    amount: toAmount(leg.currency as Amount['currency'], BigInt(leg.minor)),
  }));
  const priceCurrency = (legs[0]?.amount.currency ??
    'CREDIT') as Amount['currency'];
  return {
    orderId: row.order_id as string,
    buyerId: row.buyer_id as string,
    recipientId: (row.recipient_id as string | null) ?? undefined,
    sku: row.sku as string,
    price: toAmount(priceCurrency, readMinor(row.price)),
    fee: toAmount(priceCurrency, readMinor(row.fee)),
    legs,
    txnId: row.txn_id as string,
    postedAt: Number(row.posted_at),
  };
}

// --- Outbox store -----------------------------------------------------------------

// The transactional-outbox sub-store: `enqueue` writes the event in the same transaction as the
// money move, a relay later reads a batch (`claimBatch`), sends each, and calls `markRelayed`.
// `claimBatch` uses `for update skip locked` so several relay workers run at once without two
// grabbing the same row.
// See https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ for the outbox
// pattern (write-with-the-transaction, relay-later, dedupe-by-id).
function createOutboxStore(q: Queryable): OutboxStore {
  return {
    enqueue: async (message) => {
      await q.query(
        `insert into outbox (id, event, status, attempts)
           values ($1, $2::jsonb, $3, $4)`,
        [
          message.id,
          JSON.stringify(message.event),
          message.status,
          message.attempts,
        ],
      );
    },
    claimBatch: async (limit) => {
      const result = await q.query(
        `select id, event, status, attempts, dead_letter_reason from outbox
          where status = 'pending'
          order by created_at asc
          limit $1
          for update skip locked`,
        [limit],
      );
      return result.rows.map(rowToOutbox);
    },
    markRelayed: async (ids) => {
      if (ids.length === 0) {
        return;
      }
      // The `and status = 'pending'` clause stops a stale resend from flipping a row back to
      // 'relayed' once it has been dead-lettered or already relayed. This is the same terminal-state
      // guard recordFailure uses and the in-memory reference applies (it skips any non-'pending' row).
      await q.query(
        `update outbox set status = 'relayed'
          where id = any($1::text[]) and status = 'pending'`,
        [[...ids]],
      );
    },
    // Record a failed delivery: bump attempts by one but keep the row 'pending' so the
    // next sweep retries it. Same terminal-state guard as markRelayed above.
    recordFailure: async (id) => {
      await q.query(
        `update outbox set attempts = attempts + 1
          where id = $1 and status = 'pending'`,
        [id],
      );
    },
    // Give up on a poison message: flip it to 'failed' (so claimBatch never returns it again)
    // and persist the reason. Same terminal-state guard as markRelayed above.
    deadLetter: async (id, reason) => {
      await q.query(
        `update outbox set status = 'failed', dead_letter_reason = $2
          where id = $1 and status = 'pending'`,
        [id, reason],
      );
    },
  };
}

function rowToOutbox(row: Record<string, unknown>): OutboxMessage {
  return {
    id: row.id as string,
    event: row.event as OutboxMessage['event'],
    status: row.status as OutboxMessage['status'],
    attempts: Number(row.attempts),
    reason: (row.dead_letter_reason as string | null) ?? null,
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox. `enqueueInbound` writes the row in the same transaction as
// the webhook ingress that claimed it, and dedupes on `key` (the provider event id, UNIQUE in
// SQL) so a redelivered event is a no-op that returns the existing row. A separate apply worker
// reads a batch (`claimInbound`) and calls `markApplied`. `claimInbound` uses `for update skip
// locked` so several apply workers run at once without two grabbing the same row.
// See https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ for the inbox pattern
// (record-in-the-ingress-transaction, apply-later, dedupe-by-id).
function createInboxStore(q: Queryable): InboxStore {
  return {
    // A redelivery (no row from `on conflict do nothing ... returning`) falls through to re-reading
    // the canonical row by key. Operation amounts are decimal strings (encodeOperation): jsonb has
    // no BigInt.
    enqueueInbound: async (entry) => {
      const inserted = await q.query(
        `insert into inbox (id, key, operation, status, attempts, received_at)
           values ($1, $2, $3::jsonb, $4, $5, $6)
           on conflict (key) do nothing
           returning id, key, operation, status, attempts, received_at, dead_letter_reason`,
        [
          entry.id,
          entry.key,
          JSON.stringify(encodeOperation(entry.operation)),
          entry.status,
          entry.attempts,
          entry.receivedAt,
        ],
      );
      const row = inserted.rows[0];
      if (row) {
        return rowToInbox(row);
      }
      const existing = await q.query(
        `select id, key, operation, status, attempts, received_at, dead_letter_reason from inbox
          where key = $1`,
        [entry.key],
      );
      return rowToInbox(existing.rows[0]!);
    },
    // Pending rows oldest `received_at` first, capped at `input.limit`, each row-locked for this
    // worker. Only 'pending' rows are returned; an 'applied' or 'dead' row is terminal and never
    // re-claimed, so a poison event can't wedge the queue. `input.now` is accepted for parity with
    // the saga/relay claim; the inbox has no due-time gate.
    claimInbound: async (input) => {
      const result = await q.query(
        `select id, key, operation, status, attempts, received_at, dead_letter_reason from inbox
          where status = 'pending'
          order by received_at asc
          limit $1
          for update skip locked`,
        [input.limit],
      );
      return result.rows.map(rowToInbox);
    },
    // Mark a row applied once its operation has committed: flip 'pending' to 'applied' so
    // `claimInbound` never returns it again. Same terminal-state guard as the outbox's markRelayed.
    markApplied: async (id) => {
      await q.query(
        `update inbox set status = 'applied' where id = $1 and status = 'pending'`,
        [id],
      );
    },
    // Record a failed apply: bump attempts by one but keep the row 'pending' so the next sweep
    // retries it. Same terminal-state guard as markApplied.
    bumpAttempt: async (id) => {
      await q.query(
        `update inbox set attempts = attempts + 1
          where id = $1 and status = 'pending'`,
        [id],
      );
    },
    // Give up on a poison event: flip it to 'dead' (so claimInbound never returns it again) and
    // persist the reason. Same terminal-state guard as markApplied.
    deadLetter: async (id, reason) => {
      await q.query(
        `update inbox set status = 'dead', dead_letter_reason = $2
          where id = $1 and status = 'pending'`,
        [id, reason],
      );
    },
  };
}

function rowToInbox(row: Record<string, unknown>): InboxEntry {
  return {
    id: row.id as string,
    key: row.key as string,
    operation: decodeOperation(row.operation as EncodedOperation),
    status: row.status as InboxEntry['status'],
    attempts: Number(row.attempts),
    receivedAt: Number(row.received_at),
    reason: (row.dead_letter_reason as string | null) ?? null,
  };
}

// JSON-safe form of the Operation stored in the inbox row's jsonb column. JSON.stringify throws on
// the BigInt inside each Amount, so encodeOperation walks the operation and swaps every branded
// Amount for its `CREDIT:12.34` string (encodeAmount); decodeOperation reverses it, rebuilding an
// Operation with real Amounts equal to the original so the apply worker submits the same money
// move. Same approach as encodeTransaction/decodeTransaction above, generalized over the Operation
// union: walking by the Amount brand keeps the codec working whichever variant (and whichever
// amount-bearing fields) the operation has, with no per-kind branch to drift.
type EncodedOperation = Record<string, unknown>;

function encodeOperation(operation: Operation): EncodedOperation {
  return encodeAmounts(operation) as EncodedOperation;
}

function decodeOperation(encoded: EncodedOperation): Operation {
  return decodeAmounts(encoded) as Operation;
}

// The isAmount test comes first so an Amount (itself an object) is encoded, not walked field-by-field.
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

// Reverse of encodeAmounts. A string is an encoded amount only if it parses as `CURRENCY:decimal`
// (tryDecodeAmountString); any other string (idempotencyKey, sku, reason, ...) passes through.
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

// Decodes an encoded-amount string (`CREDIT:12.34`) back into an Amount, or returns null if it
// isn't one. An encoded amount is exactly `CURRENCY:decimal`, so a colon alone isn't enough and the
// decimal part must parse (decodeAmount throws on a non-numeric tail). This function catches that
// throw so an ordinary string that merely contains a colon falls through to "not an amount".
function tryDecodeAmountString(encoded: string): Amount | null {
  if (encoded.indexOf(':') < 0) {
    return null;
  }
  try {
    return decodeAmountWire(encoded);
  } catch {
    return null;
  }
}

// --- Saga store -------------------------------------------------------------------

// No `for update`: a read-only enumeration, not a claim.
async function* listSagasOf(q: Queryable): AsyncIterable<Saga> {
  const result = await q.query(
    `select * from payout_sagas order by updated_at desc`,
  );
  for (const row of result.rows) {
    yield rowToSaga(row);
  }
}

// Tracks the multi-step payout process for paying a user out in real money. Each payout moves
// through states (requested, reserved, submitted, settled, failed). `advance` moves a payout to
// the next state only if it is still in the state the caller expected (the `where ... and state
// = $2` clause), and returns whether the update happened. So if two background sweeps try to
// move the same payout at once, only one succeeds and the step never runs twice.
function createSagaStore(q: Queryable): SagaStore {
  return {
    open: async (saga) => {
      await q.query(
        `insert into payout_sagas
           (id, user_id, reserve, rate_id, state, provider_ref, attempts, due_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do nothing`,
        [
          saga.id,
          saga.userId,
          saga.reserve.minor,
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
      const result = await q.query(`select * from payout_sagas where id = $1`, [
        id,
      ]);
      const row = result.rows[0];
      return row ? rowToSaga(row) : null;
    },
    list: () => listSagasOf(q),
    // Find payouts that are due and still in progress. A payout reaches RESERVED in the same
    // step that first creates it, so a row left in the earlier REQUESTED state means that step
    // crashed partway. Such a stuck row is skipped on purpose: this query picks up only RESERVED
    // and SUBMITTED rows. (The matching index in db/postgresql-schema.sql excludes REQUESTED the
    // same way, so this query can use it.) Matches the in-memory reference and the MySQL engine.
    claimDue: async (now, limit) => {
      const result = await q.query(
        `select * from payout_sagas
          where due_at <= $1 and state in ('RESERVED', 'SUBMITTED')
          order by due_at asc
          limit $2
          for update skip locked`,
        [now, limit],
      );
      return result.rows.map(rowToSaga);
    },
    advance: async (id, from, to, patch) => {
      // `payout_usd` is the terminal settle outcome (patch carries the USD Amount when settlePayout
      // marks the saga SETTLED); `reason` is the terminal failure outcome (carried when the worker
      // CAS-fails a stuck/abandoned payout to FAILED). Both left as-is on every other advance via
      // coalesce, so a non-terminal advance never disturbs them.
      const result = await q.query(
        `update payout_sagas
            set state = $3,
                provider_ref = coalesce($4, provider_ref),
                attempts = coalesce($5, attempts),
                due_at = coalesce($6, due_at),
                updated_at = coalesce($7, updated_at),
                payout_usd = coalesce($8, payout_usd),
                reason = coalesce($9, reason)
          where id = $1 and state = $2
          returning id`,
        [
          id,
          from,
          to,
          patch.providerRef ?? null,
          patch.attempts ?? null,
          patch.dueAt ?? null,
          patch.updatedAt ?? null,
          patch.payoutUsd?.minor ?? null,
          patch.reason ?? null,
        ],
      );
      return result.rows.length > 0;
    },
    deadLetter: async (id, reason) => {
      await advanceToFailed(q, id, reason);
    },
    // Null when the user has no sagas, so their first request always passes the min-interval gate.
    lastPayoutAt: async (userId) => {
      const result = await q.query(
        `select max(updated_at) as last from payout_sagas where user_id = $1`,
        [userId],
      );
      const value = result.rows[0]?.last;
      return value === null || value === undefined ? null : Number(value);
    },
  };
}

async function advanceToFailed(
  q: Queryable,
  id: string,
  reason: string,
): Promise<void> {
  await q.query(
    `update payout_sagas
        set state = 'FAILED', reason = $2
      where id = $1`,
    [id, reason],
  );
}

// --- Entitlement store ------------------------------------------------------------

// Tracks which users own which products (an "entitlement" is a record of ownership, e.g. a
// purchased item or subscription perk). Plain ownership data, not a money entry. revoke is a
// soft delete (revoked=true, keeps the row for audit), so a later owns() check returns false but
// refund/clawback ownership history survives. The clock is injected so owns() can tell whether
// an entitlement has expired without a clock argument of its own (owns()'s signature is fixed).
function createEntitlementStore(q: Queryable, clock: Clock): EntitlementStore {
  return {
    grant: async (userId, sku, attrs) => {
      await q.query(
        `insert into entitlements (user_id, sku, quantity, version, expires_at, source)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (user_id, sku) do update set
             quantity = excluded.quantity, version = excluded.version,
             expires_at = excluded.expires_at, source = excluded.source,
             revoked = false`,
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
      await q.query(
        `update entitlements set revoked = true where user_id = $1 and sku = $2`,
        [userId, sku],
      );
    },
    owns: async (userId, sku) => {
      // Owned only if not revoked and not expired. Boundary is inclusive (owned while now <=
      // expiresAt, lapsed once now > expiresAt), so `expires_at >= now`. A null expires_at never
      // lapses. Read is side-effect-free (no auto-purge).
      const result = await q.query(
        `select 1 from entitlements
          where user_id = $1 and sku = $2 and revoked = false
            and (expires_at is null or expires_at >= $3)`,
        [userId, sku, clock.now()],
      );
      return result.rows.length > 0;
    },
  };
}

// --- Subscription store -----------------------------------------------------------

// Tracks recurring subscriptions. A subscription is opened, then a background sweep finds the
// ones whose next charge is due (claimDue), bills them (markBilled, which moves the due date
// forward), and ends them when needed (cancel by the user, or markLapsed when a renewal can't
// be paid).
function createSubscriptionStore(q: Queryable): SubscriptionStore {
  return {
    // The worker re-opens a subscription to persist a bumped retry attempt
    // (`open({ ...sub, attempts: next })`), so this must upsert rather than `do nothing`:
    // insert-on-conflict-do-nothing would keep the old attempts count and the retry cap would
    // never advance, diverging from the in-memory reference's full-row overwrite. The identity
    // columns (user_id/seller_id/sku/price/period_ms) never change for a given id, so the update
    // set covers only the mutable lifecycle fields.
    open: async (sub) => {
      await q.query(
        `insert into subscriptions
           (id, user_id, seller_id, sku, price, period_ms, state, period, attempts, next_due_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (id) do update set
             state = excluded.state, period = excluded.period,
             attempts = excluded.attempts, next_due_at = excluded.next_due_at,
             updated_at = excluded.updated_at`,
        [
          sub.id,
          sub.userId,
          sub.sellerId,
          sub.sku,
          sub.price.minor,
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
      const result = await q.query(
        `select * from subscriptions where id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? rowToSubscription(row) : null;
    },
    // The subscribe handler reads this to refuse a duplicate active subscription that would double-bill.
    activeFor: async (userId, sku, sellerId) => {
      const result = await q.query(
        `select * from subscriptions
          where user_id = $1 and sku = $2 and seller_id = $3 and state = 'ACTIVE'
          limit 1`,
        [userId, sku, sellerId],
      );
      const row = result.rows[0];
      return row ? rowToSubscription(row) : null;
    },
    cancel: async (id) => {
      await q.query(
        `update subscriptions set state = 'CANCELED' where id = $1`,
        [id],
      );
    },
    // `for update skip locked` (like the saga claimDue) lets overlapping sweepers each grab a
    // disjoint batch instead of two fighting over (and double-billing) the same due row.
    claimDue: async (now, limit) => {
      const result = await q.query(
        `select * from subscriptions
          where state = 'ACTIVE' and next_due_at <= $1
          order by next_due_at asc
          limit $2
          for update skip locked`,
        [now, limit],
      );
      return result.rows.map(rowToSubscription);
    },
    // A successful renewal clears the retry counter (attempts = 0), advances the period, and sets
    // the next due date, but only as a compare-and-set against the period the sweeper claimed
    // (next_due_at = expectedDueAt). If another overlapping sweeper already billed this period and
    // moved next_due_at on, no row matches and this returns false, so the loser treats it as a
    // no-op and never double-charges. SagaStore.advance guards its state change the same way.
    markBilled: async (id, nextDueAt, expectedDueAt) => {
      const result = await q.query(
        `update subscriptions
            set next_due_at = $2, period = period + 1, attempts = 0
          where id = $1 and next_due_at = $3
          returning id`,
        [id, nextDueAt, expectedDueAt],
      );
      return result.rows.length > 0;
    },
    // End a subscription because a renewal charge couldn't be paid (vs. the user canceling).
    // State LAPSED takes it out of the "active and due" set the billing sweep picks up, so it
    // won't be charged again.
    markLapsed: async (id) => {
      await q.query(`update subscriptions set state = 'LAPSED' where id = $1`, [
        id,
      ]);
    },
  };
}

// --- Promo store ------------------------------------------------------------------

// Tracks each marketing promo grant so the promo-expiry sweep can reverse whatever the user
// hasn't spent once the grant expires. `grantPromo` records the grant here in the same
// transaction as the credit posting, sharing that posting's id, so the grant only persists if
// the posting commits. `open` is idempotent on the id (`on conflict do nothing`, like
// SagaStore.open) and must not overwrite an existing grant. `claimDue` hands the sweep up to
// `limit` grants that have expired and aren't yet reversed, oldest first, with a `for update
// skip locked` lock so concurrent sweeps don't grab the same row. `markReversed`'s `and
// reversed = false` guard makes it a no-op on a missing or already-reversed row, so re-running
// the sweep over the same grant is harmless.
function createPromoStore(q: Queryable): PromoStore {
  return {
    open: async (grant) => {
      await q.query(
        `insert into promo_grants (id, user_id, amount, currency, expires_at, reversed)
           values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
        [
          grant.id,
          grant.userId,
          grant.amount.minor,
          grant.amount.currency,
          grant.expiresAt,
          grant.reversed,
        ],
      );
    },
    claimDue: async (now, limit) => {
      const result = await q.query(
        `select * from promo_grants
           where expires_at <= $1 and reversed = false
           order by expires_at asc
           limit $2
           for update skip locked`,
        [now, limit],
      );
      return result.rows.map(rowToPromoGrant);
    },
    markReversed: async (id) => {
      await q.query(
        `update promo_grants set reversed = true where id = $1 and reversed = false`,
        [id],
      );
    },
  };
}

function rowToPromoGrant(row: Record<string, unknown>): PromoGrant {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
    expiresAt: Number(row.expires_at),
    reversed: row.reversed as boolean,
  };
}

// --- Trust store -------------------------------------------------------------------

// Records each spend attempt by a user so a fraud check can see recent spend and cap it. Two
// views: this pool-backed store commits on its own, and the Unit view (createUnitTrustStore
// below) writes inside the money transaction. `submit` combines them so a committed attempt
// shares the money commit and a rolled-back one still counts. `bump` inserts keyed on the
// attempt's idempotency key (the primary key), so resending the same attempt doesn't count it
// twice. `read` sums a user's recorded attempts.
function createTrustStore(
  pool: PgPool,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    // The risk check reads the subject's spend in the sliding window ending now: only attempts
    // newer than `now - windowMs` are summed, so each ages out on its own. Cutoff comes from the
    // injected clock (not SQL `now()`) so tests stay deterministic.
    read: async (subject) =>
      readVelocity(pool, subject, clock.now() - windowMs),
    bump: async (subject, attempt) => bumpVelocity(pool, subject, attempt),
    // Record-and-measure atomically. The insert and the windowed SUM run in one transaction
    // guarded by a per-subject advisory lock, so two concurrent same-subject calls serialize: the
    // second waits, then sums a total that already includes the first's insert — the atomicity
    // `TrustStore.record` requires (ports.ts).
    record: async (subject, attempt) =>
      recordVelocity(pool, subject, attempt, clock.now() - windowMs),
  };
}

async function readVelocity(
  q: Queryable,
  subject: string,
  cutoff: number,
): Promise<Velocity> {
  const result = await q.query(
    `select coalesce(min(at), 0) as window_start,
            coalesce(sum(amount), 0) as spent,
            count(*)::int as attempts
       from trust_attempts where subject = $1 and at > $2`,
    [subject, cutoff],
  );
  const row = result.rows[0]!;
  return {
    subject,
    windowStart: Number(row.window_start),
    spent: toAmount('CREDIT', readMinor(row.spent)),
    attempts: Number(row.attempts),
  };
}

async function bumpVelocity(
  q: Queryable,
  subject: string,
  attempt: Attempt,
): Promise<void> {
  await q.query(
    `insert into trust_attempts (idempotency_key, subject, amount, outcome, at)
       values ($1, $2, $3, $4, $5)
       on conflict (idempotency_key) do nothing`,
    [
      attempt.idempotencyKey,
      subject,
      attempt.amount.minor,
      attempt.outcome,
      attempt.at,
    ],
  );
}

// The transaction-scoped trust view a Unit carries. `record` runs on the money transaction's own
// connection, so the inserted attempt commits with the money. The advisory lock holds until that
// transaction commits or rolls back, and a concurrent same-subject `record` waits it out. That is
// the same per-subject serialization `recordVelocity` below gets from its own short transaction.
function createUnitTrustStore(
  q: Queryable,
  clock: Clock,
  windowMs: number,
): TrustStore {
  return {
    read: async (subject) => readVelocity(q, subject, clock.now() - windowMs),
    bump: async (subject, attempt) => bumpVelocity(q, subject, attempt),
    record: async (subject, attempt) => {
      await q.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        subject,
      ]);
      await bumpVelocity(q, subject, attempt);
      return readVelocity(q, subject, clock.now() - windowMs);
    },
  };
}

// The atomic record-then-measure behind `record`. It checks out one client, runs BEGIN, and takes a
// transaction-scoped advisory lock keyed on the subject so same-subject calls run one at a time (the
// lock auto-releases at COMMIT or ROLLBACK). It then inserts the attempt deduped on its idempotency
// key (same column list and `on conflict do nothing` as `bumpVelocity`), runs the same windowed SUM
// `readVelocity` uses (now seeing this attempt), and COMMITs. The returned Velocity matches what
// `read` would return for the same rows, so every adapter agrees.
async function recordVelocity(
  pool: PgPool,
  subject: string,
  attempt: Attempt,
  cutoff: number,
): Promise<Velocity> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [subject],
    );
    await client.query(
      `insert into trust_attempts (idempotency_key, subject, amount, outcome, at)
         values ($1, $2, $3, $4, $5)
         on conflict (idempotency_key) do nothing`,
      [
        attempt.idempotencyKey,
        subject,
        attempt.amount.minor,
        attempt.outcome,
        attempt.at,
      ],
    );
    const result = await client.query(
      `select coalesce(min(at), 0) as window_start,
              coalesce(sum(amount), 0) as spent,
              count(*)::int as attempts
         from trust_attempts where subject = $1 and at > $2`,
      [subject, cutoff],
    );
    await client.query('commit');
    const row = result.rows[0]!;
    return {
      subject,
      windowStart: Number(row.window_start),
      spent: toAmount('CREDIT', readMinor(row.spent)),
      attempts: Number(row.attempts),
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --- Checkpoint store -------------------------------------------------------------

// Stores periodic signed snapshots of the ledger's state (to detect later tampering); `latest`
// returns the most recent. Rows are only ever added, never changed or removed, and writes go
// through the pool rather than a transaction, so a money transaction rolling back can't erase a
// snapshot already taken.
function createCheckpointStore(pool: PgPool): CheckpointStore {
  return {
    put: async (checkpoint) => {
      await pool.query(
        `insert into checkpoints (id, root, signature, count, at)
           values ($1, $2, $3, $4, $5)`,
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
      const result = await pool.query(
        `select * from checkpoints order by seq desc limit 1`,
      );
      const row = result.rows[0];
      return row ? rowToCheckpoint(row) : null;
    },
  };
}

// --- The transaction unit ---------------------------------------------------------

// The checkpoint store is left out: only the worker writes it, outside transactions. Trust rides
// the transaction; see createUnitTrustStore.
function buildUnit(
  q: Queryable,
  digest: Digest,
  clock: Clock,
  velocityWindowMs: number,
): Unit {
  return {
    ledger: lockingLedger(q, digest, clock),
    idempotency: createIdempotencyStore(q),
    sales: createSaleStore(q),
    outbox: createOutboxStore(q),
    inbox: createInboxStore(q),
    sagas: createSagaStore(q),
    entitlements: createEntitlementStore(q, clock),
    subscriptions: createSubscriptionStore(q),
    promos: createPromoStore(q),
    trust: createUnitTrustStore(q, clock, velocityWindowMs),
  };
}

// --- The assembled store ----------------------------------------------------------

/** Options for {@link postgresStore}: the connection string and optional overrides. */
export interface PostgresStoreOptions {
  url: string;

  // Optional dedicated Postgres schema, created/loaded then dropped on close, so parallel test runs
  // don't collide. Omit to use the schema the connection already points at.
  schema?: string;

  digest?: Digest;

  clock?: Clock;

  // Rolling window (ms) the trust store applies when summing a subject's recent spend for the
  // velocity check. Defaults to one hour; the composition passes config.velocityWindowMs.
  velocityWindowMs?: number;

  // Max connections in the pool. Each in-flight transaction holds one connection for its whole
  // BEGIN..COMMIT, so this caps how many submits can run at once: a caller that drives N concurrent
  // submits must size this to at least N or the extra ones block waiting for a connection. Left unset,
  // `pg`'s default of 10 applies, which is the historical behavior.
  poolMax?: number;

  // Max time (ms) to wait for a connection before failing. `pg`'s default is no timeout, so a
  // routable-but-stalled host (firewall drop, mid-startup) would hang indefinitely; a caller that
  // wants to fail fast and move on (e.g. the bench skipping an unreachable backend) sets this. Left
  // unset, the historical no-timeout behavior applies.
  connectionTimeoutMillis?: number;
}

/**
 * Build a {@link Store} backed by Postgres, using real database transactions. The returned
 * `transaction(work)` checks out one connection, runs `work` between BEGIN and COMMIT, and rolls
 * back if `work` throws. The trust and checkpoint stores hang off the pool directly, not off a
 * transaction, so their writes are never rolled back. If `schema` is given, a fresh schema with
 * that name is created, loaded with db/postgresql-schema.sql, and used for all queries; `close()`
 * drops it. The hashing and clock dependencies default to reproducible implementations.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage &
 *   messaging} for the port contracts this engine implements.
 */
export async function postgresStore(
  options: PostgresStoreOptions,
): Promise<Store> {
  configureBigIntParsers();
  const digest = options.digest ?? defaultDigest();
  const clock = options.clock ?? defaultClock();
  const velocityWindowMs = options.velocityWindowMs ?? 60 * 60_000;
  const schema = options.schema ? safeSchemaName(options.schema) : null;

  // Point every connection the pool opens at the dedicated schema by setting its search_path
  // (where Postgres looks up unqualified table names) through the connection options. Unqualified
  // table names then resolve to our schema on every connection the pool hands out, read or
  // transaction.
  const pool = new pg.Pool({
    connectionString: options.url,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
    ...(options.poolMax ? { max: options.poolMax } : {}),
    ...(options.connectionTimeoutMillis
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
  });
  if (schema) {
    await applyIsolatedSchema(pool, schema);
  }

  // Refuse to run against a database whose schema has drifted from this code. For an
  // isolated test schema we just applied the current SQL, so this passes by construction.
  assertSchemaCurrent(await readSchemaVersion(pool), 'Postgres');

  const ledger = createLedgerStore(pool, digest, clock);

  return {
    ledger,
    idempotency: createIdempotencyStore(pool),
    sales: createSaleStore(pool),
    outbox: createOutboxStore(pool),
    inbox: createInboxStore(pool),
    sagas: createSagaStore(pool),
    entitlements: createEntitlementStore(pool, clock),
    subscriptions: createSubscriptionStore(pool),
    promos: createPromoStore(pool),
    trust: createTrustStore(pool, clock, velocityWindowMs),
    checkpoints: createCheckpointStore(pool),
    replay: createReplayStore(pool),
    transaction: async (work) =>
      runInTransaction(pool, { digest, clock, velocityWindowMs }, work),
    close: async () => {
      if (schema) {
        await pool
          .query(`drop schema if exists ${schema} cascade`)
          .catch(() => {});
      }
      await pool.end();
    },
  };
}

// Create the dedicated schema from scratch and load db/postgresql-schema.sql into it. Drop any
// leftover schema of the same name first, recreate it, point this connection at it, then run the
// table-creation SQL. The pool's connections are already aimed at this schema, so the unqualified
// `create table` statements in db/postgresql-schema.sql resolve into it.
async function applyIsolatedSchema(
  pool: PgPool,
  schema: string,
): Promise<void> {
  const sql = await loadSchemaSql();
  const client = await pool.connect();
  try {
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}`);
    await client.query(sql);
  } finally {
    client.release();
  }
}

// Run `work` inside a single database transaction (one connection, BEGIN/COMMIT, rollback + rethrow
// on a throw), so every sub-store write commits or rolls back as one. Because the whole unit of work
// is in this one transaction, a transient lock conflict committed nothing, so withTransientRetry can
// re-run all of `work` in a fresh connection + transaction atomically and idempotency-safe; a true
// settle-vs-reverse conflict then retries into a clean SAGA.INVALID_TRANSITION rather than escaping
// as a raw 40P01. Any non-transient error propagates unchanged on its first occurrence.
// @see https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/
async function runInTransaction<T>(
  pool: PgPool,
  deps: { digest: Digest; clock: Clock; velocityWindowMs: number },
  work: (tx: Unit) => Promise<T>,
): Promise<T> {
  return withTransientRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const unit = buildUnit(
        client,
        deps.digest,
        deps.clock,
        deps.velocityWindowMs,
      );
      const result = await work(unit);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }, isTransientConflict);
}

// Reports whether the error is a transient lock conflict Postgres raised to break a tie. Such a
// conflict is safe to retry because the aborted transaction committed nothing. The two cases are
// `40P01` deadlock_detected and `40001` serialization_failure, the SQLSTATEs the `pg` driver
// surfaces on `error.code`. Anything else (a domain fault, a CHECK or constraint violation, a
// connection error) is not retried.
function isTransientConflict(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  } | null;
  const code = e?.code;
  // 40P01 (deadlock) and 40001 (serialization failure) are the classic "try again" aborts. The third
  // case is subtler. Each account's history is a hash chain, and a new link names the current last
  // link (the head) as its parent. chain_links_account_prev_uq lets only one link claim a given
  // parent. So when two writers read the same head and both try to attach, one succeeds and the other
  // gets a 23505. That 23505 is not a real duplicate: the head has moved, so a retry re-reads it
  // and attaches cleanly. This case is scoped to that one index, so a real duplicate (a colliding id
  // or idempotency key) still fails fast.
  //
  // P0001 (the default SQLSTATE of `raise exception`) carrying the chain-continuity message is the
  // same race from the trigger side rather than the unique index -- equally fixed by re-reading the
  // head. It is matched only on that message, since P0001 is also raised for the genuine
  // `conservation` and `balance integrity` faults, which must fail fast and are never retried.
  return (
    code === '40P01' ||
    code === '40001' ||
    (code === '23505' && e?.constraint === CHAIN_FORK_INDEX) ||
    (code === 'P0001' &&
      String(e?.message ?? '').includes(CHAIN_CONTINUITY_MARKER))
  );
}
