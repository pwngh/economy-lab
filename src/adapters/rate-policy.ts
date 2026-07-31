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

import { ERROR_CODES, fault } from '#src/errors.ts';

/** The fixed window a rate limiter counts: `limit` calls per `windowMs` milliseconds. */
export interface RatePolicy {
  limit: number;

  windowMs: number;
}

function refuse(field: string, value: number, remedy: string): never {
  throw fault(
    ERROR_CODES.CONFIG_INVALID,
    `rateLimiter: ${field} must be ${remedy}, got ${JSON.stringify(value)}.`,
    { retryable: false, detail: { [field]: value } },
  );
}

/**
 * Refuses a {@link RatePolicy} no limiter can honour, so a misconfigured window fails at
 * construction instead of quietly turning admission control off. Every `RateLimiter` the tree
 * ships calls this, and `runRateLimiterConformance` holds a host's own limiter to the same
 * refusals.
 *
 * The window is the refusal that matters. `PEXPIRE key 0` **deletes** the key, so a `windowMs` of
 * zero makes every call the first call on the Redis limiter, while the in-process one keeps
 * resetting a window whose reset time has already passed: both allow everything, and neither
 * reports a denial to say so. A fractional or `NaN` window is no better — Redis refuses it once per
 * call, and a limiter that throws on every call is one the edge deliberately fails open around.
 *
 * @example
 * assertRatePolicy({ limit: 100, windowMs: 60_000 }); // returns
 * assertRatePolicy({ limit: 100, windowMs: 0 }); // throws CONFIG.INVALID
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   how the server keys requests and answers a denial.
 */
export function assertRatePolicy(policy: RatePolicy): void {
  if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0) {
    refuse(
      'windowMs',
      policy.windowMs,
      'a whole number of milliseconds above zero',
    );
  }
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 0) {
    refuse('limit', policy.limit, 'a whole number of calls, zero or more');
  }
}
