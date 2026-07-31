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

import { decodeCanonicalAmount, encodeAmount, toAmount } from '#src/money.ts';
import { decodeStoredOperation } from '#src/wire-contract.ts';
import { byCodeUnit, fromHex } from '#src/bytes.ts';
import { GENESIS, GENESIS_HEX, balanceDelta, chainHash } from '#src/ledger.ts';
import { sha256Digest } from '#src/digest.ts';
import { SYSTEM, baseOf } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Transaction } from '#src/contract.ts';
import type {
  AccrualRow,
  Checkpoint,
  Digest,
  InboxMessage,
  Leg,
  Logger,
  Meter,
  OutboxMessage,
  Posting,
  PromoGrant,
  Saga,
  SagaState,
  Sale,
  Subscription,
} from '#src/ports.ts';

// This module holds the helpers the Postgres and MySQL engines share: default services,
// distinct-account ordering, chain-link derivation, and row-to-domain decoders. It carries no
// SQL strings and no driver specifics.

import type { Clock } from '#src/ports.ts';

/**
 * The shared field vocabulary for opening either SQL engine. Each engine entry exports its
 * `EngineOpenOptions` alias with `TPool` bound to that driver's typed pool, and implements its
 * subset (`postgresStore` opens by `url`, `mysqlStore` takes a pre-built `pool`). Open-path
 * schema policy is `assert` (require the schema_meta stamp to match) or `skip` (break-glass).
 * Applying or migrating a schema is a separate operator job, never an open option.
 */
export type EngineOpenShape<TPool> = {
  readonly url?: string;
  readonly pool?: TPool;
  readonly poolMax?: number | null;
  readonly connectionTimeoutMillis?: number;
  /** Frozen at store construction. Changing it means a rebuild over the same database. */
  readonly velocityWindowMs: number;
  readonly digest: Digest;
  readonly clock: Clock;
  readonly meter?: Meter;
  readonly logger?: Logger;
  readonly schema?: 'assert' | 'skip';
  /** Postgres test isolation. Created at open, dropped on close. */
  readonly schemaName?: string;
};

/**
 * The connect wait both engines apply when the caller names none. A host that accepts the socket
 * and then never speaks is the case this bounds: `pg` would otherwise wait forever.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

// --- Default services -------------------------------------------------------------

/**
 * Returns a SHA-256 digest backed by Web Crypto, which is available on every JS runtime. The same
 * bytes hash to the same digest on every runtime, so the chain head an engine writes is
 * reproducible everywhere.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for how engines plug into the ledger.
 */
export function defaultDigest(): Digest {
  return sha256Digest();
}

// The unique index guarding each account's hash-chain head, chain_links (account_id, prev_hash).
// A 23505 (Postgres) or 1062 (MySQL) violation that names this index is a chain-head fork. Two
// writers used the same prev_hash and one of the inserts was rejected. withTransientRetry treats
// that fork as transient and retries it. This name must match the index name in
// packages/postgres/db/postgresql-schema.sql and packages/mysql/db/mysql-schema.sql. Rename the
// index there without renaming it here and the retry stops firing, so the cold-start fork race
// resurfaces as an unretried error.
//
// The name is shared; recognising a fork is not, and each engine does it in its own module. MySQL
// keys the guard by a digest of the pair and reads the name out of the error text. Postgres also
// matches the violated key columns, because on the partitioned layout it reports against a
// per-partition child index under a name of its own choosing and this one never appears.
export const CHAIN_FORK_INDEX = 'chain_links_account_prev_uq';

// The leading text of the chain-continuity trigger's error message in both schemas. The trigger
// catches the same cold-start / stale-head race as the fork index above, so withTransientRetry
// treats it as transient and re-reads the head. The match is on this message prefix, not the bare
// SQLSTATE (Postgres P0001 / MySQL 1644). That state is also raised for genuine
// `conservation` and `balance integrity` faults, which must never be retried. Keep this string in
// lockstep with the trigger MESSAGE_TEXT in packages/postgres/db/postgresql-schema.sql and
// packages/mysql/db/mysql-schema.sql.
export const CHAIN_CONTINUITY_MARKER = 'chain continuity';

