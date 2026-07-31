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

import { assertRatePolicy } from '#src/adapters/rate-policy.ts';

import type { RatePolicy } from '#src/adapters/rate-policy.ts';
import type { Clock, RateLimiter } from '#src/ports.ts';

interface Window {
  count: number;

  resetAt: number;
}

/**
 * Builds an in-process {@link RateLimiter} counting fixed windows in a `Map`, for a
 * single-process host with no Redis wired. It exposes the same observable contract as the Redis
 * adapter, and `runRateLimiterConformance` is what holds the two to it.
 *
 * Each key gets `limit` calls per `windowMs`, measured against the injected `clock`. A denial
 * reports how long until the window resets. An expired window is replaced only when its key is
 * next seen, so the map retains every key it has ever counted. A policy no limiter can honour is
 * refused here rather than at the first call — see {@link assertRatePolicy}.
 *
 * @example
 * const limiter = memoryRateLimiter({ limit: 100, windowMs: 60_000 });
 * await limiter.allow('user:usr_42'); // { allowed: true }
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   how the server keys and answers denials.
 */
export function memoryRateLimiter(
  options: RatePolicy,
  clock: Clock = { now: () => Date.now() },
): RateLimiter {
  assertRatePolicy(options);
  const windows = new Map<string, Window>();
  return {
    allow: async (key) => {
      const now = clock.now();
      const held = windows.get(key);
      // Every call goes through one comparison against the limit, the first in a window included:
      // a fresh-window branch that returned `allowed` on its own ignored `limit` entirely, so
      // `limit: 0` let one call per window through while the Redis limiter denied it.
      const window =
        held !== undefined && now < held.resetAt
          ? held
          : { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
      window.count += 1;
      if (window.count <= options.limit) {
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: window.resetAt - now };
    },
  };
}
