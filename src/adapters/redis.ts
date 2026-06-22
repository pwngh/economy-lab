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

// The few ioredis methods this adapter actually calls. We describe the shape we need
// here, by hand, instead of importing ioredis's own types. That way this file still
// typechecks even when ioredis is not installed (it is an optional dependency). The
// second `set` overload takes 'PX' followed by a millisecond time-to-live: ioredis
// passes both straight through to the Redis SET command, which expires the key after
// that many milliseconds.
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

import type { Cache } from '#src/ports.ts';

// Prefix added to every key. It keeps these cache entries from colliding with anything
// else stored in the same Redis instance, and lets an operator find or delete just this
// cache's keys.
let KEY_PREFIX = 'economy:cache:';

function namespaced(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

// Turn any error from the Redis driver or the network into the project's standard
// STORE.FAILURE error. It is marked retryable (the cache is best-effort, so trying
// again later is fine), and the original error is kept as `cause` so the real stack
// trace is not lost.
function storeFault(operation: string, cause: unknown): never {
  throw fault(ERROR_CODES.STORE_FAILURE, `Redis cache ${operation} failed.`, {
    cause,
    retryable: true,
    detail: { operation },
  });
}

/**
 * Adapt an already-connected ioredis client into the {@link Cache} that the core code
 * expects. The core only ever caches a few hot reads (a user's balance, entitlement
 * checks) and treats every cached value as an opaque string it stored earlier, so this
 * adapter never parses values — it just does get, set, and invalidate (delete).
 *
 * You pass the client in rather than having this function create one, so that you keep
 * control of how it connects (TLS, sentinel, cluster) and when it closes, and so a test
 * can hand in a fake.
 *
 * The returned object has everything in {@link Cache} plus an extra `close()` so the
 * caller can release the connection when done.
 *
 * @example
 *   let cache = redisCacheFrom(new Redis(process.env.REDIS_URL));
 *   await cache.set('balance:usr_42:spendable', 'CREDIT:12.34', 60_000);
 *   await cache.get('balance:usr_42:spendable'); // 'CREDIT:12.34' | null
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

// ioredis is an optional peer: a caller that wants the default client builds it with
// `new Redis(url)` and passes it to redisCacheFrom. This module never imports ioredis, so
// loading it on its own opens no connection and does not require the package installed.
