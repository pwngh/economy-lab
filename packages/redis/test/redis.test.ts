/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  runCacheConformance,
  runRateLimiterConformance,
} from '@pwngh/economy-conformance';
import { Redis } from 'ioredis';

import { redisCache, redisRateLimiter } from '../src/index.js';

import type { RateLimiter } from '@pwngh/economy-lab/ports';
import type { RedisClient, RedisCounterClient } from '../src/index.js';

const url = process.env.REDIS_URL ?? '';

// The whole Cache contract, against a fake, so it runs with no Redis on the machine.
function fakeRedis(): RedisClient {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (...args: unknown[]) => {
      store.set(args[0] as string, args[1] as string);
      return 'OK';
    },
    del: async (key) => (store.delete(key) ? 1 : 0),
  } as RedisClient;
}

runCacheConformance('economy-redis', () => redisCache(fakeRedis()));

// The whole RateLimiter contract, against the live rig: a fake client has no key expiry, and the
// expiry is what reopens a window. With no REDIS_URL every case skips naming the reason.
runRateLimiterConformance('economy-redis', () => {
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
    // A cushion over the reported wait: PTTL is whole milliseconds and the round trip spends some.
    elapse: (ms) => sleep(ms + 25),
    close: async () => {
      for (const limiter of opened) {
        await limiter.close();
      }
    },
  };
});

// One `eval` per call, so the whole limiter contract with a fake is the reply it hands back.
function fakeCounter(reply: unknown): {
  eval: RedisCounterClient['eval'];
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    calls,
    eval: async (script, numKeys, ...args) => {
      calls.push([script, numKeys, ...args]);
      return reply;
    },
  };
}

// Ownership follows creation, and the types carry it: what the caller opened comes back with no
// way for this package to end it.
describe('a caller-supplied client stays the caller’s', () => {
  test('the cache built over one carries no close', () => {
    let quit = 0;
    const client = {
      ...fakeRedis(),
      quit: async () => {
        quit += 1;
        return 'OK';
      },
    };

    const cache = redisCache(client);

    assert.equal((cache as { close?: unknown }).close, undefined);
    assert.equal(quit, 0);
  });

  test('the limiter built over one carries no close', () => {
    let quit = 0;
    const client = {
      ...fakeCounter([1, 1_000]),
      quit: async () => {
        quit += 1;
        return 'OK';
      },
    };

    const limiter = redisRateLimiter(client, { limit: 5, windowMs: 1_000 });

    assert.equal((limiter as { close?: unknown }).close, undefined);
    assert.equal(quit, 0);
  });
});

// The URL form is the default path: one import, one call, no `new Redis(...)` at the call site.
describe('the connection is opened inside', () => {
  test('a URL-opened cache round-trips a value against a live Redis', async (t) => {
    if (!url) {
      t.skip('REDIS_URL unset');
      return;
    }
    const cache = await redisCache(url);
    try {
      const key = `pkg_${crypto.randomUUID().slice(0, 8)}`;
      await cache.set(key, 'CREDIT:480.00');
      assert.equal(await cache.get(key), 'CREDIT:480.00');
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
      const key = `pkg_${crypto.randomUUID().slice(0, 8)}`;
      assert.equal((await limiter.allow(key)).allowed, true);
      const denied = await limiter.allow(key);
      assert.equal(denied.allowed, false);
      assert.ok((denied.retryAfterMs ?? 0) > 0);
    } finally {
      await limiter.close();
    }
  });
});

const LIMIT = 3;
const WINDOW_MS = 60_000;
const NAMESPACE = 'economy:ratelimit:';

// Each row leaves the key in one TTL state, then takes a single `allow`. Redis reports -1 for a
// key that exists with no expiry and -2 for a key that is not there, and the two must not answer
// alike: a key left at -1 counts forever, so the window has to be re-armed rather than reported.
const TTL_STATES: ReadonlyArray<{
  label: string;
  setUp: (raw: Redis, key: string) => Promise<unknown>;
  verdict: string;
  armed: boolean;
}> = [
  {
    label: 'no key at all, so PTTL is -2',
    setUp: async () => undefined,
    verdict: 'allowed',
    armed: true,
  },
  {
    label: 'armed and under the limit',
    setUp: (raw, key) => raw.set(key, '1', 'PX', WINDOW_MS),
    verdict: 'allowed',
    armed: true,
  },
  {
    label: 'armed, and this is the call that reaches the limit',
    setUp: (raw, key) => raw.set(key, String(LIMIT - 1), 'PX', WINDOW_MS),
    verdict: 'allowed',
    armed: true,
  },
  {
    label: 'armed and past the limit',
    setUp: (raw, key) => raw.set(key, '9', 'PX', WINDOW_MS),
    verdict: 'denied for a wait inside the window',
    armed: true,
  },
  {
    label:
      'a lost expiry under the limit: the increment landed, PEXPIRE never went',
    setUp: (raw, key) => raw.incr(key),
    verdict: 'allowed',
    armed: true,
  },
  {
    label: 'a lost expiry past the limit',
    setUp: (raw, key) => raw.set(key, '9'),
    verdict: 'denied for a wait inside the window',
    armed: true,
  },
  {
    label: 'an operator PERSIST past the limit',
    setUp: async (raw, key) => {
      await raw.set(key, '9', 'PX', WINDOW_MS);
      await raw.persist(key);
    },
    verdict: 'denied for a wait inside the window',
    armed: true,
  },
];

function readVerdict(verdict: {
  allowed: boolean;
  retryAfterMs?: number;
}): string {
  if (verdict.allowed) {
    return 'allowed';
  }
  const wait = verdict.retryAfterMs ?? 0;
  return wait > 0 && wait <= WINDOW_MS
    ? 'denied for a wait inside the window'
    : `denied for a wait of ${wait}ms`;
}

