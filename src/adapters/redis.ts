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

import type { Cache, RateLimiter } from '#src/ports.ts';

// Hand-written shape of the ioredis methods we use, so the file typechecks without ioredis (an
// optional dependency) installed. This module never imports ioredis, so loading it opens nothing.
interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

// Namespaces this cache's keys: no collisions with other data in the instance, and an operator
// can find or delete them as a set.
const KEY_PREFIX = 'economy:cache:';

function namespaced(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

// Marked retryable because the cache is best-effort.
function storeFault(operation: string, cause: unknown): never {
  throw fault(ERROR_CODES.STORE_FAILURE, `Redis cache ${operation} failed.`, {
    cause,
    retryable: true,
    detail: { operation },
  });
}

/**
 * Adapts an already-connected ioredis client into the {@link Cache} the core expects. Values are
 * opaque strings; this adapter never parses them. The caller creates and owns the client (TLS,
 * sentinel, cluster), which also lets a test substitute a fake; the returned `close()` releases
 * the connection.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for how the cache port backs hot reads.
 */
export function redisCache(
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

// The counter methods the limiter uses, kept separate from RedisClient so cache fakes and
// callers don't grow methods they never touch.
interface RedisCounterClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

const LIMIT_PREFIX = 'economy:ratelimit:';

/**
 * Adapts an already-connected ioredis client into a fixed-window {@link RateLimiter}: `INCR` on
 * the windowed key, `PEXPIRE` arms the window on its first hit, and a denial reports the key's
 * remaining `PTTL`. The caller creates and owns the client, same as {@link redisCache}; the
 * returned `close()` releases the connection.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   how the server keys and answers denials.
 */
export function redisRateLimiter(
  client: RedisCounterClient,
  options: { limit: number; windowMs: number },
): RateLimiter & { close(): Promise<void> } {
  return {
    allow: async (key) => {
      try {
        const windowed = `${LIMIT_PREFIX}${key}`;
        const count = await client.incr(windowed);
        if (count === 1) {
          await client.pexpire(windowed, options.windowMs);
        }
        if (count <= options.limit) {
          return { allowed: true };
        }
        const remaining = await client.pttl(windowed);
        return {
          allowed: false,
          retryAfterMs: remaining > 0 ? remaining : options.windowMs,
        };
      } catch (error) {
        throw fault(ERROR_CODES.STORE_FAILURE, 'Redis rate limit failed.', {
          cause: error,
          retryable: true,
          detail: { operation: 'allow' },
        });
      }
    },

    close: async () => {
      await client.quit();
    },
  };
}
