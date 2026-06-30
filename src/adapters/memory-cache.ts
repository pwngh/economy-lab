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
 * Builds an in-process {@link Cache} backed by a `Map`. It exposes the same observable contract as
 * the Redis adapter. The Cache conformance suite runs it as its oracle, the way `memoryStore` is the
 * reference for the Store. It also serves as a usable single-process cache when no Redis is wired.
 *
 * It honors `ttlMs` against the injected `clock`. An entry past its expiry reads as a miss, the same
 * way Redis's `PX` flag expires a key, so the conformance suite can drive expiry with a fake clock.
 * Values are opaque strings, and this never parses them.
 *
 * @example
 *   let cache = memoryCache(wallClock());
 *   await cache.set('bal:usr_42:spendable', 'CREDIT:12.34', 60_000);
 *   await cache.get('bal:usr_42:spendable'); // 'CREDIT:12.34' | null
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for the cache and store port contracts.
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
