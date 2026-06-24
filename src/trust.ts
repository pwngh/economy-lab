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

// Limit and every running total are in CREDIT minor units, so total and limit compare
// in the same currency.
export let VELOCITY_CURRENCY = 'CREDIT' as const;

/**
 * Risk check result: allow, or deny with a reason. On deny, `screenRisk` middleware turns
 * this into `rejected(reason, …)` for the caller; the reason is never raised as an error.
 */
export type RiskDecision =
  | { allow: true }
  | { allow: false; reason: RejectionCode };

/**
 * Sum a subject's spending in the sliding window ending at `now`: every attempt with
 * `at > now - windowMs`, dropping the rest. The window slides with the clock, so an attempt
 * counts for `windowMs` after it happens then ages out; there is no fixed reset boundary.
 *
 * In-memory twin of the SQL stores' windowed `SUM(amount) WHERE at > cutoff`, so every backend
 * enforces the same rolling limit. The store deduplicates attempts (each idempotency key counts
 * once) before they reach here. `windowStart` is the earliest `at` still in the window (0 when
 * empty); only `spent` feeds the risk check.
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
 * Allow unless the subject's windowed spend plus this operation's amount exceeds
 * `config.velocityLimitMinor`. The caller passes the `velocity` the store windowed on read
 * (applying `config.velocityWindowMs`), so the comparison is against the live window. Operations
 * that don't move a tracked subject's funds (`riskSubject` returns null) are always allowed.
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
 * Build the attempt record to add to a subject's running total after an operation finishes, or
 * null when there's nothing to record (untracked subject, or a duplicate already counted). The
 * record carries `idempotencyKey` so the store won't count a genuine retry twice. This is the pure
 * reference implementation of the attempt-record rule, exercised by the tests and the in-memory
 * trust adapter. The live pipeline does not call this; it records equivalently via
 * `store.trust.record` inside the transaction (see economy.ts screenRisk). A `rejected` outcome is
 * still recorded (denied attempts count toward the limit; a burst is itself a fraud signal); a
 * `duplicate` is not (the original already counted).
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
 * The id (user or account) whose running total this operation counts against, or null when the
 * operation isn't subject to the risk check. Single source of this subject rule, so the shared
 * logic is identical wherever it is applied: the live middleware (economy.ts screenRisk) calls
 * `riskSubject` + `attemptMinor` directly, while `assessRisk` and `riskAttempt` are the test-facing
 * pure twins. The guarantee is shared logic, not a shared call path.
 */
export function riskSubject(operation: Operation): string | null {
  if (operation.kind === 'spend') {
    return operation.buyerId;
  }
  if (
    operation.kind === 'topUp' ||
    operation.kind === 'grantPromo' ||
    operation.kind === 'requestPayout' ||
    // subscribe moves the user's credit like a spend, so it must count against the same window.
    // Without it, each subscribe could move up to the max price unchecked and repeated subscribes
    // would never add to the total.
    operation.kind === 'subscribe'
  ) {
    return operation.userId;
  }
  return null;
}

/**
 * How much this operation adds to its subject's running total, in CREDIT minor units, or 0
 * for an operation that moves no tracked funds.
 */
export function attemptMinor(operation: Operation): bigint {
  if (operation.kind === 'spend') {
    return operation.price.minor;
  }
  // subscribe charges its `price`, same as the spend case above.
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
