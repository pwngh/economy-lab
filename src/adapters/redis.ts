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

// Hand-written shape of the ioredis methods we use, so this file typechecks even when
// ioredis (an optional dependency) is not installed. The second `set` overload takes
// 'PX' + a millisecond TTL, which ioredis forwards to Redis SET to expire the key.
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

import type { Cache } from '#src/ports.ts';

// Prefix on every key: avoids collisions with other data in the same Redis instance and
// lets an operator find or delete just this cache's keys.
let KEY_PREFIX = 'economy:cache:';

function namespaced(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

// Wrap any driver/network error as STORE.FAILURE. Marked retryable (cache is best-effort);
// the original error is kept as `cause`.
function storeFault(operation: string, cause: unknown): never {
  throw fault(ERROR_CODES.STORE_FAILURE, `Redis cache ${operation} failed.`, {
    cause,
    retryable: true,
    detail: { operation },
  });
}

/**
 * Adapt an already-connected ioredis client into the {@link Cache} the core expects. The
 * core caches a few hot reads (balance, entitlement checks) as opaque strings, so this
 * adapter never parses values: just get, set, invalidate (delete).
 *
 * The caller passes the client in (rather than this creating one) to keep control of
 * connection (TLS, sentinel, cluster) and close, and to allow a test fake.
 *
 * Returns {@link Cache} plus a `close()` to release the connection.
 *
 * @example
 *   let cache = redisCacheFrom(new Redis(process.env.REDIS_URL));
 *   await cache.set('balance:usr_42:spendable', 'CREDIT:12.34', 60_000);
 *   await cache.get('balance:usr_42:spendable'); // 'CREDIT:12.34' | null
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage-and-messaging/ Storage & messaging} for how the cache port backs hot reads.
 */
export function redisCacheFrom(
  client: RedisClient,
): Cache & { close(): Promise<void> } {
  return {
    get: async (key) => {
      try {
        return await client.get(namespaced(key));
      } catch (error) {
        storeFault('get', error);
      }
    },

    set: async (key, value, ttlMs) => {
      try {
        await (ttlMs === undefined
          ? client.set(namespaced(key), value)
          : client.set(namespaced(key), value, 'PX', ttlMs));
      } catch (error) {
        storeFault('set', error);
      }
    },

    invalidate: async (key) => {
      try {
        await client.del(namespaced(key));
      } catch (error) {
        storeFault('invalidate', error);
      }
    },

    close: async () => {
      await client.quit();
    },
  };
}

// ioredis is an optional peer: callers build `new Redis(url)` and pass it to
// redisCacheFrom. This module never imports ioredis, so loading it opens no connection and
// does not require the package installed.
