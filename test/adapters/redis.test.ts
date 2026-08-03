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
import { setTimeout as sleep } from 'node:timers/promises';

import '#test/support/dist-guard.ts';

import { redisCache, redisRateLimiter } from '@pwngh/economy-redis';
import { EconomyError } from '#src/errors.ts';
import { runCacheConformance } from '@pwngh/economy-conformance';
import { runRateLimiterConformance } from '@pwngh/economy-conformance';

import type { RateLimiter } from '#src/ports.ts';

// The limiter half of this adapter, against the live rig. A fake client cannot stand in: every
// recovery case asks a window to pass, and the expiry that reopens it is Redis's own. With no
// REDIS_URL the harness factory throws and each case skips naming the reason.
runRateLimiterConformance('economy-redis', () => {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL unset');
  }
  const opened: Array<RateLimiter & { close(): Promise<void> }> = [];
  return {
    make: async (policy) => {
      const limiter = await redisRateLimiter(url, policy);
      opened.push(limiter);
      return limiter;
    },
    // A 25ms cushion over the wait Redis reported: PTTL is truncated to whole milliseconds and the
    // round trip that reads it spends some of them.
    elapse: (ms) => sleep(ms + 25),
    close: async () => {
      for (const limiter of opened) {
        await limiter.close();
      }
    },
  };
});

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

