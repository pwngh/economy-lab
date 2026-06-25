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

// Helpers shared by the Postgres and MySQL engines: default services, the genesis-hash hex,
// distinct-account ordering, and row→domain decoders. No SQL strings, no driver specifics. (The
// generic posting-meta readers moved to src/meta.ts, so a non-SQL store can read meta without
// importing engine code.)

// --- Default services -------------------------------------------------------------

// SHA-256 via Web Crypto, available on every JS runtime.
export function defaultDigest(): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  };
}

// Clock fixed at time 0, so "posted at" timestamps are predictable in tests. Pass a real
// clock when wall-clock times matter.
export function defaultClock(): Clock {
  return { now: () => 0 };
}

// Hash preceding an account's first entry, as lowercase hex. GENESIS is 32 zero bytes
// (ledger.ts), so this is 64 zeros.
export let GENESIS_HEX = toHex(GENESIS);

// Coerce a DB value to BigInt explicitly, so the adapter decides the type rather than the
// driver.
export function readMinor(value: unknown): bigint {
  return BigInt(value as bigint | number | string);
}

// --- Distinct-account ordering ----------------------------------------------------

// Distinct accounts across these legs, in first-appearance order. A posting can touch an
// account on several legs but advances its hash chain only once, so dedupe to one per account.
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

// One step in an account's hash chain: account, hash before this entry, hash after.
export type Link = { account: AccountRef; prevHash: string; hash: string };

// --- Transient-conflict retry -----------------------------------------------------

// A unit-of-work that an engine runs between BEGIN and COMMIT. `withTransientRetry` re-runs the
// whole attempt (which includes the BEGIN, the work, and the COMMIT) on a transient conflict, so
// each engine passes a single closure that owns one fresh transaction per try.
type Attempt<T> = () => Promise<T>;

// Decides whether a thrown error is a *transient* lock conflict the database itself raised by
// breaking a tie — a deadlock or serialization abort that rolled the transaction back without
// committing anything — as opposed to a domain fault, a CHECK/constraint violation, or any other
// error. Only the former is safe to retry: the aborted attempt persisted nothing, so re-running the
// whole transaction either succeeds (the conflict cleared) or reloads the now-terminal state and
// fails with the clean domain outcome. Each engine supplies its own driver-specific test (pg
// `error.code`, mysql2 `error.errno`).
export type IsTransientConflict = (error: unknown) => boolean;

// Run `attempt` (one full transaction) under a bounded transient-conflict retry. On a conflict the
// caller's own try/catch has already rolled the aborted transaction back, so this just waits a short
// jittered backoff and runs a fresh attempt. After `maxAttempts` tries it rethrows the last error
// unchanged, so a persistent conflict still surfaces rather than looping forever. A non-transient
// error (domain fault, constraint violation, anything else) is rethrown immediately on the first
// occurrence — it is never retried. Backoff is a few milliseconds with random jitter, fine for
// runtime engine code (this is a cold path taken only when the database aborts a transaction).
export async function withTransientRetry<T>(
  attempt: Attempt<T>,
  isTransientConflict: IsTransientConflict,
  maxAttempts = 5,
): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= maxAttempts || !isTransientConflict(error)) {
        throw error;
      }
      // A few ms with jitter so two transactions that just deadlocked don't re-collide in lock-step.
      await sleep(2 + Math.random() * 8);
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
    // Terminal-outcome fields, both null until the saga reaches its terminal state: `reason` is the
    // worker's failure reason (FAILED), `payoutUsd` the gross USD disbursed (SETTLED, decoded as a
    // USD Amount the way `reserve` decodes a CREDIT one).
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
