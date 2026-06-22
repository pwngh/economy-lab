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

// Helpers shared by the Postgres and MySQL adapters. Pure call mechanics and row→domain
// decoding; no SQL strings, no driver specifics.

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

// --- Row decoders -----------------------------------------------------------------

export function rowToSaga(row: Record<string, unknown>): Saga {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    reserve: toAmount('CREDIT', readMinor(row.reserve)),
    rateId: row.rate_id as string,
    state: row.state as SagaState,
    providerRef: (row.provider_ref as string | null) ?? null,
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

// --- Local helpers ----------------------------------------------------------------

export function metaString(
  meta: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  let value = meta[key];
  return typeof value === 'string' ? value : fallback;
}

export function metaNumber(
  meta: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  let value = meta[key];
  return typeof value === 'number' ? value : fallback;
}