describe('redisCache', () => {
  test('round-trips a value under the namespaced key', async () => {
    const client = fakeRedis();
    const cache = redisCache(client);

    await cache.set('balance:usr_42:spendable', 'CREDIT:12.34');
    const read = await cache.get('balance:usr_42:spendable');

    assert.equal(read, 'CREDIT:12.34');
    assert.equal(
      client.store.has('economy:cache:balance:usr_42:spendable'),
      true,
    );
  });

  test('returns null for a missing key', async () => {
    const cache = redisCache(fakeRedis());

    const read = await cache.get('balance:usr_absent:spendable');

    assert.equal(read, null);
  });

  test('forwards a TTL as the PX millisecond flag', async () => {
    const client = fakeRedis();
    const cache = redisCache(client);

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
    const cache = redisCache(client);

    await cache.set('balance:usr_7:earned', 'CREDIT:2.00');

    assert.deepEqual(client.setCalls[0], [
      'economy:cache:balance:usr_7:earned',
      'CREDIT:2.00',
    ]);
  });

  test('invalidates the namespaced key', async () => {
    const client = fakeRedis();
    const cache = redisCache(client);
    await cache.set('balance:usr_9:spendable', 'CREDIT:5.00');

    await cache.invalidate('balance:usr_9:spendable');
    const read = await cache.get('balance:usr_9:spendable');

    assert.equal(read, null);
    assert.equal(client.store.size, 0);
  });

  test('translates a driver failure into a retryable STORE.FAILURE fault', async () => {
    const cause = new Error('ECONNRESET');
    const cache = redisCache(failingRedis(cause));

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
    const cache = redisCache(failingRedis(new Error('ECONNRESET')));

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
    const cache = redisCache(failingRedis(new Error('ECONNRESET')));

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

  test('never ends a connection the caller opened', async () => {
    let quit = false;
    const client: FakeRedis = {
      ...fakeRedis(),
      quit: async () => {
        quit = true;
        return 'OK';
      },
    };

    const cache = redisCache(client);

    // Ownership follows creation. A handed-in client comes back with no close at all, so the
    // package cannot end a connection it did not open, by accident or otherwise.
    assert.equal((cache as { close?: unknown }).close, undefined);
    assert.equal(quit, false);
  });
});

runCacheConformance('redis', () => redisCache(fakeRedis()));

interface FakeCounter {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  quit(): Promise<unknown>;
  calls: ReadonlyArray<ReadonlyArray<unknown>>;
}

// The limiter counts and arms in a single script, so a fake is the reply it hands back.
function fakeCounter(reply: unknown = [1, 500]): FakeCounter {
  const calls: unknown[][] = [];
  return {
    calls,
    eval: async (script, numKeys, ...args) => {
      calls.push([script, numKeys, ...args]);
      return reply;
    },
    quit: async () => 'OK',
  };
}

describe('redisRateLimiter', () => {
  test('counts and arms the window in one round trip', async () => {
    const client = fakeCounter([1, 1_000]);
    const limiter = redisRateLimiter(client, {
      limit: 2,
      windowMs: 1_000,
    });

    assert.deepEqual(await limiter.allow('k'), { allowed: true });
    assert.deepEqual(await limiter.allow('k'), { allowed: true });

    // Two calls, two round trips, each carrying the namespaced key and the window. Arming is
    // inside the script rather than a second command, so a lost round trip cannot strand a
    // counting key with no expiry.
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[0]?.slice(1), [
      1,
      'economy:ratelimit:k',
      1_000,
    ]);
  });

  test('denies past the limit with the remaining window as retryAfterMs', async () => {
    const limiter = redisRateLimiter(fakeCounter([2, 500]), {
      limit: 1,
      windowMs: 1_000,
    });

    assert.deepEqual(await limiter.allow('k'), {
      allowed: false,
      retryAfterMs: 500,
    });
  });

  test('a TTL of -2 is a window already gone, so it does not deny', async () => {
    const limiter = redisRateLimiter(fakeCounter([2, -2]), {
      limit: 1,
      windowMs: 1_000,
    });

    // -2 is "no such key", and there is no wait that clears a window nothing is counting. -1,
    // the key that exists without an expiry, never gets here: the script arms it.
    assert.deepEqual(await limiter.allow('k'), { allowed: true });
  });

  test('a redis failure surfaces as a retryable fault', async () => {
    const limiter = redisRateLimiter(
      {
        ...fakeCounter(),
        eval: async () => Promise.reject(new Error('down')),
      },
      { limit: 1, windowMs: 1_000 },
    );

    // The limiter lives in its own package and throws from the lab's built copy, while this file
    // holds the source copy. `instanceof` is false across that boundary; the brand is not.
    await assert.rejects(limiter.allow('k'), (error: unknown) => {
      assert.equal(error instanceof EconomyError, false);
      assert.equal(EconomyError.is(error), true);
      assert.equal((error as EconomyError).code, 'STORE.FAILURE');
      assert.equal((error as EconomyError).retryable, true);
      return true;
    });
  });

  test('never ends a connection the caller opened', async () => {
    let quit = false;
    const client: FakeCounter = {
      ...fakeCounter(),
      quit: async () => {
        quit = true;
        return 'OK';
      },
    };

    const limiter = redisRateLimiter(client, { limit: 1, windowMs: 1_000 });

    assert.equal((limiter as { close?: unknown }).close, undefined);
    assert.equal(quit, false);
  });
});

// The URL form is the default path: one import, one call, no `new Redis(...)` at the call site.
// It runs only against a live Redis, since opening is the whole point of the overload.
describe('redisCache(url) and redisRateLimiter(url): the connection is opened inside', () => {
  const url = process.env.REDIS_URL;

  test('a URL-opened cache round-trips a value and closes its own connection', async (t) => {
    if (!url) {
      t.skip('REDIS_URL unset');
      return;
    }
    const cache = await redisCache(url);
    try {
      const key = `open_${crypto.randomUUID().slice(0, 8)}`;
      await cache.set(key, 'CREDIT:12.34');
      assert.equal(await cache.get(key), 'CREDIT:12.34');
      await cache.invalidate(key);
      assert.equal(await cache.get(key), null);
    } finally {
      await cache.close();
    }
  });

  test('a URL-opened limiter denies past its limit', async (t) => {
    if (!url) {
      t.skip('REDIS_URL unset');
      return;
    }
    const limiter = await redisRateLimiter(url, { limit: 1, windowMs: 60_000 });
    try {
      const key = `open_${crypto.randomUUID().slice(0, 8)}`;
      assert.equal((await limiter.allow(key)).allowed, true);
      assert.equal((await limiter.allow(key)).allowed, false);
    } finally {
      await limiter.close();
    }
  });
});
