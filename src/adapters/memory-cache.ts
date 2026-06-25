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

import type { Cache, Clock } from '#src/ports.ts';

interface Entry {
  value: string;
  // Epoch ms after which the entry is gone, or null when it never expires.
  expiresAt: number | null;
}

/**
 * In-process {@link Cache}: a `Map`, with the same observable contract as the Redis adapter. The
 * zero-infra reference the Cache conformance suite runs as its oracle (the way `memoryStore` is the
 * reference for the Store), and a usable single-process cache when no Redis is wired.
 *
 * Honors `ttlMs` against the injected `clock` — an entry past its expiry reads as a miss, the same
 * way Redis's `PX` flag expires a key — so the conformance can drive expiry with a fake clock.
 * Values are opaque strings; this never parses them.
 *
 * @example
 *   let cache = memoryCache(wallClock());
 *   await cache.set('bal:usr_42:spendable', 'CREDIT:12.34', 60_000);
 *   await cache.get('bal:usr_42:spendable'); // 'CREDIT:12.34' | null
 */
export function memoryCache(clock: Clock = { now: () => Date.now() }): Cache {
  let store = new Map<string, Entry>();
  return {
    get: async (key) => {
      let entry = store.get(key);
      if (entry === undefined) {
        return null;
      }
      if (entry.expiresAt !== null && clock.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    set: async (key, value, ttlMs) => {
      store.set(key, {
        value,
        expiresAt: ttlMs === undefined ? null : clock.now() + ttlMs,
      });
    },

    invalidate: async (key) => {
      store.delete(key);
    },
  };
}