export function readMinor(value: unknown): bigint {
  return BigInt(value as bigint | number | string);
}

// --- Distinct-account ordering ----------------------------------------------------

// Returns the distinct accounts across these legs, in first-appearance order. A posting can touch
// an account on several legs but advances its hash chain only once, so dedupe to one per account.
export function distinctAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
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

// Sorts rows on account_id in code-unit order — the app's order, not the DB collation's — so every
// engine lists accounts identically.
export function sortByAccountId(rows: Array<Record<string, unknown>>): void {
  rows.sort((a, b) =>
    byCodeUnit(a.account_id as string, b.account_id as string),
  );
}

// --- Chain-link derivation ---------------------------------------------------------

export type Link = { account: AccountRef; prevHash: string; hash: string };

// Derives the new link for every account a posting touches, given the current heads (a missing
// entry is a new account at genesis). The previous hash arrives as hex and is decoded back to
// bytes before chainHash (ledger.ts) folds in the posting details. Hashes are independent across
// accounts, so the one batched head read each engine does first cannot change the result.
export async function chainLinksFor(
  digest: Digest,
  posting: Posting,
  heads: Map<string, string>,
): Promise<ReadonlyArray<Link>> {
  const links: Link[] = [];
  for (const account of distinctAccounts(posting.legs)) {
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

// --- Account recognition ----------------------------------------------------------

// The platform ("system") accounts the schema seeds up front. db/*-schema.sql inserts exactly these
// SYSTEM ids, so they always exist before any posting can name them.
const SEEDED_SYSTEM_ACCOUNTS: ReadonlySet<string> = new Set(
  Object.values(SYSTEM),
);

// Whether an account is schema-seeded, or a shard of one (`platform:revenue#3`). True skips the
// existence query. The row itself is created elsewhere (schema for bare ids, first-use insert for
// shards). A typo like `platform:revenuee` falls through and gets a clean UNKNOWN_ACCOUNT.
export function isSeededSystemAccount(account: AccountRef): boolean {
  return (
    SEEDED_SYSTEM_ACCOUNTS.has(account) ||
    SEEDED_SYSTEM_ACCOUNTS.has(baseOf(account))
  );
}

// --- Known-accounts cache ---------------------------------------------------------

// Accounts whose `accounts` and `account_balances` rows are known to exist as committed data, so
// the hot path can skip first-use probes and plants. An entry is added only from committed
// evidence: a probe that saw the row, or a plant promoted after its transaction committed.
// Account rows are never deleted, so an entry can never turn false. A deployment that resets its
// database must recreate the store (tests provision a fresh store per run). The set is a bounded
// FIFO. Eviction only costs the evicted account a re-probe.
export class KnownAccounts {
  private readonly entries = new Set<string>();
  private readonly capacity: number;

  constructor(capacity: number = 65_536) {
    this.capacity = capacity;
  }

  has(account: string): boolean {
    return this.entries.has(account);
  }

  add(account: string): void {
    if (this.entries.has(account)) {
      return;
    }
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.values().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.add(account);
  }
}

// The plants a transaction has made but not yet committed. The engine promotes them into
// KnownAccounts only after COMMIT succeeds. `mark`/`rollbackTo` mirror savepoints, so a partial
// rollback un-stages exactly the plants it undid.
export class StagedAccounts {
  private accounts: string[] = [];

  add(account: string): void {
    this.accounts.push(account);
  }

  mark(): number {
    return this.accounts.length;
  }

  rollbackTo(mark: number): void {
    this.accounts.length = mark;
  }

  promoteInto(known: KnownAccounts): void {
    for (const account of this.accounts) {
      known.add(account);
    }
    this.accounts = [];
  }
}

// The chain heads a transaction has already observed or advanced, captured at lock time. The
// FOR UPDATE that locks a balance row returns its head in the same statement. The lock is held
// until commit, so the captured head stays exact for the transaction's lifetime. Writes journal
// their overwrites so a savepoint rollback can restore exactly the heads it undid. A stale
// forward head would fork the chain on the next append.
export class TxHeads {
  private readonly map = new Map<string, string>();
  private journal: Array<[string, string | undefined]> = [];

  get(account: string): string | undefined {
    return this.map.get(account);
  }

  has(account: string): boolean {
    return this.map.has(account);
  }

  set(account: string, hash: string): void {
    this.journal.push([account, this.map.get(account)]);
    this.map.set(account, hash);
  }

  mark(): number {
    return this.journal.length;
  }

  rollbackTo(mark: number): void {
    for (let i = this.journal.length - 1; i >= mark; i -= 1) {
      const [account, prior] = this.journal[i]!;
      if (prior === undefined) {
        this.map.delete(account);
      } else {
        this.map.set(account, prior);
      }
    }
    this.journal.length = mark;
  }
}

// After a successful write, the new link hashes are the accounts' heads. Recording them keeps
// the lock-time capture exact for this transaction's next append. Once an account has an
// uncommitted link, a competing extension blocks on the chain-fork unique index until this
// transaction ends, so the forward head cannot go stale mid-transaction.
export function advanceCapturedHeads(
  heads: TxHeads | undefined,
  transactions: ReadonlyArray<Transaction>,
): void {
  if (heads === undefined) {
    return;
  }
  for (const transaction of transactions) {
    for (const link of transaction.links) {
      heads.set(link.account, link.hash);
    }
  }
}

// --- Transient-conflict retry -----------------------------------------------------

// A unit-of-work that an engine runs between BEGIN and COMMIT. `withTransientRetry` re-runs the
// whole attempt (which includes the BEGIN, the work, and the COMMIT) on a transient conflict.
// Each engine therefore passes a single closure that owns one fresh transaction per try.
type Attempt<T> = () => Promise<T>;

// Returns true only for a transient lock conflict that the database raised by breaking a tie, such
// as a deadlock or a serialization abort, and that rolled the transaction back without committing.
// It returns false for a domain fault or a CHECK or constraint violation. Only a transient conflict
// is safe to retry, because the aborted attempt persisted nothing. Each engine supplies its own
// driver-specific test: pg checks `error.code`, mysql2 checks `error.errno`.
export type IsTransientConflict = (error: unknown) => boolean;

/**
 * The names every SQL engine emits its own signals under, and the names `ops` matches on. Both
 * sides import these, so a rename is a compile error rather than a detector that quietly stops
 * firing.
 */
export const ENGINE_METRICS = Object.freeze({
  /** One per transient conflict, tagged `outcome: 'conflict' | 'exhausted'`. */
  retry: 'engine.retry',
  /** One per commit the retry budget rescued. */
  retryRecovered: 'engine.retry.recovered',
  /** Logged once when a budget runs out. */
  retryExhausted: 'engine.retry.exhausted',
  /** One per pool 'error' event the driver already recovered from. */
  poolError: 'engine.pool.error',
  /** One per connection checkout. */
  poolAcquire: 'engine.pool.acquire',
  /** The wait, in milliseconds, each checkout took. */
  poolAcquireMs: 'engine.pool.acquire_ms',
} as const);

// --- Retry observability -----------------------------------------------------------
//
// A retry that then commits is invisible in the app's outcome, which hides the contention the
// engine absorbs. Two channels see it: the module-level observer a bench installs, and the
// per-store observer `retryTelemetry` builds from the runtime meter and logger. The second
// channel is how a production host sees a deadlock storm the retry budget is silently absorbing.
export type RetryEvent =
  // A transient conflict was caught, and a fresh attempt is about to run. `attempt` is the try that failed.
  | { type: 'retry'; attempt: number; error: unknown }
  // Committed, but only after retrying (`attempts` > 1). One per op the retry budget rescued.
  | { type: 'recovered'; attempts: number }
  // The budget ran out on a still-transient conflict, and the error is rethrown. One per op that gave up.
  | { type: 'exhausted'; attempts: number; error: unknown };

export type RetryObserver = (event: RetryEvent) => void;

let retryObserver: RetryObserver | null = null;

// Install (or clear, with null) the retry observer. Returns the previous so a caller can restore it.
export function setRetryObserver(
  observer: RetryObserver | null,
): RetryObserver | null {
  const previous = retryObserver;
  retryObserver = observer;
  return previous;
}

/**
 * Builds the production retry observer from a store's optional meter and logger, or undefined when
 * neither is wired. Each transient conflict and each exhausted budget counts as `engine.retry`,
 * tagged with the outcome. A commit the budget rescued counts as `engine.retry.recovered`. An
 * exhausted budget also logs `engine.retry.exhausted` before the error reaches the caller.
 */
export function retryTelemetry(
  runtime: { meter?: Meter; logger?: Logger },
  engine: string,
): RetryObserver | undefined {
  const { meter, logger } = runtime;
  if (meter === undefined && logger === undefined) return undefined;
  return (event) => {
    if (event.type === 'retry') {
      meter?.count(ENGINE_METRICS.retry, 1, { engine, outcome: 'conflict' });
      return;
    }
    if (event.type === 'recovered') {
      meter?.count(ENGINE_METRICS.retryRecovered, 1, { engine });
      return;
    }
    meter?.count(ENGINE_METRICS.retry, 1, { engine, outcome: 'exhausted' });
    logger?.log('warn', ENGINE_METRICS.retryExhausted, {
      engine,
      attempts: event.attempts,
    });
  };
}

/**
 * Builds the pool's 'error' listener from a store's optional meter and logger. `pg` raises this
 * event when a server-side kill drops an idle connection — a failover, a server idle timeout, an
 * operator's pg_terminate_backend — and an unlistened 'error' event ends the process. The driver
 * has already discarded the client, so there is no operation to fail: the event is counted as
 * `engine.pool.error` and logged under the same name, and the pool keeps serving. A store wired
 * to neither port reports nothing, the same as every other engine signal.
 */
export function poolErrorReporter(
  runtime: { meter?: Meter; logger?: Logger },
  engine: string,
): (error: unknown) => void {
  const { meter, logger } = runtime;
  return (error) => {
    meter?.count(ENGINE_METRICS.poolError, 1, { engine });
    logger?.log('error', ENGINE_METRICS.poolError, {
      engine,
      reason: error instanceof Error ? error.message : String(error),
    });
  };
}

type RetryOptions = { maxAttempts?: number; observer?: RetryObserver };

// Runs `attempt`, one full transaction, under a bounded transient-conflict retry. A transient
// conflict waits a short jittered backoff and gets a fresh attempt. After `maxAttempts` tries the
// last error is rethrown unchanged. A non-transient error is never retried.
//
// The budget is 10, not 2-3. Under deep concurrency many writers contend on one shared account's
// chain head, so a single posting can lose the fork/continuity race several times before it
// commits. The jitter window widens with each try (capped) so a herd that just collided spreads
// out instead of re-colliding in lock-step.
export async function withTransientRetry<T>(
  attempt: Attempt<T>,
  isTransientConflict: IsTransientConflict,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 10;
  const observe = (event: RetryEvent): void => {
    retryObserver?.(event);
    options.observer?.(event);
  };
  for (let tries = 1; ; tries += 1) {
    try {
      const result = await attempt();
      if (tries > 1) observe({ type: 'recovered', attempts: tries });
      return result;
    } catch (error) {
      const transient = isTransientConflict(error);
      if (tries >= maxAttempts || !transient) {
        // Distinguish "gave up on a still-transient conflict" (the budget ran out) from "a
        // non-transient fault on the first throw". Only the former is retry pressure that hit its cap.
        if (transient) observe({ type: 'exhausted', attempts: tries, error });
        throw error;
      }
      observe({ type: 'retry', attempt: tries, error });
      await sleep((2 + Math.random() * 8) * Math.min(tries, 5));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How a lost install race surfaces. Two sessions installing the shared money functions at once
// collide on the same catalog rows. Postgres refuses a concurrent CREATE OR REPLACE with
// "tuple concurrently updated" (or a duplicate pg_proc/pg_namespace key). MySQL's
// drop-then-create pair loses as "already exists".
const CONCURRENT_INSTALL = new RegExp(
  [
    'tuple concurrently updated',
    'duplicate key value violates unique constraint "pg_(proc|namespace)',
    'FUNCTION [\\w.]+ already exists',
  ].join('|'),
  'i',
);

/**
 * Runs the money install, retrying a lost concurrent-install race. The install is
 * idempotent, so the loser just runs it again. Any other failure propagates on the first throw.
 */
export async function installMoneyRetrying(
  install: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await install();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 5 || !CONCURRENT_INSTALL.test(message)) throw error;
      await sleep(50 * attempt + Math.random() * 150);
    }
  }
}

// --- Row decoders -----------------------------------------------------------------

export function rowToSaga(row: Record<string, unknown>): Saga {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    reserve: toAmount('CREDIT', readMinor(row.reserve)),
    rateId: row.rate_id as string,
    txnId: row.txn_id as string,
    state: row.state as SagaState,
    providerRef: (row.provider_ref as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    payoutUsd:
      row.payout_usd === null || row.payout_usd === undefined
        ? null
        : toAmount('USD', readMinor(row.payout_usd)),
    attempts: Number(row.attempts),
    dueAt: Number(row.due_at),
    updatedAt: Number(row.updated_at),
  };
}

export function rowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sellerId: row.seller_id as string,
    sku: row.sku as string,
    price: toAmount('CREDIT', readMinor(row.price)),
    txnId: row.txn_id as string,
    periodMs: Number(row.period_ms),
    state: row.state as Subscription['state'],
    period: Number(row.period),
    attempts: Number(row.attempts),
    nextDueAt: Number(row.next_due_at),
    updatedAt: Number(row.updated_at),
  };
}

