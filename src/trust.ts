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

// The limit and every running total are in CREDIT minor units. Holding both in one currency
// lets the check compare them directly.
export const VELOCITY_CURRENCY = 'CREDIT' as const;

/**
 * Reports the risk check's verdict: either allow, or deny with a reason. On a deny, `screenRisk`
 * in economy.ts's submit pipeline turns this into `rejected(reason, ...)` for the caller. The
 * reason is never raised as an error.
 */
export type RiskDecision =
  | { allow: true }
  | { allow: false; reason: RejectionCode };

/**
 * Sums a subject's spending in the sliding window ending at `now` (`at > now - windowMs`);
 * attempts age out as the window slides, with no fixed reset boundary.
 *
 * This is the in-memory twin of the SQL stores' windowed `SUM(amount) WHERE at > cutoff`, so
 * every backend enforces the same rolling limit. The store deduplicates attempts before they
 * reach here, so each idempotency key counts once. `windowStart` is the earliest `at` still in
 * the window, or 0 when the window is empty. Only `spent` feeds the risk check.
 */
export function windowedVelocity(
  subject: string,
  attempts: ReadonlyArray<Attempt>,
  now: number,
  windowMs: number,
): Velocity {
  const cutoff = now - windowMs;
  let spentMinor = 0n;
  let windowStart = 0;
  let count = 0;
  for (const attempt of attempts) {
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
 * Allows the operation unless the subject's windowed spend plus this operation's amount exceeds
 * `config.velocityLimitMinor`. The caller passes the `velocity` that the store windowed on read,
 * applying `config.velocityWindowMs`, so the comparison runs against the live window. An operation
 * that moves no tracked subject's funds is always allowed, which is the case when `riskSubject`
 * returns null.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/spend-velocity/ Spend velocity}
 *   for the rolling window, why denied attempts still count, and how the record survives a
 *   rollback.
 */
export function assessRisk(
  velocity: Velocity,
  operation: Operation,
  config: Config,
): RiskDecision {
  if (riskSubject(operation) === null) {
    return { allow: true };
  }
  const projected = velocity.spent.minor + attemptMinor(operation);
  if (projected > config.velocityLimitMinor) {
    return { allow: false, reason: 'RISK_DENIED' };
  }
  return { allow: true };
}

/**
 * Builds the attempt record to add to a subject's running total after an operation finishes.
 * Returns null for an untracked subject or a duplicate already counted. The record carries
 * `idempotencyKey` so the store will not count a genuine retry twice. This is the pure reference
 * twin; the live pipeline records the equivalent through `store.trust.record` (see economy.ts
 * screenRisk), not this.
 *
 * A `rejected` outcome is still recorded, because denied attempts count toward the limit and a
 * burst is itself a fraud signal. A `duplicate` is not recorded, because the original already
 * counted.
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
 * Returns the id (user or account) whose running total this operation counts against, or null
 * when the operation is not subject to the risk check. This is the single source of the subject
 * rule, so the logic is identical wherever it is applied. The live pipeline check (economy.ts
 * screenRisk) calls `riskSubject` and `attemptMinor` directly, while `assessRisk` and
 * `riskAttempt` are the test-facing pure twins. The guarantee is shared logic, not a shared
 * call path.
 */
export function riskSubject(operation: Operation): string | null {
  if (operation.kind === 'spend') {
    return operation.buyerId;
  }
  if (
    operation.kind === 'topUp' ||
    operation.kind === 'grantPromo' ||
    operation.kind === 'requestPayout' ||
    // subscribe moves the user's credit like a spend, so it counts against the same window.
    operation.kind === 'subscribe'
  ) {
    return operation.userId;
  }
  return null;
}

/**
 * Returns how much this operation adds to its subject's running total, in CREDIT minor units.
 * Returns 0 for an operation that moves no tracked funds.
 */
export function attemptMinor(operation: Operation): bigint {
  if (operation.kind === 'spend') {
    return operation.price.minor;
  }
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
