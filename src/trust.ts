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

import type { Operation, Outcome } from '#src/contract.ts';
import type { Config } from '#src/config.ts';
import type { Attempt, Velocity } from '#src/ports.ts';
import type { RejectionCode } from '#src/errors.ts';

// The spending limit is set in CREDIT minor units (the smallest CREDIT unit, like
// cents for dollars). Every running total here is therefore in CREDIT, so the total
// and the limit are always compared in the same currency.
export let VELOCITY_CURRENCY = 'CREDIT' as const;

/**
 * The result of a risk check: either allow, or deny with a reason. When denied, the
 * `screenRisk` middleware turns this into a normal "no" answer the caller receives
 * (`rejected(reason, …)`); the reason is never raised as an error.
 */
export type RiskDecision =
  | { allow: true }
  | { allow: false; reason: RejectionCode };

/**
 * Total a subject's spending inside the sliding window that ends at `now`: sum every attempt
 * whose time `at` falls within the last `windowMs` milliseconds (`at > now - windowMs`), and
 * drop the rest. The window slides with the clock, so an attempt counts toward the limit only
 * for `windowMs` after it happens, then ages out on its own — there is no fixed reset boundary
 * where the whole total snaps back to zero at once.
 *
 * This is the in-memory twin of the SQL stores' windowed `SUM(amount) WHERE at > cutoff`, so
 * every backend enforces the same rolling limit. Attempts are deduplicated by the store (each
 * idempotency key counts once) before they reach here. `windowStart` comes back as the earliest
 * `at` still in the window (0 when the window is empty); only `spent` feeds the risk check.
 */
export function windowedVelocity(
  subject: string,
  attempts: ReadonlyArray<Attempt>,
  now: number,
  windowMs: number,
): Velocity {
  let cutoff = now - windowMs;
  let spentMinor = 0n;
  let windowStart = 0;
  let count = 0;
  for (let attempt of attempts) {
    if (attempt.at <= cutoff) {
      continue;
    }
    spentMinor += attempt.amount.minor;
    count += 1;
    if (windowStart === 0 || attempt.at < windowStart) {
      windowStart = attempt.at;
    }
  }
  return {
    subject,
    windowStart,
    spent: toAmount(VELOCITY_CURRENCY, spentMinor),
    attempts: count,
  };
}

/**
 * Decide whether to allow this operation. Deny it when the subject's spend inside the current
 * window, plus the amount this operation moves, would go over `config.velocityLimitMinor`. The
 * caller passes the `velocity` the store already windowed on read (the store applies
 * `config.velocityWindowMs` when it sums the subject's attempts), so the comparison here is
 * always against the live window. Operations that don't move a tracked subject's funds
 * (`riskSubject` returns null) are always allowed.
 */
export function assessRisk(
  velocity: Velocity,
  operation: Operation,
  config: Config,
): RiskDecision {
  if (riskSubject(operation) === null) {
    return { allow: true };
  }
  // What the running total would become if this operation went through.
  let projected = velocity.spent.minor + attemptMinor(operation);
  if (projected > config.velocityLimitMinor) {
    return { allow: false, reason: 'RISK_DENIED' };
  }
  return { allow: true };
}

/**
 * Build the attempt record to add to a subject's running total once an operation has
 * finished, or null when there's nothing to record: the operation doesn't move a
 * tracked subject's funds, or it was a duplicate that was already counted. The record
 * carries `idempotencyKey` so the store won't count a genuine retry twice. A `rejected`
 * outcome is still recorded (denied attempts count toward the limit, since a burst of
 * them is itself a fraud signal); a `duplicate` is not (the original attempt already
 * counted). The caller runs this after the operation is submitted and writes it through
 * `Store.trust.bump` outside the database transaction, so even an operation that rolled
 * back still records that it was attempted. An operation that threw an error is a bug,
 * not an attempt, and never reaches here.
 */
export function riskAttempt(
  operation: Operation,
  outcome: Outcome,
  at: number,
): Attempt | null {
  if (riskSubject(operation) === null || outcome.status === 'duplicate') {
    return null;
  }
  return {
    idempotencyKey: operation.idempotencyKey,
    amount: toAmount(VELOCITY_CURRENCY, attemptMinor(operation)),
    at,
    outcome: outcome.status === 'committed' ? 'committed' : 'rejected',
  };
}

/**
 * The id (a user or account) whose running total this operation counts against, or null
 * when the operation isn't subject to the risk check. This is the one place that rule
 * lives, so `assessRisk`, `riskAttempt`, and the middleware all pick the same subject.
 */
export function riskSubject(operation: Operation): string | null {
  if (operation.kind === 'spend') {
    return operation.buyerId;
  }
  if (
    operation.kind === 'topUp' ||
    operation.kind === 'grantPromo' ||
    operation.kind === 'requestPayout' ||
    // subscribe moves the user's credit just like a spend, so it must count against the same
    // running-total window. Without it, each subscribe could move up to the maximum allowed
    // price unchecked and repeated subscribes would never add to the total.
    operation.kind === 'subscribe'
  ) {
    return operation.userId;
  }
  return null;
}

/**
 * How much this operation adds to its subject's running total, in CREDIT minor units
 * (the smallest CREDIT unit), or 0 for an operation that moves no tracked funds.
 */
export function attemptMinor(operation: Operation): bigint {
  if (operation.kind === 'spend') {
    return operation.price.minor;
  }
  // A subscribe charges its `price`, so it adds the price's smallest-unit amount to the total,
  // just like the spend case above.
  if (operation.kind === 'subscribe') {
    return operation.price.minor;
  }
  if (
    operation.kind === 'topUp' ||
    operation.kind === 'grantPromo' ||
    operation.kind === 'requestPayout'
  ) {
    return operation.amount.minor;
  }
  return 0n;
}
