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

import { randomUUID } from 'node:crypto';

import { decodeAmount, zero, type Amount } from '#src/money.ts';

import type {
  EntitlementAttrs,
  Operation,
  Principal,
  Recipient,
} from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Velocity } from '#src/ports.ts';

// Fresh idempotency key per call (the economy uses it to dedupe retried requests). Each
// call gets a new key, so a test only acts like a retry when it deliberately reuses one.
//
// The key carries a per-process random prefix, not just a bare counter: the SQL backends persist
// idempotency rows across runs, so a fixed `idem_<n>` from one run collides with a row a previous
// run left behind, and the second run's request replays as a duplicate instead of executing. The
// bench hit exactly this: its requestPayout probe came back `status: 'duplicate'` and the cell
// read n/a. A run-unique prefix makes every key hermetic to the run that minted it, so a probe
// never matches a persisted row. The counter still increments so keys are unique within a run too.
let n = 0;
const RUN_PREFIX = randomUUID();
const claim = (): string => `idem_${RUN_PREFIX}_${n++}`;

// Default actors for when a test doesn't care about the caller: a trusted internal
// service, and a human operator running a manual action.
const system: Principal = { kind: 'system', service: 'test' };
const operator: Principal = { kind: 'operator', operatorId: 'op_test' };

/**
 * Builds a CREDIT amount from a dollars-and-cents string like `'12.34'`. An `Amount` is
 * only created by parsing such a string (see `decodeAmount` in money.ts).
 */
export const credit = (dollars: string): Amount =>
  decodeAmount(dollars, 'CREDIT');

// Builds a blank velocity accumulator for a subject with no spending in the current window.
// This is the same shape `windowedVelocity` returns for an empty attempt list. Use it to assert
// that a fresh or fully-aged-out subject reads as zero spent.
export const emptyVelocity = (subject: string): Velocity => ({
  subject,
  windowStart: 0,
  spent: zero('CREDIT'),
  attempts: 0,
});

/** Builds a USD amount from a dollars-and-cents string like `'12.34'`. */
export const usd = (dollars: string): Amount => decodeAmount(dollars, 'USD');

/**
 * Builds the actor value for an end user. A user may only act on their own accounts, so use
 * this when a test exercises a user's own request.
 */
export const principal = (userId: string): Principal => ({
  kind: 'user',
  userId,
});

// Each function below builds one kind of `Operation`, filling in the boilerplate fields
// (fresh idempotency key, default actor, other defaults) so a test passes only what it
// cares about. The `...o` spread lets a test override any default.
export const topUp = (o: {
  userId: string;
  amount: Amount;
  source?: string;
  actor?: Principal;
}): Operation => ({
  kind: 'topUp',
  idempotencyKey: claim(),
  actor: system,
  source: 'card',
  ...o,
});

export const grantPromo = (o: {
  userId: string;
  amount: Amount;
  expiresAt?: number;
  actor?: Principal;
}): Operation => ({
  kind: 'grantPromo',
  idempotencyKey: claim(),
  actor: system,
  expiresAt: 86_400_000,
  ...o,
});

export const spend = (o: {
  buyerId: string;
  sku: string;
  price: Amount;
  recipients?: Recipient[];
  ageRestricted?: boolean;
  giftTo?: string;
  actor?: Principal;
  orderId?: string;
}): Operation => ({
  kind: 'spend',
  idempotencyKey: claim(),
  actor: principal(o.buyerId),
  orderId: `ord_${n}`,
  ...o,
});

export const refund = (o: {
  orderId: string;
  reason?: string;
  actor?: Principal;
}): Operation => ({
  kind: 'refund',
  idempotencyKey: claim(),
  actor: system,
  ...o,
});

export const clawback = (o: {
  userId: string;
  amount: Amount;
  orderId?: string;
  key?: string;
  reason?: string;
  actor?: Principal;
}): Operation => ({
  kind: 'clawback',
  idempotencyKey: claim(),
  actor: operator,
  ...o,
});

export const requestPayout = (o: {
  userId: string;
  amount: Amount;
  actor?: Principal;
}): Operation => ({
  kind: 'requestPayout',
  idempotencyKey: claim(),
  actor: principal(o.userId),
  ...o,
});

export const settlePayout = (o: {
  sagaId: string;
  providerRef?: string;
  providerAmount?: Amount;
  actor?: Principal;
}): Operation => ({
  kind: 'settlePayout',
  idempotencyKey: claim(),
  actor: system,
  providerRef: `prov_${o.sagaId}`,
  providerAmount: usd('0.02'),
  ...o,
});

export const subscribe = (o: {
  userId: string;
  sellerId: string;
  sku: string;
  price: Amount;
  periodMs?: number;
  actor?: Principal;
}): Operation => ({
  kind: 'subscribe',
  idempotencyKey: claim(),
  actor: principal(o.userId),
  ...o,
  // Default applied after the spread: a caller forwarding an absent `periodMs` passes
  // `periodMs: undefined`, which would otherwise clobber the default and leave a NaN period end.
  periodMs: o.periodMs ?? 30 * 24 * 60 * 60_000,
});

export const cancelSubscription = (o: {
  subscriptionId: string;
  actor?: Principal;
}): Operation => ({
  kind: 'cancelSubscription',
  idempotencyKey: claim(),
  actor: system,
  ...o,
});

export const grantEntitlement = (o: {
  userId: string;
  sku: string;
  attrs?: EntitlementAttrs;
  actor?: Principal;
}): Operation => ({
  kind: 'grantEntitlement',
  idempotencyKey: claim(),
  actor: system,
  ...o,
});

export const revokeEntitlement = (o: {
  userId: string;
  sku: string;
  reason?: string;
  actor?: Principal;
}): Operation => ({
  kind: 'revokeEntitlement',
  idempotencyKey: claim(),
  actor: system,
  ...o,
});

export const adjust = (o: {
  account: AccountRef;
  amount: Amount;
  reason: string;
  actor?: Principal;
}): Operation => ({
  kind: 'adjust',
  idempotencyKey: claim(),
  actor: operator,
  ...o,
});

export const reverse = (o: {
  txnId: string;
  reason: string;
  actor?: Principal;
}): Operation => ({
  kind: 'reverse',
  idempotencyKey: claim(),
  actor: operator,
  ...o,
});