export function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    root: row.root as string,
    signature: row.signature as string,
    count: Number(row.count),
    at: Number(row.at),
    // Rows sealed before versioning decode as v1 with no sum; verifyCheckpoint keeps checking
    // them under the original hash-only construction.
    v: Number(row.v ?? 1) === 2 ? 2 : 1,
    sum: (row.sum as string | null) ?? null,
    kid: (row.kid as string | null) ?? null,
  };
}

// pg and mysql2 both normally hand JSON columns over already parsed. Parse only if a driver
// config returned the raw string.
export function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export function rowToOutbox(row: Record<string, unknown>): OutboxMessage {
  return {
    id: row.id as string,
    event: parseJson(row.event) as OutboxMessage['event'],
    status: row.status as OutboxMessage['status'],
    attempts: Number(row.attempts),
    reason: (row.dead_letter_reason as string | null) ?? null,
    correlationId: (row.correlation_id as string | null) ?? null,
  };
}

// The operation decodes through the wire contract's field table, so a string field holding text
// shaped like an amount stays text (wire-contract.ts).
export function rowToInbox(row: Record<string, unknown>): InboxMessage {
  return {
    id: row.id as string,
    key: row.key as string,
    operation: decodeStoredOperation(parseJson(row.operation)),
    status: row.status as InboxMessage['status'],
    attempts: Number(row.attempts),
    receivedAt: Number(row.received_at),
    reason: (row.dead_letter_reason as string | null) ?? null,
  };
}

