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

import { decodeAmount, zero, type Amount } from '#src/money.ts';

import type {
  EntitlementAttrs,
  Operation,
  Principal,
  Recipient,
} from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Velocity } from '#src/ports.ts';

// A counter that hands out a fresh idempotency key on every call. An idempotency key
// is the value the economy uses to recognize a retried request and run it only once.
// Because each call gets a new key, two builder calls never collide by accident, so a
// test only acts like a retry when it deliberately reuses a key.
let n = 0;
const claim = (): string => `idem_${n++}`;

// Default "who is acting" stand-ins, used when a test doesn't care about the caller:
// a trusted internal service, and a human operator running a manual action.
const system: Principal = { kind: 'system', service: 'test' };
const operator: Principal = { kind: 'operator', operatorId: 'op_test' };

/**
 * Build a CREDIT amount from a dollars-and-cents string like `'12.34'`. An `Amount`
 * can only be created by parsing such a string (see `decodeAmount` in money.ts), which
 * is what lets tests write money as plain text.
 */
export const credit = (dollars: string): Amount =>
  decodeAmount(dollars, 'CREDIT');

// A blank velocity accumulator for a subject with no spending in the current window — the same
// shape `windowedVelocity` returns for an empty attempt list. Tests use it to assert that a
// fresh or fully-aged-out subject reads as zero spent.
export const emptyVelocity = (subject: string): Velocity => ({
  subject,
  windowStart: 0,
  spent: zero('CREDIT'),
  attempts: 0,
});

/** Build a USD amount from a dollars-and-cents string like `'12.34'`. */
export const usd = (dollars: string): Amount => decodeAmount(dollars, 'USD');

/**
 * Build the "who is acting" value for an end user. A user may only act on their own
 * accounts, so this is the caller to use when a test exercises a user's own request.
 */
export const principal = (userId: string): Principal => ({
  kind: 'user',
  userId,
});

// The functions below each build one kind of `Operation` request. They fill in the
// required-but-uninteresting fields (a fresh idempotency key, a default actor, and any
// other defaults) so a test only has to pass the values it actually cares about; the
// `...o` spread lets a test override any of those defaults.
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
  // Apply the default AFTER the spread: a caller that destructures and forwards an absent
  // `periodMs` passes `periodMs: undefined`, which would otherwise clobber the default and
  // leave the subscription with a NaN period end.
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
