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

import { toAmount } from '#src/money.ts';
import { toHex } from '#src/bytes.ts';
import { GENESIS } from '#src/ledger.ts';
import { sha256Digest } from '#src/digest.ts';
import { SYSTEM } from '#src/accounts.ts';

import type { AccountRef } from '#src/accounts.ts';
import type {
  Checkpoint,
  Clock,
  Digest,
  Leg,
  Saga,
  SagaState,
  Subscription,
} from '#src/ports.ts';

// Helpers shared by the Postgres and MySQL engines. This module holds the default services, the
// genesis-hash hex, distinct-account ordering, and row-to-domain decoders. It contains no SQL
// strings and no driver specifics. The generic posting-meta readers now live in src/meta.ts, so a
// non-SQL store can read meta without importing engine code.

// --- Default services -------------------------------------------------------------

/**
 * Returns a SHA-256 digest backed by Web Crypto, which is available on every JS runtime. The same
 * bytes hash to the same digest on every runtime, so the chain head an engine writes is
 * reproducible everywhere.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for how engines plug into the ledger.
 */
export function defaultDigest(): Digest {
  return sha256Digest();
}

export function defaultClock(): Clock {
  return { now: () => 0 };
}

export let GENESIS_HEX = toHex(GENESIS);

// The unique index guarding each account's hash-chain head, chain_links (account_id, prev_hash).
// A 23505 (Postgres) or 1062 (MySQL) violation that names this index is a chain-head fork: two
// writers used the same prev_hash and one of the inserts was rejected. withTransientRetry treats that fork as transient
// and retries it. This name must match the index name in db/postgresql-schema.sql and
// db/mysql-schema.sql. Rename the index there without renaming it here and the retry stops
// firing, so the cold-start fork race resurfaces as an unretried error.
export let CHAIN_FORK_INDEX = 'chain_links_account_prev_uq';

// The leading text of the chain-continuity trigger's error message in both schemas (Postgres
// `raise exception 'chain continuity: ...'`, MySQL `SIGNAL ... MESSAGE_TEXT = 'chain continuity: ...'`).
// That trigger is the other face of the same cold-start / stale-head race the fork index above catches:
// depending on timing, a concurrent writer to a not-yet-extended account trips the continuity trigger
// (a genesis link on a now-non-empty chain, or a prev_hash that is no longer the head) before the
// unique index does. withTransientRetry treats it as transient and re-reads the head. The match is on
// this message prefix, not the bare SQLSTATE (Postgres P0001 / MySQL 1644), because that same state is
// also raised for genuine `conservation` and `balance integrity` faults, which must never be retried --
// their messages start differently, so the prefix match excludes them. Keep this string in lockstep
// with the trigger MESSAGE_TEXT in db/postgresql-schema.sql and db/mysql-schema.sql.
export let CHAIN_CONTINUITY_MARKER = 'chain continuity';

export function readMinor(value: unknown): bigint {
  return BigInt(value as bigint | number | string);
}

// --- Distinct-account ordering ----------------------------------------------------

// Returns the distinct accounts across these legs, in first-appearance order. A posting can touch
// an account on several legs but advances its hash chain only once, so dedupe to one per account.
export function distinctAccounts(legs: ReadonlyArray<Leg>): AccountRef[] {
  let seen = new Set<AccountRef>();
  let order: AccountRef[] = [];
  for (let leg of legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      order.push(leg.account);
    }
  }
  return order;
}

// One step in an account's hash chain: the account, the hash before this entry, and the hash after.
export type Link = { account: AccountRef; prevHash: string; hash: string };

// --- Account recognition ----------------------------------------------------------

// The platform ("system") accounts the schema seeds up front; db/*-schema.sql inserts exactly these
// SYSTEM ids, so they always exist before any posting can name them.
let SEEDED_SYSTEM_ACCOUNTS: ReadonlySet<string> = new Set(
  Object.values(SYSTEM),
);