export function rowToPromoGrant(row: Record<string, unknown>): PromoGrant {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
    expiresAt: Number(row.expires_at),
    // Boolean() reads both drivers' spellings: pg's bool and mysql's tinyint.
    reversed: Boolean(row.reversed),
  };
}

export function rowToAccrual(row: Record<string, unknown>): AccrualRow {
  return {
    orderId: row.order_id as string,
    sellerId: row.seller_id as string,
    seq: Number(row.seq),
    amount: toAmount('CREDIT', readMinor(row.amount)),
    shard: row.shard as AccountRef,
    status: row.status as AccrualRow['status'],
    txnId: row.txn_id as string,
    settledTxnId: (row.settled_txn_id as string | null) ?? null,
    recordedAt: Number(row.recorded_at),
  };
}

/** A posting leg as it is spelled inside a JSON column. */
export interface EncodedLeg {
  account: string;
  amount: string;
}

/**
 * Spells legs for a JSON column: the account, and the amount as the lab's canonical
 * `CURRENCY:12.34` text.
 *
 * Every engine stores this one spelling. An engine that wrote minor units under the same
 * `CURRENCY:` prefix would produce text the lab's own decoder reads as a hundred times the
 * amount, with no throw to mark it.
 */
export function encodeLegs(legs: ReadonlyArray<Leg>): EncodedLeg[] {
  return legs.map((leg) => ({
    account: leg.account,
    amount: encodeAmount(leg.amount),
  }));
}

