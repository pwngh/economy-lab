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

// Hand-written shape of the ioredis methods we use. This lets the file typecheck even when
// ioredis, an optional dependency, is not installed. The second `set` overload takes 'PX'
// and a millisecond TTL, which ioredis forwards to the Redis SET command to expire the key.
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

import type { Cache } from '#src/ports.ts';

// Prefixes every key. The prefix avoids collisions with other data in the same Redis
// instance and lets an operator find or delete only this cache's keys.
let KEY_PREFIX = 'economy:cache:';

function namespaced(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

// Wraps any driver or network error as STORE.FAILURE and throws it. The fault is marked
// retryable because the cache is best-effort. The original error is kept as `cause`.
function storeFault(operation: string, cause: unknown): never {
  throw fault(ERROR_CODES.STORE_FAILURE, `Redis cache ${operation} failed.`, {
    cause,
    retryable: true,
    detail: { operation },
  });
}

/**
 * Adapts an already-connected ioredis client into the {@link Cache} the core expects. The
 * core caches a few hot reads, such as balance and entitlement checks, as opaque strings.
 * This adapter therefore never parses values. It only gets, sets, and invalidates (deletes).
 *
 * The caller passes the client in rather than letting this function create one. That keeps
 * the caller in control of the connection (TLS, sentinel, cluster) and its close, and it
 * lets a test substitute a fake.
 *
 * Returns the {@link Cache} plus a `close()` that releases the connection.
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

// ioredis is an optional peer dependency. Callers build `new Redis(url)` and pass it to
// redisCacheFrom. This module never imports ioredis, so loading it opens no connection and
// does not require the package to be installed.
