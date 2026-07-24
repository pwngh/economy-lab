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

import type { Clock, RateLimiter } from '#src/ports.ts';

interface Window {
  count: number;

  resetAt: number;
}

/**
 * Builds an in-process {@link RateLimiter} counting fixed windows in a `Map`. It exposes the same
 * observable contract as the Redis adapter and serves as a usable single-process limiter when no
 * Redis is wired.
 *
 * Each key gets `limit` requests per `windowMs`, measured against the injected `clock`; a denial
 * reports how long until the window resets. An expired window is replaced only when its key is
 * next seen, so the map retains every key it has ever counted.
 *
 * @example
 * const limiter = memoryRateLimiter({ limit: 100, windowMs: 60_000 });
 * await limiter.allow('user:usr_42'); // { allowed: true }
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   how the server keys and answers denials.
 */
export function memoryRateLimiter(
  options: { limit: number; windowMs: number },
  clock: Clock = { now: () => Date.now() },
): RateLimiter {
  const windows = new Map<string, Window>();
  return {
    allow: async (key) => {
      const now = clock.now();
      const window = windows.get(key);
      if (window === undefined || now >= window.resetAt) {
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true };
      }
      window.count += 1;
      if (window.count <= options.limit) {
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: window.resetAt - now };
    },
  };
}
