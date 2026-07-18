/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { redisCacheFrom, redisRateLimiterFrom } from '#src/adapters/redis.ts';
import { EconomyError } from '#src/errors.ts';
import { runCacheConformance } from '#test/conformance/cache.ts';

interface FakeRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
  store: Map<string, string>;
  setCalls: ReadonlyArray<ReadonlyArray<unknown>>;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const setCalls: unknown[][] = [];
  const fake: FakeRedis = {
    store,
    setCalls,
    get: async (key) => store.get(key) ?? null,
    set: async (...args: unknown[]) => {
      setCalls.push(args);
      store.set(args[0] as string, args[1] as string);
      return 'OK';
    },
    del: async (key) => (store.delete(key) ? 1 : 0),
    quit: async () => 'OK',
  };
  return fake;
}

function failingRedis(cause: Error): FakeRedis {
  const base = fakeRedis();
  return {
    ...base,
    get: async () => Promise.reject(cause),
    set: async () => Promise.reject(cause),
    del: async () => Promise.reject(cause),
  };
}

describe('redisCacheFrom', () => {
  test('round-trips a value under the namespaced key', async () => {
    const client = fakeRedis();
    const cache = redisCacheFrom(client);

    await cache.set('balance:usr_42:spendable', 'CREDIT:12.34');
    const read = await cache.get('balance:usr_42:spendable');

    assert.equal(read, 'CREDIT:12.34');
    assert.equal(
      client.store.has('economy:cache:balance:usr_42:spendable'),
      true,
    );
  });

  test('returns null for a missing key', async () => {
    const cache = redisCacheFrom(fakeRedis());

    const read = await cache.get('balance:usr_absent:spendable');

    assert.equal(read, null);
  });

  test('forwards a TTL as the PX millisecond flag', async () => {
    const client = fakeRedis();
    const cache = redisCacheFrom(client);

    await cache.set('balance:usr_7:spendable', 'CREDIT:1.00', 60_000);

    assert.deepEqual(client.setCalls[0], [
      'economy:cache:balance:usr_7:spendable',
      'CREDIT:1.00',
      'PX',
      60_000,
    ]);
  });

  test('omits the TTL flag when no ttl is given', async () => {
    const client = fakeRedis();
    const cache = redisCacheFrom(client);

    await cache.set('balance:usr_7:earned', 'CREDIT:2.00');

    assert.deepEqual(client.setCalls[0], [
      'economy:cache:balance:usr_7:earned',
      'CREDIT:2.00',
    ]);
  });

  test('invalidates the namespaced key', async () => {
    const client = fakeRedis();
    const cache = redisCacheFrom(client);
    await cache.set('balance:usr_9:spendable', 'CREDIT:5.00');

    await cache.invalidate('balance:usr_9:spendable');
    const read = await cache.get('balance:usr_9:spendable');

    assert.equal(read, null);
    assert.equal(client.store.size, 0);
  });

  test('translates a driver failure into a retryable STORE.FAILURE fault', async () => {
    const cause = new Error('ECONNRESET');
    const cache = redisCacheFrom(failingRedis(cause));

    await assert.rejects(
      cache.get('balance:usr_1:spendable'),
      (error: unknown) => {
        const fault = error as {
          code?: string;
          retryable?: boolean;
          cause?: unknown;
        };
        assert.equal(fault.code, 'STORE.FAILURE');
        assert.equal(fault.retryable, true);
        assert.equal(fault.cause, cause);
        return true;
      },
    );
  });

  test('translates a set failure into a retryable STORE.FAILURE fault', async () => {
    const cache = redisCacheFrom(failingRedis(new Error('ECONNRESET')));

    await assert.rejects(
      cache.set('balance:usr_1:spendable', 'CREDIT:1.00'),
      (error: unknown) => {
        const fault = error as { code?: string; retryable?: boolean };
        assert.equal(fault.code, 'STORE.FAILURE');
        assert.equal(fault.retryable, true);
        return true;
      },
    );
  });

  test('translates an invalidate failure into a retryable STORE.FAILURE fault', async () => {
    const cache = redisCacheFrom(failingRedis(new Error('ECONNRESET')));

    await assert.rejects(
      cache.invalidate('balance:usr_1:spendable'),
      (error: unknown) => {
        const fault = error as { code?: string; retryable?: boolean };
        assert.equal(fault.code, 'STORE.FAILURE');
        assert.equal(fault.retryable, true);
        return true;
      },
    );
  });

  test('closes by quitting the underlying client', async () => {
    const client = fakeRedis();
    let quit = false;
    const cache = redisCacheFrom({
      ...client,
      quit: async () => {
        quit = true;
        return 'OK';
      },
    });

    await cache.close();

    assert.equal(quit, true);
  });
});

runCacheConformance('redis', () => redisCacheFrom(fakeRedis()));

interface FakeCounter {
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  quit(): Promise<unknown>;
  counts: Map<string, number>;
  expiries: ReadonlyArray<ReadonlyArray<unknown>>;
}

function fakeCounter(remainingTtl = 500): FakeCounter {
  const counts = new Map<string, number>();
  const expiries: unknown[][] = [];
  return {
    counts,
    expiries,
    incr: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    pexpire: async (key, ttlMs) => {
      expiries.push([key, ttlMs]);
      return 1;
    },
    pttl: async () => remainingTtl,
    quit: async () => 'OK',
  };
}

describe('redisRateLimiterFrom', () => {
  test('allows under the limit and arms the window on the first hit', async () => {
    const client = fakeCounter();
    const limiter = redisRateLimiterFrom(client, {
      limit: 2,
      windowMs: 1_000,
    });

    assert.deepEqual(await limiter.allow('k'), { allowed: true });
    assert.deepEqual(await limiter.allow('k'), { allowed: true });

    // PEXPIRE ran once, on the count that created the key, under the namespaced form.
    assert.deepEqual(client.expiries, [['economy:ratelimit:k', 1_000]]);
  });

  test('denies past the limit with the remaining window as retryAfterMs', async () => {
    const limiter = redisRateLimiterFrom(fakeCounter(500), {
      limit: 1,
      windowMs: 1_000,
    });

    await limiter.allow('k');

    assert.deepEqual(await limiter.allow('k'), {
      allowed: false,
      retryAfterMs: 500,
    });
  });

  test('a non-positive PTTL falls back to the full window', async () => {
    const limiter = redisRateLimiterFrom(fakeCounter(-1), {
      limit: 1,
      windowMs: 1_000,
    });

    await limiter.allow('k');

    assert.deepEqual(await limiter.allow('k'), {
      allowed: false,
      retryAfterMs: 1_000,
    });
  });

  test('a redis failure surfaces as a retryable fault', async () => {
    const limiter = redisRateLimiterFrom(
      {
        ...fakeCounter(),
        incr: async () => Promise.reject(new Error('down')),
      },
      { limit: 1, windowMs: 1_000 },
    );

    await assert.rejects(limiter.allow('k'), (error: unknown) => {
      assert.equal(error instanceof EconomyError, true);
      assert.equal((error as EconomyError).retryable, true);
      return true;
    });
  });

  test('closes by quitting the underlying client', async () => {
    let quit = false;
    const limiter = redisRateLimiterFrom(
      {
        ...fakeCounter(),
        quit: async () => {
          quit = true;
          return 'OK';
        },
      },
      { limit: 1, windowMs: 1_000 },
    );

    await limiter.close();

    assert.equal(quit, true);
  });
});
