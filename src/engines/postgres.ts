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

// Only the slice of `pg` this engine calls, so nothing depends on the full vendor types.
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

import {
  toAmount,
  encodeAmount,
  encodeAmounts,
  decodeAmountWire,
} from '#src/money.ts';
import {
  currency,
  baseOf,
  isDebitNormal,
  walletKindOf,
} from '#src/accounts.ts';
import { assertMoneyConformant, assertSchemaCurrent } from '#src/schema.ts';
import { installPostgres, provePostgres } from '#src/db.vendored.ts';
import { vectors as moneyVectors } from '#src/money.vendored.ts';
import { systemClock } from '#src/runtime.ts';
import {
  callProcedure,
  callFunction,
  postEntryArgs,
} from '#src/engines/sql-routines.ts';
import {
  defaultDigest,
  CHAIN_FORK_INDEX,
  CHAIN_CONTINUITY_MARKER,
  readMinor,
  distinctAccounts,
  chainLinksFor,
  naturalDelta,
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
  isSeededSystemAccount,
} from '#src/engines/sql-shared.ts';
import { metaString, metaNumber } from '#src/meta.ts';

import type {
  EngineOpenShape,
  Link,
  RetryObserver,
} from '#src/engines/sql-shared.ts';

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
  InboxStore,
  Leg,
  LinkPage,
  Logger,
  MovementJournal,
  Ledger,
  Lot,
  Meter,
  OutboxStore,
  Posting,
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

interface PgClient {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgResult>;
  release(): void;
}
interface PgResult {
  rows: Array<Record<string, unknown>>;
}
export interface PgPool {
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

async function loadSchemaSql(): Promise<string> {
  const path = fileURLToPath(
    new URL('../../db/postgresql-schema.sql', import.meta.url),
  );
  return readFile(path, 'utf8');
}

// Null when schema_meta is absent (an un-migrated or pre-versioning database); assertSchemaCurrent
// then fails fast rather than silently query a schema that doesn't match this code.
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

function isKnownSuffix(account: AccountRef): boolean {
  return walletKindOf(account) !== null;
}

// Reads each account's chain head from `account_balances.head_hash`, the pointer post_entry
// advances in the same transaction it writes chain_links. A missing row means genesis; chain_links
// stays the source of truth (prove() re-walks it), so a drifted pointer surfaces there.
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

async function advanceChain(
  q: Queryable,
  digest: Digest,
  posting: Posting,
): Promise<ReadonlyArray<Link>> {
  const heads = await headsForAccounts(q, distinctAccounts(posting.legs));
  return chainLinksFor(digest, posting, heads);
}

// A shard of a schema-seeded platform account (`platform:revenue#3`). Bare ids are seeded; a
// shard row is created on first use. A typo with no seeded base stays excluded and faults upstream.
function isPlatformShard(account: AccountRef): boolean {
  const base = baseOf(account);
  return base !== account && isSeededSystemAccount(base);
}

function accountRow(account: AccountRef) {
  const kind = walletKindOf(account) ?? 'system';
  return { id: account, kind, currency: currency(account) };
}

// Only user accounts and platform shards are created here; bare platform ids are schema-seeded.
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

// NOTE: the per-account balance fold (UPDATE before INSERT, so the non-negative CHECK runs against
// the new total) lives in the `post_entry` procedure; the application decides each delta via
// `balanceDelta` (postEntryArgs), the procedure only persists it.

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

    // No-op here; locking only makes sense inside a transaction, so lockingLedger below is the
    // real implementation.
    lock: async () => {},

    append: async (posting) => {
      const postedAt = clock.now();
      const links = await advanceChain(q, digest, posting);
      await writePosting(q, posting, postedAt, links);
      return {
        id: posting.txnId,
        postedAt,
        legs: posting.legs,
        links,
        meta: posting.meta,
      };
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

    derivedBalances: async (account) => derivedBalancesOf(q, account),

    balanceAccounts: () => balanceAccountsOf(q),

    timeline: (account, options) => timelineOf(q, account, options),

    heads: () => headsOf(q),

    headSums: () => headSumsOf(q),

    lineage: (account) => lineageOf(q, account),

    posting: async (txnId) => postingOf(q, txnId),

    links: async (txnId) => {
      const result = await q.query(
        `select account_id, prev_hash, hash from chain_links where posting_id = $1`,
        [txnId],
      );
      return result.rows.map((row) => ({
        account: row.account_id as AccountRef,
        prevHash: row.prev_hash as string,
        hash: row.hash as string,
      }));
    },
    linksPage: (cursor, limit) => linksPageOf(q, cursor, limit),
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
      // Batched twin of `lock`: `order by account_id` takes the locks in one global order, so
      // operations sharing accounts serialize instead of deadlocking, in a single round trip. A
      // first-use account has no balance row yet and locks nothing, exactly like `lock`; the
      // chain-fork index plus withTransientRetry cover that cold-start race.
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
    amount: naturalDelta(account, row),
    postedAt: Number(row.posted_at),
  }));
  return { account, entries, cursor: null };
}

