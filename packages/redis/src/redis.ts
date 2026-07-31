/**
 * @pwngh/economy-redis
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { ERROR_CODES, fault } from '@pwngh/economy-lab';
import { assertRatePolicy } from '@pwngh/economy-lab/adapters';

import type { RatePolicy } from '@pwngh/economy-lab/adapters';
import type { Cache, RateLimiter } from '@pwngh/economy-lab/ports';

// Hand-written shape of the ioredis methods we use, so a test fake satisfies it too. It names no
// way to end the connection: a client you opened stays yours, and this shape makes that
// unbreakable.
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// A client this package opened, and therefore ends. Only the URL forms produce one.
type OwnedClient<T> = T & { quit(): Promise<unknown> };

// Opens an ioredis client. The module name lives in a variable so the type-checker does not
// resolve the driver at build time, and a bundler leaves it a runtime import.
async function openRedis<T>(url: string): Promise<T> {
  const specifier = 'ioredis';
  let module: { default: new (connection: string) => T };
  try {
    module = (await import(/* @vite-ignore */ specifier)) as unknown as {
      default: new (connection: string) => T;
    };
  } catch (cause) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Could not load the "ioredis" driver. It ships as a dependency of this package, so check the install and any bundler externals.',
      { cause, retryable: false },
    );
  }
  return new module.default(url);
}

const KEY_PREFIX = 'economy:cache:';

function namespaced(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

function storeFault(operation: string, cause: unknown): never {
  throw fault(ERROR_CODES.STORE_FAILURE, `Redis cache ${operation} failed.`, {
    cause,
    retryable: true,
    detail: { operation },
  });
}

/**
 * Builds the {@link Cache} the core expects, opening its own Redis connection from `url`. Values
 * are opaque strings. This adapter never parses them. The returned `close()` releases the
 * connection, and closing the economy calls it.
 *
 * Pass an already-connected ioredis client instead when the caller owns the wire (TLS, sentinel,
 * cluster), which also lets a test substitute a fake. That form is sync rather than a promise, and
 * carries no `close`: a connection you opened is yours to end, so nothing here can end it for you.
 *
 * `ttlMs` maps to Redis's `PX` flag, so Redis itself enforces expiry. A `set` with no TTL
 * persists until invalidated. Keys live under the `economy:cache:` prefix, so they never collide
 * with other data in the instance and an operator can find or delete them as a set. A failed call
 * throws a retryable `STORE.FAILURE`. The cache is best-effort, so callers fall back to the store.
 *
 * @example
 * const cache = await redisCache('redis://localhost:6379');
 * await cache.set('bal:usr_42:spendable', 'CREDIT:12.34', 60_000);
 * await cache.get('bal:usr_42:spendable'); // 'CREDIT:12.34' | null past the TTL
 * await cache.close();
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for how the cache port backs hot reads.
 */
export function redisCache(
  url: string,
): Promise<Cache & { close(): Promise<void> }>;
export function redisCache(client: RedisClient): Cache;
export function redisCache(
  source: string | RedisClient,
): Cache | Promise<Cache & { close(): Promise<void> }> {
  if (typeof source === 'string') {
    return openRedis<OwnedClient<RedisClient>>(source).then((client) => ({
      ...cacheOver(client),
      close: async () => {
        await client.quit();
      },
    }));
  }
  return cacheOver(source);
}

function cacheOver(client: RedisClient): Cache {
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
  };
}