// Whether an account is one the schema pre-seeds. `hasAccount` uses this to confirm a platform
// account without a round trip, like a `usr_…:<kind>` suffix is confirmed without a query (the
// write path creates that one on first use). A platform-looking id that is not seeded — a typo
// like `platform:revenuee` — is absent here, so it falls through to the existence query and yields
// a clean UNKNOWN_ACCOUNT rather than reaching the database as a raw foreign-key violation. This
// matches the in-memory adapter, which recognizes the same set in-process.
export function isSeededSystemAccount(account: AccountRef): boolean {
  return SEEDED_SYSTEM_ACCOUNTS.has(account);
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

// --- Retry observability (off by default) -----------------------------------------
//
// A retry that then commits leaves no trace in the app's outcome — the caller just sees success — so
// the contention the engine absorbs under the hood is invisible. That is fine for production but hides
// a performance bench's most important signal. This optional observer lets the bench count that hidden
// retry pressure. It is null by default and costs nothing on the production path (each
// `retryObserver?.(...)` is a property read and short-circuit); production never sets it.
export type RetryEvent =
  // A transient conflict was caught; a fresh attempt is about to run. `attempt` is the try that failed.
  | { type: 'retry'; attempt: number; error: unknown }
  // Committed, but only after retrying (`attempts` > 1). One per op the retry budget rescued.
  | { type: 'recovered'; attempts: number }
  // The budget ran out on a still-transient conflict; the error is rethrown. One per op that gave up.
  | { type: 'exhausted'; attempts: number; error: unknown };

export type RetryObserver = (event: RetryEvent) => void;

let retryObserver: RetryObserver | null = null;

// Install (or clear, with null) the retry observer; returns the previous so a caller can restore it. The
// bench sets it around a sample and restores it in a `finally`, so retries don't leak across samples.
export function setRetryObserver(
  observer: RetryObserver | null,
): RetryObserver | null {
  const previous = retryObserver;
  retryObserver = observer;
  return previous;
}

// Runs `attempt`, one full transaction, under a bounded transient-conflict retry. On a transient
// conflict it waits a short jittered backoff and runs a fresh attempt. After `maxAttempts` tries it
// rethrows the last error unchanged, so a persistent conflict surfaces rather than looping forever.
// A non-transient error is rethrown immediately on the first occurrence and is never retried.
//
// The budget is 10 (not 2-3): under deep concurrency many writers contend on one shared
// account's chain head, so a single posting can lose the fork/continuity race several
// times before it succeeds -- with too small a budget those attempts surface as errors even though a retry
// would have committed cleanly. The backoff also widens with each try (jitter window grows with
// `tries`, capped) so a thundering herd that just collided spreads out instead of re-colliding in
// lock-step. A genuinely stuck conflict still bounds out at maxAttempts and rethrows. The observer
// hooks only report what the loop already decided; they do not change when an attempt is retried.
export async function withTransientRetry<T>(
  attempt: Attempt<T>,
  isTransientConflict: IsTransientConflict,
  maxAttempts = 10,
): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      const result = await attempt();
      if (tries > 1) retryObserver?.({ type: 'recovered', attempts: tries });
      return result;
    } catch (error) {
      const transient = isTransientConflict(error);
      if (tries >= maxAttempts || !transient) {
        // Distinguish "gave up on a still-transient conflict" (the budget ran out) from "a
        // non-transient fault on the first throw"; only the former is retry pressure that hit its cap.
        if (transient)
          retryObserver?.({ type: 'exhausted', attempts: tries, error });
        throw error;
      }
      retryObserver?.({ type: 'retry', attempt: tries, error });
      // Jitter so two transactions that just collided don't re-collide in lock-step, with the window
      // widening on each retry (capped) to thin out a herd contending on the same hot chain head.
      await sleep((2 + Math.random() * 8) * Math.min(tries, 5));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Terminal-outcome fields. Both are null until the saga reaches its terminal state. `reason`
    // holds the worker's failure reason on FAILED. `payoutUsd` holds the gross USD disbursed on
    // SETTLED, decoded as a USD Amount the way `reserve` decodes a CREDIT one.
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
  };
}