// Server-side fold, one amount per currency. sum(int8) returns numeric as a string; readMinor
// turns it back into a bigint. `naturalDelta` applies the account's sign rule to the summed
// figure — the sum of signed deltas equals the delta of the sum.
async function derivedBalancesOf(
  q: Queryable,
  account: AccountRef,
): Promise<Amount[]> {
  const result = await q.query(
    `select currency, sum(amount) as minor from legs
      where account_id = $1 group by currency order by currency`,
    [account],
  );
  return result.rows.map((row) =>
    naturalDelta(account, { currency: row.currency, amount: row.minor }),
  );
}

// Streams an account's incoming funds as lots for maturity.ts. Ordered by `l.id`, not `p.seq`:
// `legs(account_id, id)` serves the bounded scan directly, and the two share commit order for one
// account. The lot filter (a balance-raising leg, per the account's sign rule) must stay in the
// SQL: filtering in code reads every spend leg just to drop it, and the maturity check on a busy
// account goes O(history).
// @see https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/
async function* timelineOf(
  q: Queryable,
  account: AccountRef,
  options?: TimelineOptions,
): AsyncIterable<Lot> {
  const direction = options?.order === 'desc' ? 'desc' : 'asc';
  const lotOffset = options?.offset ?? 0;
  const lotLimit = options?.limit ?? Infinity;
  const pageSize = Number.isFinite(lotLimit) ? Math.max(lotLimit, 1) : 256;

  let cursor: unknown = null;
  let yielded = 0;
  while (yielded < lotLimit) {
    const rows = await lotPage(q, account, {
      direction,
      pageSize,
      offset: lotOffset,
      cursor,
    });
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      cursor = row.leg_id;
      const lot = rowToLot(account, row);
      // Unreachable under the SQL sign filter; skip rather than trust a drifted schema.
      if (lot === null) {
        continue;
      }
      yielded += 1;
      yield lot;
      if (yielded >= lotLimit) {
        return;
      }
    }
    if (rows.length < pageSize) {
      return;
    }
  }
}

// One page of an account's lots. The first page honors the caller's lot offset; later pages
// continue from the keyset (last l.id) instead, never re-scanning rows via OFFSET.
async function lotPage(
  q: Queryable,
  account: AccountRef,
  page: {
    direction: 'asc' | 'desc';
    pageSize: number;
    offset: number;
    cursor: unknown;
  },
): Promise<Record<string, unknown>[]> {
  const lotSign = isDebitNormal(account) ? '>' : '<';
  const after = page.direction === 'desc' ? '<' : '>';
  const result =
    page.cursor === null
      ? await q.query(
          `select l.id as leg_id, l.posting_id, l.amount, l.currency, p.posted_at, p.meta
             from legs l
             join postings p on p.id = l.posting_id
            where l.account_id = $1 and l.amount ${lotSign} 0
            order by l.id ${page.direction}
            limit $2 offset $3`,
          [account, page.pageSize, page.offset],
        )
      : await q.query(
          `select l.id as leg_id, l.posting_id, l.amount, l.currency, p.posted_at, p.meta
             from legs l
             join postings p on p.id = l.posting_id
            where l.account_id = $1 and l.amount ${lotSign} 0 and l.id ${after} $3
            order by l.id ${page.direction}
            limit $2`,
          [account, page.pageSize, page.cursor],
        );
  return result.rows as Record<string, unknown>[];
}