// The one method the limiter uses, kept separate from RedisClient so cache fakes and callers
// don't grow a method they never touch. Counting and arming have to reach Redis together, so
// this is `eval` rather than the INCR/PEXPIRE/PTTL the window is made of.
export interface RedisCounterClient {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

const LIMIT_PREFIX = 'economy:ratelimit:';

// Counts one call against the window and returns `{count, ttl}` with the expiry guaranteed set.
// Redis runs a script to completion with nothing interleaved, so the increment and the expiry
// cannot come apart: no dropped connection, failover or kill can leave a counting key with no
// way to expire. PTTL is -1 for a key that exists without an expiry, which is the state a lost
// PEXPIRE leaves; arming there is what stops the counter climbing past the limit forever.
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

function limitFault(cause: unknown): never {
  throw fault(ERROR_CODES.STORE_FAILURE, 'Redis rate limit failed.', {
    cause,
    retryable: true,
    detail: { operation: 'allow' },
  });
}

async function bumpWindow(
  client: RedisCounterClient,
  stored: string,
  windowMs: number,
): Promise<{ count: number; ttl: number }> {
  let reply: unknown;
  try {
    reply = await client.eval(WINDOW_SCRIPT, 1, stored, windowMs);
  } catch (error) {
    limitFault(error);
  }
  const [count, ttl] = Array.isArray(reply) ? (reply as unknown[]) : [];
  if (typeof count !== 'number' || typeof ttl !== 'number') {
    limitFault(
      new Error(`Expected a count and a TTL, got ${JSON.stringify(reply)}`),
    );
  }
  return { count, ttl };
}

/**
 * Builds a fixed-window {@link RateLimiter}, opening its own Redis connection from `url`. Each
 * call is one `EVAL`: a script increments the windowed key and arms its expiry in the same round
 * trip, so nothing that can happen between two round trips leaves a key counting with no way to
 * expire. Pass an already-connected client instead when the caller owns the wire, same as
 * {@link redisCache} — that form carries no `close`, because the connection is not this package's
 * to end. The URL form's `close()` releases the connection it opened.
 *
 * Each key gets `limit` calls per `windowMs`. Because the counter lives in Redis, the limit holds
 * across every process sharing the instance. A denial's `retryAfterMs` is the key's own remaining
 * expiry, so sitting out the reported wait always clears it. Keys live under the
 * `economy:ratelimit:` prefix. A failed call throws a retryable `STORE.FAILURE`, and the lab's
 * edge fails open on it — the call is admitted and `economy.ratelimit.degraded` counts it, so an
 * unreachable Redis costs protection rather than availability. A policy Redis cannot honour is
 * refused here, before a connection is opened: `PEXPIRE key 0` deletes the key, so a zero window
 * would allow every call.
 *
 * @example
 * const limiter = await redisRateLimiter('redis://localhost:6379', {
 *   limit: 100,
 *   windowMs: 60_000,
 * });
 * await limiter.allow('usr_42'); // { allowed: true }
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/http-service/ HTTP service} for
 *   how the server keys and answers denials.
 */
export function redisRateLimiter(
  url: string,
  options: RatePolicy,
): Promise<RateLimiter & { close(): Promise<void> }>;
export function redisRateLimiter(
  client: RedisCounterClient,
  options: RatePolicy,
): RateLimiter;
export function redisRateLimiter(
  source: string | RedisCounterClient,
  options: RatePolicy,
): RateLimiter | Promise<RateLimiter & { close(): Promise<void> }> {
  // Both forms refuse synchronously, so the URL form never opens a connection it cannot use.
  assertRatePolicy(options);
  if (typeof source === 'string') {
    return openRedis<OwnedClient<RedisCounterClient>>(source).then(
      (client) => ({
        ...limiterOver(client, options),
        close: async () => {
          await client.quit();
        },
      }),
    );
  }
  return limiterOver(source, options);
}

function limiterOver(
  client: RedisCounterClient,
  options: RatePolicy,
): RateLimiter {
  return {
    allow: async (key) => {
      const { count, ttl } = await bumpWindow(
        client,
        `${LIMIT_PREFIX}${key}`,
        options.windowMs,
      );
      if (count <= options.limit) {
        return { allowed: true };
      }
      // A TTL of -2 is a key that is no longer there, so the count came from a window that has
      // already gone: there is nothing left to wait out and nothing to deny against. -1 never
      // reaches here, because the script arms it.
      if (ttl < 0) {
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: ttl };
    },
  };
}
