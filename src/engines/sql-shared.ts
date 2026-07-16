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

import { decodeAmounts, toAmount } from '#src/money.ts';
import { byCodeUnit, fromHex } from '#src/bytes.ts';
import { GENESIS, GENESIS_HEX, balanceDelta, chainHash } from '#src/ledger.ts';
import { sha256Digest } from '#src/digest.ts';
import { SYSTEM, baseOf } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Operation } from '#src/contract.ts';
import type {
  Checkpoint,
  Digest,
  InboxEntry,
  Leg,
  Logger,
  Meter,
  OutboxMessage,
  Posting,
  PromoGrant,
  Saga,
  SagaState,
  Subscription,
} from '#src/ports.ts';

// Helpers shared by the Postgres and MySQL engines: default services, distinct-account ordering,
// chain-link derivation, and row-to-domain decoders. No SQL strings, no driver specifics.

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
// A 23505 (Postgres) or 1062 (MySQL) violation that names this index is a chain-head fork: two
// writers used the same prev_hash and one of the inserts was rejected. withTransientRetry treats
// that fork as transient and retries it. This name must match the index name in
// db/postgresql-schema.sql and db/mysql-schema.sql. Rename the index there without renaming it
// here and the retry stops firing, so the cold-start fork race resurfaces as an unretried error.
export const CHAIN_FORK_INDEX = 'chain_links_account_prev_uq';

// The leading text of the chain-continuity trigger's error message in both schemas. The trigger
// catches the same cold-start / stale-head race as the fork index above, so withTransientRetry
// treats it as transient and re-reads the head. The match is on this message prefix, not the bare
// SQLSTATE (Postgres P0001 / MySQL 1644), because that state is also raised for genuine
// `conservation` and `balance integrity` faults, which must never be retried. Keep this string in
// lockstep with the trigger MESSAGE_TEXT in db/postgresql-schema.sql and db/mysql-schema.sql.
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

// The platform ("system") accounts the schema seeds up front; db/*-schema.sql inserts exactly these
// SYSTEM ids, so they always exist before any posting can name them.
const SEEDED_SYSTEM_ACCOUNTS: ReadonlySet<string> = new Set(
  Object.values(SYSTEM),
);

// Whether an account is schema-seeded, or a shard of one (`platform:revenue#3`). True skips the
// existence query; the row itself is created elsewhere (schema for bare ids, first-use insert for
// shards). A typo like `platform:revenuee` falls through and gets a clean UNKNOWN_ACCOUNT.
export function isSeededSystemAccount(account: AccountRef): boolean {
  return (
    SEEDED_SYSTEM_ACCOUNTS.has(account) ||
    SEEDED_SYSTEM_ACCOUNTS.has(baseOf(account))
  );
}

// --- Transient-conflict retry -----------------------------------------------------

// A unit-of-work that an engine runs between BEGIN and COMMIT. `withTransientRetry` re-runs the
// whole attempt (which includes the BEGIN, the work, and the COMMIT) on a transient conflict, so
// each engine passes a single closure that owns one fresh transaction per try.
type Attempt<T> = () => Promise<T>;

// Returns true only for a transient lock conflict that the database raised by breaking a tie, such
// as a deadlock or a serialization abort, and that rolled the transaction back without committing.
// It returns false for a domain fault or a CHECK or constraint violation. Only a transient conflict
// is safe to retry, because the aborted attempt persisted nothing. Each engine supplies its own
// driver-specific test: pg checks `error.code`, mysql2 checks `error.errno`.
export type IsTransientConflict = (error: unknown) => boolean;

// --- Retry observability -----------------------------------------------------------
//
// A retry that then commits is invisible in the app's outcome, which hides the contention the
// engine absorbs. Two channels see it: the module-level observer a bench installs, and the
// per-store observer built by `retryTelemetry` from the runtime meter and logger, which is how a
// production host sees a deadlock storm the retry budget is silently absorbing.
export type RetryEvent =
  // A transient conflict was caught; a fresh attempt is about to run. `attempt` is the try that failed.
  | { type: 'retry'; attempt: number; error: unknown }
  // Committed, but only after retrying (`attempts` > 1). One per op the retry budget rescued.
  | { type: 'recovered'; attempts: number }
  // The budget ran out on a still-transient conflict; the error is rethrown. One per op that gave up.
  | { type: 'exhausted'; attempts: number; error: unknown };

export type RetryObserver = (event: RetryEvent) => void;

let retryObserver: RetryObserver | null = null;

// Install (or clear, with null) the retry observer; returns the previous so a caller can restore it.
export function setRetryObserver(
  observer: RetryObserver | null,
): RetryObserver | null {
  const previous = retryObserver;
  retryObserver = observer;
  return previous;
}

/**
 * Builds the production retry observer from a store's optional meter and logger, or undefined when
 * neither is wired. Each transient conflict and each exhausted budget counts as `engine.retry`
 * (tagged with the outcome), a commit the budget rescued counts as `engine.retry.recovered`, and an
 * exhausted budget also logs `engine.retry.exhausted` before the error reaches the caller.
 */
export function retryTelemetry(
  runtime: { meter?: Meter; logger?: Logger },
  engine: 'postgres' | 'mysql',
): RetryObserver | undefined {
  const { meter, logger } = runtime;
  if (meter === undefined && logger === undefined) return undefined;
  return (event) => {
    if (event.type === 'retry') {
      meter?.count('engine.retry', 1, { engine, outcome: 'conflict' });
      return;
    }
    if (event.type === 'recovered') {
      meter?.count('engine.retry.recovered', 1, { engine });
      return;
    }
    meter?.count('engine.retry', 1, { engine, outcome: 'exhausted' });
    logger?.log('warn', 'engine.retry.exhausted', {
      engine,
      attempts: event.attempts,
    });
  };
}

type RetryOptions = { maxAttempts?: number; observer?: RetryObserver };

// Runs `attempt`, one full transaction, under a bounded transient-conflict retry: a transient
// conflict waits a short jittered backoff and gets a fresh attempt; after `maxAttempts` tries the
// last error is rethrown unchanged. A non-transient error is never retried.
//
// The budget is 10 (not 2-3): under deep concurrency many writers contend on one shared account's
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
        // non-transient fault on the first throw"; only the former is retry pressure that hit its cap.
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
// collide on the same catalog rows: Postgres refuses a concurrent CREATE OR REPLACE with
// "tuple concurrently updated" (or a duplicate pg_proc/pg_namespace key), and MySQL's
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
 * Runs the vendored money install, retrying a lost concurrent-install race: the install is
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
  };
}

// pg and mysql2 both normally hand JSON columns over already parsed; parse only if a driver
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
  };
}

// decodeAmounts re-brands every stored `CREDIT:12.34` string back into an Amount (money.ts).
export function rowToInbox(row: Record<string, unknown>): InboxEntry {
  return {
    id: row.id as string,
    key: row.key as string,
    operation: decodeAmounts(parseJson(row.operation)) as Operation,
    status: row.status as InboxEntry['status'],
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

// How much a stored leg changed its account's balance: rebuild the leg and apply the account's
// sign rule (leg amounts are debit-positive; some accounts grow on a debit, others on a credit).
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
