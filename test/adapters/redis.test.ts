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
import { runCacheConformance } from '#test/conformance/cache.ts';

// In-memory stand-in for the ioredis client, with only the methods the adapter calls.
// Lets tests check adapter behavior (key prefix, expiry forwarding, error conversion)
// without a running Redis.
//
// `store` holds the fake's key/value pairs for inspection. `setCalls` records the exact
// argument list of every `set` call, to confirm the expiry option passed through unchanged.
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

// Fake whose every command throws, to check the adapter converts a driver error into
// the project's own error type.
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

  test('translates a set failure into a retryable STORE.FAILURE fault', async () => {
    let cache = redisCacheFrom(failingRedis(new Error('ECONNRESET')));

    await assert.rejects(
      cache.set('balance:usr_1:spendable', 'CREDIT:1.00'),
      (error: unknown) => {
        let fault = error as { code?: string; retryable?: boolean };
        assert.equal(fault.code, 'STORE.FAILURE');
        assert.equal(fault.retryable, true);
        return true;
      },
    );
  });

  test('translates an invalidate failure into a retryable STORE.FAILURE fault', async () => {
    let cache = redisCacheFrom(failingRedis(new Error('ECONNRESET')));

    await assert.rejects(
      cache.invalidate('balance:usr_1:spendable'),
      (error: unknown) => {
        let fault = error as { code?: string; retryable?: boolean };
        assert.equal(fault.code, 'STORE.FAILURE');
        assert.equal(fault.retryable, true);
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

// The shared Cache contract, against the Redis adapter over the fake client.
runCacheConformance('redis', () => redisCacheFrom(fakeRedis()));