// The script hands back a count and a TTL, and every pair it can produce has one right answer.
const REPLIES: ReadonlyArray<{
  label: string;
  reply: unknown;
  verdict: unknown;
}> = [
  {
    label: 'the first call in a fresh window',
    reply: [1, WINDOW_MS],
    verdict: { allowed: true },
  },
  {
    label: 'the call that reaches the limit',
    reply: [LIMIT, 59_000],
    verdict: { allowed: true },
  },
  {
    label: 'past the limit, window still running',
    reply: [LIMIT + 1, 59_000],
    verdict: { allowed: false, retryAfterMs: 59_000 },
  },
  {
    label: 'past the limit, window just armed by the script',
    reply: [LIMIT + 1, WINDOW_MS],
    verdict: { allowed: false, retryAfterMs: WINDOW_MS },
  },
  {
    label: 'past the limit, and the key is gone: TTL -2',
    reply: [LIMIT + 1, -2],
    verdict: { allowed: true },
  },
];

describe('the count and the TTL decide the verdict together', () => {
  test('all five replies the script can return have a verdict', async () => {
    const observed: Array<[string, unknown]> = [];

    for (const row of REPLIES) {
      const limiter = redisRateLimiter(fakeCounter(row.reply), {
        limit: LIMIT,
        windowMs: WINDOW_MS,
      });
      observed.push([row.label, await limiter.allow('usr_ada')]);
    }

    assert.deepEqual(
      observed,
      REPLIES.map((row) => [row.label, row.verdict]),
    );
    assert.equal(observed.length, 5);
    assert.equal(REPLIES.length, 5);
  });

  test('each allow is one round trip carrying the key and the window', async () => {
    const client = fakeCounter([1, WINDOW_MS]);
    const limiter = redisRateLimiter(client, {
      limit: LIMIT,
      windowMs: WINDOW_MS,
    });

    await limiter.allow('usr_ada');
    await limiter.allow('usr_ada');

    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[0]?.slice(1), [
      1,
      `${NAMESPACE}usr_ada`,
      WINDOW_MS,
    ]);
  });
});

describe('a window that lost its expiry is re-armed rather than wedged', () => {
  test('every TTL state leaves the key armed', async (t) => {
    if (!url) {
      t.skip('REDIS_URL unset');
      return;
    }
    const raw = new Redis(url);
    const limiter = await redisRateLimiter(url, {
      limit: LIMIT,
      windowMs: WINDOW_MS,
    });
    const observed: Array<[string, string, boolean]> = [];
    try {
      for (const state of TTL_STATES) {
        const key = `ttl_${crypto.randomUUID().slice(0, 8)}`;
        const stored = `${NAMESPACE}${key}`;
        await state.setUp(raw, stored);
        const verdict = await limiter.allow(key);
        observed.push([
          state.label,
          readVerdict(verdict),
          (await raw.pttl(stored)) > 0,
        ]);
        await raw.del(stored);
      }
    } finally {
      await limiter.close();
      await raw.quit();
    }

    assert.deepEqual(
      observed,
      TTL_STATES.map((state) => [state.label, state.verdict, state.armed]),
    );
    assert.equal(observed.length, 7);
    assert.equal(TTL_STATES.length, 7);
  });

  test('the wait a denial reports is one that actually elapses', async (t) => {
    if (!url) {
      t.skip('REDIS_URL unset');
      return;
    }
    // A window short enough to sit out inside the test, so the recovery is observed rather than
    // reasoned about.
    const shortWindowMs = 300;
    const raw = new Redis(url);
    const limiter = await redisRateLimiter(url, {
      limit: 2,
      windowMs: shortWindowMs,
    });
    const key = `wedge_${crypto.randomUUID().slice(0, 8)}`;
    const stored = `${NAMESPACE}${key}`;
    try {
      await raw.set(stored, '9'); // counting, with no expiry: what a lost PEXPIRE leaves behind
      const denied = await limiter.allow(key);
      assert.equal(denied.allowed, false);
      const wait = denied.retryAfterMs ?? 0;
      assert.ok(
        wait > 0 && wait <= shortWindowMs,
        `retryAfterMs was ${wait}, outside the window`,
      );

      await sleep(wait + 50);

      assert.deepEqual(await limiter.allow(key), { allowed: true });
    } finally {
      await raw.del(stored);
      await limiter.close();
      await raw.quit();
    }
  });
});

// A cache that throws is a miss, and a limiter that throws fails open. Both are the port's own
// promise, and both are what a Redis outage must cost: latency, never correctness.
describe('a failing client degrades rather than breaks', () => {
  test('a failed get surfaces as a retryable STORE.FAILURE', async () => {
    const cache = redisCache({
      get: async () => {
        throw new Error('connection reset');
      },
    } as unknown as RedisClient);
    await assert.rejects(
      cache.get('bal:usr_ada:spendable'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'STORE.FAILURE');
        assert.equal((error as { retryable?: boolean }).retryable, true);
        return true;
      },
    );
  });

  test('a failed limiter call surfaces as a retryable STORE.FAILURE', async () => {
    const limiter = redisRateLimiter(
      {
        eval: async () => {
          throw new Error('connection reset');
        },
      } as unknown as RedisCounterClient,
      { limit: 10, windowMs: 60_000 },
    );
    await assert.rejects(limiter.allow('usr_ada'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'STORE.FAILURE');
      return true;
    });
  });

  test('a reply that is not a count and a TTL is the same failure', async () => {
    const limiter = redisRateLimiter(fakeCounter('OK'), {
      limit: 10,
      windowMs: 60_000,
    });
    await assert.rejects(limiter.allow('usr_ada'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'STORE.FAILURE');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    });
  });
});
