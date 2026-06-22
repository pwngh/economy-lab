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

import { redisCacheFrom } from '#src/adapters/redis.ts';

// A stand-in for the real Redis client (ioredis), with just the few methods the adapter
// calls, backed by an in-memory map instead of a real server. Using a fake lets these
// tests check the adapter's own behavior — adding a key prefix, forwarding the
// expiry option, converting errors — without needing a running Redis.
//
// `store` is where the fake keeps its key/value pairs, so a test can inspect what
// landed there. `setCalls` records the exact argument list of every `set` call, so a
// test can confirm the expiry option was passed through unchanged.
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
  let store = new Map<string, string>();
  let setCalls: unknown[][] = [];
  let fake: FakeRedis = {
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

// A fake whose every command throws, so a test can check that the adapter turns a
// driver error into the project's own error type.
function failingRedis(cause: Error): FakeRedis {
  let base = fakeRedis();
  return {
    ...base,
    get: async () => Promise.reject(cause),
    set: async () => Promise.reject(cause),
    del: async () => Promise.reject(cause),
  };
}

describe('redisCacheFrom', () => {
  test('round-trips a value under the namespaced key', async () => {
    let client = fakeRedis();
    let cache = redisCacheFrom(client);

    await cache.set('balance:usr_42:spendable', 'CREDIT:12.34');
    let read = await cache.get('balance:usr_42:spendable');

    assert.equal(read, 'CREDIT:12.34');
    assert.equal(
      client.store.has('economy:cache:balance:usr_42:spendable'),
      true,
    );
  });

  test('returns null for a missing key', async () => {
    let cache = redisCacheFrom(fakeRedis());

    let read = await cache.get('balance:usr_absent:spendable');

    assert.equal(read, null);
  });

  test('forwards a TTL as the PX millisecond flag', async () => {
    let client = fakeRedis();
    let cache = redisCacheFrom(client);

    await cache.set('balance:usr_7:spendable', 'CREDIT:1.00', 60_000);

    assert.deepEqual(client.setCalls[0], [
      'economy:cache:balance:usr_7:spendable',
      'CREDIT:1.00',
      'PX',
      60_000,
    ]);
  });

  test('omits the TTL flag when no ttl is given', async () => {
    let client = fakeRedis();
    let cache = redisCacheFrom(client);

    await cache.set('balance:usr_7:earned', 'CREDIT:2.00');

    assert.deepEqual(client.setCalls[0], [
      'economy:cache:balance:usr_7:earned',
      'CREDIT:2.00',
    ]);
  });

  test('invalidates the namespaced key', async () => {
    let client = fakeRedis();
    let cache = redisCacheFrom(client);
    await cache.set('balance:usr_9:spendable', 'CREDIT:5.00');

    await cache.invalidate('balance:usr_9:spendable');
    let read = await cache.get('balance:usr_9:spendable');

    assert.equal(read, null);
    assert.equal(client.store.size, 0);
  });

  test('translates a driver failure into a retryable STORE.FAILURE fault', async () => {
    let cause = new Error('ECONNRESET');
    let cache = redisCacheFrom(failingRedis(cause));

    await assert.rejects(
      cache.get('balance:usr_1:spendable'),
      (error: unknown) => {
        let fault = error as {
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

  test('closes by quitting the underlying client', async () => {
    let client = fakeRedis();
    let quit = false;
    let cache = redisCacheFrom({
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
