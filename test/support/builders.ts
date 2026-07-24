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

import { decodeAmount, usd, zero, type Amount } from '#src/money.ts';
import { userActor } from '#src/actor.ts';
// The PUBLIC operation constructors, aliased so the test builders below can default the boilerplate
// and delegate to them. This routes the whole suite through the shipped constructors, so a drift in
// any Operation arm surfaces as a compile error here rather than two literals diverging in silence.
import {
  adjust as makeAdjust,
  cancelSubscription as makeCancelSubscription,
  clawback as makeClawback,
  grantEntitlement as makeGrantEntitlement,
  grantPromo as makeGrantPromo,
  refund as makeRefund,
  requestPayout as makeRequestPayout,
  reverse as makeReverse,
  reversePayout as makeReversePayout,
  revokeEntitlement as makeRevokeEntitlement,
  settlePayout as makeSettlePayout,
  spend as makeSpend,
  subscribe as makeSubscribe,
  topUp as makeTopUp,
} from '#src/operation.ts';

import type {
  EntitlementAttributes,
  Operation,
  Principal,
  Recipient,
} from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Velocity } from '#src/ports.ts';

// Fresh idempotency key per call; a test acts like a retry only by deliberate reuse. The prefix
// is run-unique because the SQL backends persist idempotency rows across runs — a bare counter
// key collides with a prior run's row and replays as a duplicate.
let n = 0;
const RUN_PREFIX = randomUUID();
const claim = (): string => `idem_${RUN_PREFIX}_${n++}`;

const system: Principal = { kind: 'system', service: 'test' };
const operator: Principal = { kind: 'operator', operatorId: 'op_test' };

/** A CREDIT amount from a dollars-and-cents string like '12.34'. */
export const credit = (dollars: string): Amount =>
  decodeAmount(dollars, 'CREDIT');

// The same shape `windowedVelocity` returns for an empty attempt list.
export const emptyVelocity = (subject: string): Velocity => ({
  subject,
  windowStart: 0,
  spent: zero('CREDIT'),
  attempts: 0,
});

/** Builds a USD amount from a dollars-and-cents string like `'12.34'`. */
export { usd };

/** A user actor; users may only act on their own accounts. */
export const principal = userActor;

// One builder per Operation kind: default the boilerplate (a fresh idempotency key, an actor, and
// per-kind fixture fields), then delegate to the public constructor so the Operation shape is
// single-sourced. The `...o` spread lets any test override a default.
export const topUp = (o: {
  userId: string;
  amount: Amount;
  source?: string;
  actor?: Principal;
}): Operation =>
  makeTopUp({ idempotencyKey: claim(), actor: system, source: 'card', ...o });

export const grantPromo = (o: {
  userId: string;
  amount: Amount;
  expiresAt?: number;
  actor?: Principal;
}): Operation =>
  makeGrantPromo({
    idempotencyKey: claim(),
    actor: system,
    expiresAt: 86_400_000,
    ...o,
  });

export const spend = (o: {
  buyerId: string;
  sku: string;
  price: Amount;
  recipients: Recipient[];
  ageRestricted?: boolean;
  giftTo?: string;
  actor?: Principal;
  orderId?: string;
}): Operation =>
  makeSpend({
    idempotencyKey: claim(),
    actor: principal(o.buyerId),
    orderId: `ord_${n}`,
    ...o,
  });

export const refund = (o: {
  orderId: string;
  reason?: string;
  actor?: Principal;
}): Operation => makeRefund({ idempotencyKey: claim(), actor: system, ...o });

export const clawback = (o: {
  userId: string;
  amount: Amount;
  orderId?: string;
  key?: string;
  reason?: string;
  actor?: Principal;
}): Operation =>
  makeClawback({ idempotencyKey: claim(), actor: operator, ...o });

export const requestPayout = (o: {
  userId: string;
  amount: Amount;
  actor?: Principal;
}): Operation =>
  makeRequestPayout({
    idempotencyKey: claim(),
    actor: principal(o.userId),
    ...o,
  });

export const settlePayout = (o: {
  sagaId: string;
  providerRef?: string;
  providerAmount?: Amount;
  actor?: Principal;
}): Operation =>
  makeSettlePayout({
    idempotencyKey: claim(),
    actor: system,
    providerRef: `prov_${o.sagaId}`,
    providerAmount: usd('100.00'),
    ...o,
  });

export const subscribe = (o: {
  userId: string;
  sellerId: string;
  sku: string;
  price: Amount;
  periodMs?: number;
  actor?: Principal;
}): Operation =>
  makeSubscribe({
    idempotencyKey: claim(),
    actor: principal(o.userId),
    ...o,
    // Resolved after the spread: a caller forwarding `periodMs: undefined` must not clobber the
    // default into a NaN period end.
    periodMs: o.periodMs ?? 30 * 24 * 60 * 60_000,
  });

export const cancelSubscription = (o: {
  subscriptionId: string;
  actor?: Principal;
}): Operation =>
  makeCancelSubscription({ idempotencyKey: claim(), actor: system, ...o });

export const grantEntitlement = (o: {
  userId: string;
  sku: string;
  attrs?: EntitlementAttributes;
  actor?: Principal;
}): Operation =>
  makeGrantEntitlement({ idempotencyKey: claim(), actor: system, ...o });

export const revokeEntitlement = (o: {
  userId: string;
  sku: string;
  reason?: string;
  actor?: Principal;
}): Operation =>
  makeRevokeEntitlement({ idempotencyKey: claim(), actor: system, ...o });

export const adjust = (o: {
  account: AccountRef;
  amount: Amount;
  reason: string;
  actor?: Principal;
}): Operation => makeAdjust({ idempotencyKey: claim(), actor: operator, ...o });

export const reverse = (o: {
  txnId: string;
  reason: string;
  actor?: Principal;
}): Operation =>
  makeReverse({ idempotencyKey: claim(), actor: operator, ...o });

export const reversePayout = (o: {
  userId: string;
  sagaId: string;
  reason?: string;
  providerReported?: boolean;
  actor?: Principal;
}): Operation =>
  makeReversePayout({
    idempotencyKey: claim(),
    actor: operator,
    reason: 'reversal',
    ...o,
  });