// Null when the leg lowered the balance (a spend): the credit/debit sign is a domain rule, so the
// filter lives in code, not SQL. Absent meta defaults to a mature-now 'unknown' source.
function rowToLot(
  account: AccountRef,
  row: Record<string, unknown>,
): Lot | null {
  const delta = naturalDelta(account, row);
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

// The tip of every account's chain — its latest link by posting seq. Shared by heads() (as the
// whole query) and headSums() (as the subselect its join wraps).
const CHAIN_TIPS_SQL = `select distinct on (c.account_id) c.account_id, c.hash
       from chain_links c
       join postings p on p.id = c.posting_id
      order by c.account_id, p.seq desc`;

async function* headsOf(
  q: Queryable,
): AsyncIterable<readonly [AccountRef, string]> {
  const result = await q.query(CHAIN_TIPS_SQL);
  sortByAccountId(result.rows);
  for (const row of result.rows) {
    yield [row.account_id as AccountRef, row.hash as string] as const;
  }
}

// The heads query joined with per-account raw leg sums, in ONE statement on purpose: a posting
// writes its chain link and its legs in one transaction, and a single statement reads one
// consistent snapshot, so a head can never be paired with a sum it didn't commit with. Raw means
// as posted (debit positive); sum(int8) returns numeric as a string, readMinor turns it back into
// a bigint.
async function* headSumsOf(
  q: Queryable,
): AsyncIterable<readonly [AccountRef, string, bigint]> {
  const result = await q.query(
    `select h.account_id, h.hash, s.raw
       from (${CHAIN_TIPS_SQL}) h
       join (select account_id, sum(amount) as raw from legs group by account_id) s
         on s.account_id = h.account_id`,
  );
  sortByAccountId(result.rows);
  for (const row of result.rows) {
    yield [
      row.account_id as AccountRef,
      row.hash as string,
      readMinor(row.raw),
    ] as const;
  }
}

// Streams every account whose balance row reflects real activity: this is how the integrity
// checker reaches a cached balance with no entries behind it, which heads() (built from the hash
// chain) never lists. The seeded placeholder (genesis head, zero balance) reads like no row and is
// excluded -- except `or balance <> 0`, a placeholder that gained a balance, exactly the drift
// this scan hunts.
async function* balanceAccountsOf(q: Queryable): AsyncIterable<AccountRef> {
  const result = await q.query(
    `select account_id from account_balances
       where head_hash <> repeat('0', 64) or balance <> 0`,
  );
  sortByAccountId(result.rows);
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
  const result = await q.query(
    `select c.posting_id, c.prev_hash, c.hash, p.meta
       from chain_links c
       join postings p on p.id = c.posting_id
      where c.account_id = $1
      order by p.seq asc`,
    [account],
  );
  // The whole posting's legs load, not just this account's: chainPreimage filters itself.
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

// A whole posting with all entry lines -- undoing a transaction needs every line to post the
// opposite. Null when no posting has that id.
// Pages by postings.seq (the commit order), whole postings at a time, so a posting's links never
// split across pages; a null cursor from here means the newest stored posting was consumed.
async function linksPageOf(
  q: Queryable,
  cursor: number | null,
  limit: number,
): Promise<LinkPage> {
  const page = await q.query(
    `select id, seq, meta from postings where seq > $1 order by seq asc limit $2`,
    [cursor ?? -1, limit],
  );
  if (page.rows.length === 0) {
    return { links: [], cursor: null };
  }
  const ids = page.rows.map((row) => row.id as string);
  const legsByTxn = await legsByPosting(q, ids);
  const linkRows = await q.query(
    `select posting_id, account_id, prev_hash, hash from chain_links
      where posting_id = any($1::text[])`,
    [ids],
  );
  const metaByTxn = new Map(
    page.rows.map((row) => [
      row.id as string,
      (row.meta ?? {}) as Record<string, unknown>,
    ]),
  );
  const links = linkRows.rows.map((row) => ({
    account: row.account_id as AccountRef,
    txnId: row.posting_id as string,
    legs: legsByTxn.get(row.posting_id as string) ?? [],
    meta: metaByTxn.get(row.posting_id as string) ?? {},
    prevHash: row.prev_hash as string,
    hash: row.hash as string,
  }));
  return {
    links,
    cursor:
      page.rows.length < limit
        ? null
        : Number(page.rows[page.rows.length - 1]!.seq),
  };
}

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

// Newest commit first: `seq` is bigserial unique, a total order with no tie to break.
async function* listPostingsOf(q: Queryable): AsyncIterable<Posting> {
  const result = await q.query(
    `select id, meta from postings order by seq desc`,
  );
  // list() consumers buffer the whole stream, so the eager batched legs read changes nothing.
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

// The hash is computed from the whole posting, so every line is needed.
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

// `claim` replays the stored result if a row exists; otherwise it takes a key-scoped
// pg_advisory_xact_lock and rechecks, so a second same-key caller waits out the first's
// transaction, then replays (committed) or does the work (rolled back). `record` writes in the
// same transaction as the posting, so a rollback frees the key for a real retry.
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
  meta?: Record<string, unknown>;
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
    meta: transaction.meta,
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
    // Rows recorded before Transaction carried meta have none stored.
    meta: encoded.meta ?? {},
  };
}

// --- Replay store -----------------------------------------------------------------

// Dedupes inbound provider webhooks by the provider's event id, a separate id space from the
// domain idempotency keys. `on conflict do nothing ... returning` inserts and reports newness in
// one statement. Run as the last webhook gate, after the signature and freshness checks, so a
// rejected delivery never burns the id.
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

function encodeLegs(
  legs: ReadonlyArray<Leg>,
): Array<{ account: string; currency: string; minor: string }> {
  return legs.map((leg) => ({
    account: leg.account,
    currency: leg.amount.currency,
    minor: leg.amount.minor.toString(),
  }));
}

function decodeLegs(
  legs: ReadonlyArray<{ account: string; currency: string; minor: string }>,
): ReadonlyArray<Leg> {
  return legs.map((leg) => ({
    account: leg.account as AccountRef,
    amount: toAmount(leg.currency as Amount['currency'], BigInt(leg.minor)),
  }));
}

function rowToSale(row: Record<string, unknown>): Sale {
  const legs = decodeLegs(
    row.legs as Array<{ account: string; currency: string; minor: string }>,
  );
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

// `enqueue` writes the event in the same transaction as the money move; `for update skip locked`
// lets overlapping relay workers claim disjoint batches.
// See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for the outbox pattern.
function createOutboxStore(q: Queryable): OutboxStore {
  return {
    enqueue: async (message) => {
      await q.query(
        `insert into outbox (id, event, status, attempts, correlation_id)
           values ($1, $2::jsonb, $3, $4, $5)`,
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
      const result = await q.query(
        `select id, event, status, attempts, dead_letter_reason, correlation_id from outbox
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
      // The `and status = 'pending'` clause stops a stale resend from flipping a dead-lettered or
      // already-relayed row back to 'relayed'.
      await q.query(
        `update outbox set status = 'relayed'
          where id = any($1::text[]) and status = 'pending'`,
        [[...ids]],
      );
    },
    recordFailure: async (id) => {
      await q.query(
        `update outbox set attempts = attempts + 1
          where id = $1 and status = 'pending'`,
        [id],
      );
    },
    deadLetter: async (id, reason) => {
      await q.query(
        `update outbox set status = 'dead', dead_letter_reason = $2
          where id = $1 and status = 'pending'`,
        [id, reason],
      );
    },
    // Age comes from the database's own now(), so an app/database clock skew never distorts it.
    stats: async () => {
      const result = await q.query(
        `select count(*)::int as pending,
                floor(extract(epoch from (now() - min(created_at))) * 1000) as age_ms
           from outbox where status = 'pending'`,
        [],
      );
      const row = result.rows[0] as { pending: number; age_ms: string | null };
      return {
        pending: row.pending,
        oldestPendingAgeMs:
          row.age_ms === null ? null : Math.max(0, Number(row.age_ms)),
      };
    },
  };
}

// --- Inbox store ------------------------------------------------------------------

// The inbound mirror of the outbox: `enqueueInbound` writes the row in the webhook ingress
// transaction and dedupes on `key` (the provider event id, UNIQUE in SQL); `for update skip
// locked` lets overlapping apply workers claim disjoint batches.
// See https://economy-lab-docs.pages.dev/economy/ports/messaging/ for the inbox pattern.
function createInboxStore(q: Queryable): InboxStore {
  return {
    // A redelivery (no row returned from `on conflict do nothing`) falls through to re-reading the
    // canonical row by key. Amounts are decimal strings: jsonb has no BigInt.
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
    // `input.now` is accepted for parity with the saga and relay claims — the inbox has no due-time gate.
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
    markApplied: async (id) => {
      await q.query(
        `update inbox set status = 'applied' where id = $1 and status = 'pending'`,
        [id],
      );
    },
    bumpAttempt: async (id) => {
      await q.query(
        `update inbox set attempts = attempts + 1
          where id = $1 and status = 'pending'`,
        [id],
      );
    },
    deadLetter: async (id, reason) => {
      await q.query(
        `update inbox set status = 'dead', dead_letter_reason = $2
          where id = $1 and status = 'pending'`,
        [id, reason],
      );
    },
    // `for update skip locked` on the dead rows keeps two overlapping revives disjoint, the same
    // discipline as the claims.
    reviveDead: async (limit) => {
      const result = await q.query(
        `update inbox set status = 'pending', attempts = 0, dead_letter_reason = null
          where id in (
            select id from inbox where status = 'dead'
             order by received_at asc
             limit $1
             for update skip locked
          )
          returning id, key, operation, status, attempts, received_at, dead_letter_reason`,
        [Math.max(0, limit)],
      );
      return result.rows.map(rowToInbox);
    },
  };
}

// JSON-safe form of the Operation stored in the inbox row's jsonb column: the shared Amount-brand
// walk (money.ts encodeAmounts) swaps every branded Amount for its `CREDIT:12.34` string, whichever
// variant the operation is; the shared rowToInbox reverses it on read.
type EncodedOperation = Record<string, unknown>;

function encodeOperation(operation: Operation): EncodedOperation {
  return encodeAmounts(operation) as EncodedOperation;
}

// --- Saga store -------------------------------------------------------------------

// No `for update`: a read-only enumeration, not a claim. An empty `states` list yields nothing
// (`= any('{}')` matches no row), per the SagaStore contract.
async function* listSagasOf(
  q: Queryable,
  states?: readonly Saga['state'][],
): AsyncIterable<Saga> {
  const result =
    states === undefined
      ? await q.query(
          `select * from payout_sagas order by updated_at desc, id desc`,
        )
      : await q.query(
          `select * from payout_sagas where state = any($1::text[])
            order by updated_at desc, id desc`,
          [[...states]],
        );
  for (const row of result.rows) {
    yield rowToSaga(row);
  }
}

// The inbound-webhook lookup (see SagaStore.findByProviderRef). On a duplicated ref the newest
// `updatedAt` wins, matching the in-memory reference and the MySQL engine.
async function findSagaByRef(
  q: Queryable,
  providerRef: string,
): Promise<Saga | null> {
  const result = await q.query(
    `select * from payout_sagas
      where provider_ref = $1
      order by updated_at desc
      limit 1`,
    [providerRef],
  );
  const row = result.rows[0];
  return row ? rowToSaga(row) : null;
}

// `advance` is a compare-and-set: the update applies only while the saga is still in the state
// the caller expected, so two racing sweeps can't advance the same payout twice.
async function openSagaRow(q: Queryable, saga: Saga): Promise<void> {
  await q.query(
    `insert into payout_sagas
       (id, user_id, reserve, rate_id, txn_id, state, provider_ref, attempts, payout_usd, due_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do nothing`,
    [
      saga.id,
      saga.userId,
      saga.reserve.minor,
      saga.rateId,
      saga.txnId,
      saga.state,
      saga.providerRef,
      saga.attempts,
      saga.payoutUsd === null ? null : saga.payoutUsd.minor,
      saga.dueAt,
      saga.updatedAt,
    ],
  );
}

function createSagaStore(q: Queryable): SagaStore {
  return {
    open: (saga) => openSagaRow(q, saga),
    load: async (id) => {
      const result = await q.query(`select * from payout_sagas where id = $1`, [
        id,
      ]);
      const row = result.rows[0];
      return row ? rowToSaga(row) : null;
    },
    findByProviderRef: (providerRef) => findSagaByRef(q, providerRef),
    list: (options) => listSagasOf(q, options?.states),
    // Due payouts still in progress: only RESERVED and SUBMITTED rows. A row stuck in REQUESTED
    // means its opening step crashed partway, and it is skipped on purpose — the schema's partial
    // index excludes it the same way.
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
      // `payout_usd` and `reason` are the terminal settle and fail outcomes; coalesce leaves both
      // untouched on every non-terminal advance.
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

// Ownership state, not a money entry. `revoke` is a soft delete (the row keeps the refund/clawback
// audit history); a re-grant clears `revoked`, so re-buying re-activates. The clock is injected so
// owns() can test expiry (its signature is fixed).
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
      // Owned only if not revoked and not expired; the boundary is inclusive (`expires_at >=
      // now`), a null expiry never lapses, and the read has no side effects.
      const result = await q.query(
        `select 1 from entitlements
          where user_id = $1 and sku = $2 and revoked = false
            and (expires_at is null or expires_at >= $3)`,
        [userId, sku, clock.now()],
      );
      return result.rows.length > 0;
    },
    list: async function* (userId) {
      // Non-revoked grants, expired included, sorted by sku so every engine lists identically.
      const result = await q.query(
        `select sku, expires_at from entitlements
          where user_id = $1 and revoked = false order by sku`,
        [userId],
      );
      for (const row of result.rows) {
        yield {
          sku: row.sku as string,
          expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        };
      }
    },
  };
}

// --- Subscription store -----------------------------------------------------------

function createSubscriptionStore(q: Queryable): SubscriptionStore {
  return {
    // Must upsert, not `do nothing`: the worker re-opens to persist a bumped retry attempt, and
    // keeping the old count would never advance the retry cap. The identity columns never change for
    // a given id, so the update set covers only the mutable lifecycle fields.
    open: async (sub) => {
      await q.query(
        `insert into subscriptions
           (id, user_id, seller_id, sku, price, txn_id, period_ms, state, period, attempts, next_due_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
    // `for update skip locked` lets overlapping sweepers grab disjoint batches.
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
    // Compare-and-set on next_due_at: a sweeper that already billed this period moved the date, so
    // the loser matches no row and never double-charges. attempts resets to 0 on success.
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
    // LAPSED (a renewal couldn't be paid) is distinct from the user canceling; either way the row
    // leaves the active-and-due set the billing sweep picks up.
    markLapsed: async (id) => {
      await q.query(`update subscriptions set state = 'LAPSED' where id = $1`, [
        id,
      ]);
    },
  };
}

// --- Promo store ------------------------------------------------------------------

// Tracks each promo grant for the expiry sweep, recorded in the same transaction as the credit
// posting. `open` is idempotent on the id and never overwrites; `claimDue` hands the sweep
// expired, unreversed grants oldest-first under `for update skip locked`; `markReversed` is a
// no-op on a missing or already-reversed row, so re-running the sweep is harmless.
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

// --- Trust store -------------------------------------------------------------------

// Two views: this pool-backed store commits on its own, the Unit view (createUnitTrustStore)
// writes inside the money transaction — so a committed attempt shares the money commit and a
// rolled-back one still counts. `bump` keys on the attempt's idempotency key, so a resend never
// double-counts.
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
    // Record-and-measure atomically under a per-subject advisory lock — the atomicity
    // `TrustStore.record` requires (ports.ts); see recordVelocity.
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

// The transaction-scoped trust view a Unit carries: `record` runs on the money transaction's own
// connection, so the inserted attempt commits with the money, and the advisory lock holds until
// that transaction commits or rolls back.
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

// The atomic record-then-measure behind `record`: a transaction-scoped advisory lock keyed on the
// subject serializes same-subject calls (auto-released at COMMIT or ROLLBACK), and the SUM runs
// after the insert, so the returned Velocity already includes this attempt.
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
    await bumpVelocity(client, subject, attempt);
    const velocity = await readVelocity(client, subject, cutoff);
    await client.query('commit');
    return velocity;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --- Checkpoint store -------------------------------------------------------------

// Append-only, written through the pool rather than a transaction, so a money transaction rolling
// back can't erase a snapshot already taken.
// --- Movement journal ---------------------------------------------------------------

// Append-only and never part of a money transaction (see MovementJournal in ports.ts). The whole
// batch lands as ONE multi-row INSERT — a single statement, so it commits or rejects atomically
// with one fsync for N movements; a duplicate idem_key or (session_id, seq) rejects it all.
function createMovementJournal(pool: PgPool): MovementJournal {
  return {
    append: async (movements) => {
      if (movements.length === 0) {
        return;
      }
      const marks = movements
        .map(
          (_, i) =>
            `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`,
        )
        .join(', ');
      await pool.query(
        `insert into instance_movements
           (session_id, seq, idem_key, legs, prev_hash, hash, recorded_at)
         values ${marks}`,
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
      const result = await pool.query(
        `select * from instance_movements where session_id = $1 order by seq`,
        [sessionId],
      );
      for (const row of result.rows) {
        yield {
          sessionId: row.session_id as string,
          seq: Number(row.seq),
          idempotencyKey: row.idem_key as string,
          legs: decodeLegs(
            row.legs as ReadonlyArray<{
              account: string;
              currency: string;
              minor: string;
            }>,
          ),
          prevHash: row.prev_hash as string,
          hash: row.hash as string,
          recordedAt: Number(row.recorded_at),
        };
      }
    },
  };
}

function createCheckpointStore(pool: PgPool): CheckpointStore {
  return {
    put: async (checkpoint) => {
      await pool.query(
        `insert into checkpoints (id, root, signature, count, at, v, sum, kid)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
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

/**
 * Configuration for {@link postgresStore}. Everything beyond `url` has a working default: `pg`'s
 * pool size of 10, no connection timeout, the deterministic SHA-256 digest, the wall clock, a
 * one-hour velocity window, and the 'assert' schema policy.
 */
export interface PostgresStoreOptions {
  /** Connection URL the default `pg` pool connects with; unused when `pool` is supplied. */
  url: string;

  /**
   * Optional dedicated Postgres schema name, created/loaded then dropped on close, so parallel
   * test runs don't collide. Omit to use the schema the connection already points at.
   */
  schemaName?: string;

  /**
   * Open-path schema policy: 'assert' (the default) requires the schema_meta stamp to match this
   * build; 'skip' is break-glass. Migration is an external job — never an open option.
   */
  schema?: 'assert' | 'skip';

  /** Hash service for chain links; defaults to the deterministic web-standard SHA-256. */
  digest?: Digest;

  /** Time source for `postedAt` and window math; defaults to wall-clock time. */
  clock?: Clock;

  /**
   * Rolling window (ms) the trust store applies when summing a subject's recent spend for the
   * velocity check. Defaults to one hour; the composition passes config.velocityWindowMs.
   */
  velocityWindowMs?: number;

  /**
   * Max connections in the pool. Each in-flight transaction holds one connection for its whole
   * BEGIN..COMMIT, so this caps how many submits can run at once: a caller that drives N
   * concurrent submits must size this to at least N or the extra ones block waiting for a
   * connection. Left unset, `pg`'s default of 10 applies.
   */
  poolMax?: number;

  /**
   * Max time (ms) to wait for a connection before failing. `pg`'s default is no timeout, so a
   * routable-but-stalled host would otherwise hang indefinitely.
   */
  connectionTimeoutMillis?: number;

  /**
   * Optional runtime ports for the engine's own telemetry (transient-retry pressure). The
   * composition passes the runtime meter and logger; unset emits nothing.
   */
  meter?: Meter;

  logger?: Logger;
}

/**
 * Build a {@link Store} backed by Postgres, using real database transactions. The returned
 * `transaction(work)` checks out one connection, runs `work` between BEGIN and COMMIT, and rolls
 * back if `work` throws. Transactions run at Postgres' default READ COMMITTED isolation, with
 * correctness carried by explicit `FOR UPDATE` row locks rather than a snapshot; a transient
 * abort — deadlock, serialization failure, or a stale-head chain fork — committed nothing, so the
 * whole unit of work is re-run in a fresh connection and transaction and callers never see it as
 * an error. Every posting appends to a per-account hash chain, and the schema's triggers enforce
 * conservation and chain continuity on every write. The trust and checkpoint stores hang off the
 * pool directly, not off a transaction, so their writes are never rolled back.
 *
 * Opening fails fast rather than serve a mismatched database: the schema_meta stamp must match
 * this build (unless `schema: 'skip'`), and the vendored money routines are installed and proven
 * against pinned vectors before any posting trusts their arithmetic. If `schemaName` is given, a
 * fresh schema with that name is created, loaded with db/postgresql-schema.sql, and used for all
 * queries; `close()` drops it and ends the pool. The hash dependency defaults to the
 * deterministic SHA-256; the clock defaults to wall-clock time. Pass a fixed clock when
 * reproducible `postedAt` values matter.
 *
 * @example
 * const store = await postgresStore({
 *   url: 'postgres://econ:secret@127.0.0.1:5432/economy',
 *   poolMax: 32, // at least one connection per concurrent submit
 *   connectionTimeoutMillis: 5_000,
 * });
 * const economy = createEconomy({ store, ...runtimePorts });
 * // ... on shutdown:
 * await store.close();
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the port contracts this engine implements.
 */
export async function postgresStore(
  options: PostgresStoreOptions,
): Promise<Store> {
  configureBigIntParsers();
  const digest = options.digest ?? defaultDigest();
  const clock = options.clock ?? systemClock();
  // Default velocity window: one hour, matching the memory and MySQL stores.
  const velocityWindowMs = options.velocityWindowMs ?? 60 * 60_000;
  const schema = options.schemaName ? safeSchemaName(options.schemaName) : null;

  // Setting search_path through the connection options points every connection the pool opens at
  // the dedicated schema, so unqualified table names resolve there on reads and transactions alike.
  const pool = new pg.Pool({
    connectionString: options.url,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
    ...(options.poolMax ? { max: options.poolMax } : {}),
    ...(options.connectionTimeoutMillis
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
  });
  // End the pool if setup throws: this factory owns the pool it just created, and handing a
  // leaked open connection to a caller that only sees the throw keeps the process alive.
  try {
    if (schema) {
      await applyIsolatedSchema(pool, schema);
    }

    // Refuse to run against a database whose schema has drifted from this code. For an
    // isolated test schema we just applied the current SQL, so this passes by construction.
    if (options.schema !== 'skip') {
      assertSchemaCurrent(await readSchemaVersion(pool), 'Postgres');
    }

    // Install the vendored money functions (idempotent) and make this engine prove it computes
    // the pinned arithmetic before any posting trusts it — the same fail-fast as the schema
    // check, for semantics instead of shape. Retried: concurrent boots race the shared money.*
    // catalog rows (see installMoneyRetrying).
    const runner = {
      run: (sql: string, params?: readonly unknown[]) =>
        pool
          .query(sql, params ? [...params] : undefined)
          .then((result) => result.rows as Record<string, unknown>[]),
    };
    await installMoneyRetrying(() => installPostgres(runner));
    assertMoneyConformant(
      await provePostgres(runner, moneyVectors),
      'Postgres',
    );
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  const ledger = createLedgerStore(pool, digest, clock);
  const retryObserver = retryTelemetry(
    { meter: options.meter, logger: options.logger },
    'postgres',
  );
  const meter = options.meter;

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
    movements: createMovementJournal(pool),
    replay: createReplayStore(pool),
    transaction: async (work) =>
      runInTransaction(
        pool,
        { digest, clock, velocityWindowMs, retryObserver, meter },
        work,
      ),
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

// Drop any leftover schema of the same name, recreate it, and load db/postgresql-schema.sql into
// it; the unqualified `create table` statements resolve there via search_path.
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
// @see https://economy-lab-docs.pages.dev/economy/ports/messaging/
async function runInTransaction<T>(
  pool: PgPool,
  deps: {
    digest: Digest;
    clock: Clock;
    velocityWindowMs: number;
    retryObserver?: RetryObserver;
    meter?: Meter;
  },
  work: (unit: Unit) => Promise<T>,
): Promise<T> {
  return withTransientRetry(
    async () => {
      deps.meter?.count('engine.pool.acquire', 1, { engine: 'postgres' });
      const acquireStarted = deps.clock.now();
      const client = await pool.connect();
      deps.meter?.observe(
        'engine.pool.acquire_ms',
        deps.clock.now() - acquireStarted,
        { engine: 'postgres' },
      );
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
    },
    isTransientConflict,
    { observer: deps.retryObserver },
  );
}

// A transient Postgres abort committed nothing, so it is safe to retry; anything else (a domain
// fault, a CHECK or constraint violation, a connection error) is not retried.
function isTransientConflict(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  } | null;
  const code = e?.code;
  // 40P01 (deadlock) and 40001 (serialization failure) are the classic "try again" aborts. A 23505
  // on chain_links_account_prev_uq is a stale-head chain fork, not a real duplicate: the head moved,
  // and a retry re-reads it and attaches cleanly. Scoping to that one constraint keeps a real
  // duplicate (a colliding id or idempotency key) failing fast.
  //
  // P0001 carrying the chain-continuity message is the same race from the trigger side, equally
  // fixed by retrying. It is matched only on that message, since P0001 also carries the genuine
  // `conservation` and `balance integrity` faults, which must fail fast and are never retried.
  return (
    code === '40P01' ||
    code === '40001' ||
    (code === '23505' && e?.constraint === CHAIN_FORK_INDEX) ||
    (code === 'P0001' &&
      String(e?.message ?? '').includes(CHAIN_CONTINUITY_MARKER))
  );
}

/**
 * The shared field vocabulary for opening a SQL engine, with the pool type bound to this
 * driver's {@link PgPool}. The composition layer assembles these fields from configuration;
 * {@link postgresStore} implements the Postgres subset (it opens by `url` or takes a pre-built
 * `pool`, and honors `schemaName` isolation).
 */
export type EngineOpenOptions = EngineOpenShape<PgPool>;
