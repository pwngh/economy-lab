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

/**
 * SHA-256 via Web Crypto, available on every JS runtime. The same bytes hash to the same
 * digest on every runtime, so the chain head an engine writes is reproducible everywhere.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for how engines plug into the ledger.
 */
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

// The unique index guarding each account's hash-chain head — chain_links (account_id, prev_hash).
// A 23505 (Postgres) or 1062 (MySQL) that names this index is a chain-head fork: two writers reached
// for the same head and one lost. withTransientRetry treats that as transient. Must match the index
// name in db/postgresql-schema.sql and db/mysql-schema.sql — rename it there without renaming it here
// and the retry silently stops firing, so the cold-start fork race returns with no error to show for it.
export let CHAIN_FORK_INDEX = 'chain_links_account_prev_uq';

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

// True only for a *transient* lock conflict the database raised by breaking a tie (deadlock or
// serialization abort) that rolled the transaction back without committing — never for a domain
// fault or a CHECK/constraint violation. Only the former is safe to retry: the aborted attempt
// persisted nothing. Each engine supplies its own driver-specific test (pg `error.code`, mysql2
// `error.errno`).
export type IsTransientConflict = (error: unknown) => boolean;

// Run `attempt` (one full transaction) under a bounded transient-conflict retry: on a conflict,
// wait a short jittered backoff and run a fresh attempt. After `maxAttempts` tries it rethrows the
// last error unchanged, so a persistent conflict surfaces rather than looping forever. A
// non-transient error is rethrown immediately on the first occurrence — never retried.
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