/**
 * Reads back what {@link encodeLegs} wrote, refusing any other spelling of an amount.
 *
 * `CREDIT:60000` decodes as sixty thousand credits, which is what an older MySQL emit meant by
 * six hundred. Re-encoding separates them: only the canonical text is its own encoding, so a
 * value stored in minor units is named and refused instead of read as a different number.
 */
export function decodeLegs(legs: ReadonlyArray<EncodedLeg>): Leg[] {
  return legs.map((leg) => ({
    account: leg.account as AccountRef,
    amount: decodeCanonicalAmount(leg.amount, 'Stored leg amount'),
  }));
}

/**
 * Assembles a {@link Sale} from its row, once the legs have been decoded.
 *
 * The legs arrive already decoded because reaching them is per-engine: Postgres hands back
 * parsed jsonb and MySQL hands back text. Their spelling is not — both engines decode through
 * {@link decodeLegs}. What is also not per-engine is the rule that the price and fee take their
 * currency from the first leg — written twice, that is how one sale reads for two different
 * amounts depending on the store.
 */
export function rowToSale(
  row: Record<string, unknown>,
  legs: readonly Leg[],
): Sale {
  const priceCurrency = (legs[0]?.amount.currency ??
    'CREDIT') as Amount['currency'];
  return {
    orderId: row.order_id as string,
    buyerId: row.buyer_id as string,
    recipientId: (row.recipient_id as string | null) ?? undefined,
    sku: row.sku as string,
    price: toAmount(priceCurrency, readMinor(row.price)),
    fee: toAmount(priceCurrency, readMinor(row.fee)),
    legs: legs as Leg[],
    txnId: row.txn_id as string,
    postedAt: Number(row.posted_at),
  };
}

/**
 * Ends a pool the store opened, and refuses to end one the caller handed in.
 *
 * Ownership follows creation: a resource the framework opened, the framework closes. `owned` is
 * null on the caller-supplied branch, which is what makes the refusal structural rather than a
 * flag somebody can set wrong.
 */
export async function endOwnedPool(
  owned: { end(): Promise<void> } | null,
  engine: string,
  verb: string,
): Promise<void> {
  if (owned === null) {
    throw new Error(
      `${engine} ${verb}: the pool came from the caller, so this store may not end it`,
    );
  }
  await owned.end();
}

// How much a stored leg changed its account's balance. Rebuild the leg and apply the account's
// sign rule. Leg amounts are debit-positive. Some accounts grow on a debit, others on a credit.
export function naturalDelta(
  account: AccountRef,
  row: Record<string, unknown>,
): Amount {
  const leg: Leg = {
    account,
    amount: toAmount(row.currency as Amount['currency'], readMinor(row.amount)),
  };
  return balanceDelta(leg);
}
