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

import { createEconomy } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  silentMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
  testSecrets,
} from '#test/support/capabilities.ts';
import { topUp, credit } from '#test/support/builders.ts';
import { SYSTEM, shardsOf, spendable } from '#src/accounts.ts';

import type { Economy } from '#src/economy.ts';
import type { Cache } from '#src/ports.ts';

function recordingCache(): Cache & {
  readonly gets: ReadonlyArray<string>;
  readonly sets: ReadonlyArray<string>;
  readonly invalidations: ReadonlyArray<string>;
} {
  const store = new Map<string, string>();
  const gets: string[] = [];
  const sets: string[] = [];
  const invalidations: string[] = [];
  return {
    gets,
    sets,
    invalidations,
    get: async (key) => {
      gets.push(key);
      return store.has(key) ? store.get(key)! : null;
    },
    set: async (key, value) => {
      sets.push(key);
      store.set(key, value);
    },
    invalidate: async (key) => {
      invalidations.push(key);
      store.delete(key);
    },
  };
}

function throwingCache(): Cache {
  const boom = (): never => {
    throw new Error('redis unavailable');
  };
  return {
    get: async () => boom(),
    set: async () => boom(),
    invalidate: async () => boom(),
  };
}

// Mirrors `makeEconomy` but injects a `cache` capability, which `makeEconomy` leaves unset.
function makeCachedEconomy(
  cache: Cache,
  seed = 1,
  config: Partial<ReturnType<typeof testConfig>> = {},
): Economy {
  const digest = seededDigest(seed);
  const clock = fixedClock(0);
  return createEconomy({
    store: memoryStore({ digest, clock }),
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(seed),
    rates: fixedRates(),
    logger: testLogger(),
    meter: silentMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: { ...testConfig(), ...config },
    secrets: testSecrets(),
    cache,
  });
}

describe('Read-Through Balance Cache', () => {
  test('first read populates the cache, second read hits it', async () => {
    const cache = recordingCache();
    const economy = makeCachedEconomy(cache);
    const account = spendable('usr_buyer');

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    const first = await economy.read.balance(account);
    assert.deepEqual(first, credit('10.00'));
    assert.deepEqual(cache.gets, [`bal:${account}`]);
    assert.deepEqual(cache.sets, [`bal:${account}`]);

    const second = await economy.read.balance(account);
    assert.deepEqual(second, credit('10.00'));
    assert.deepEqual(cache.gets, [`bal:${account}`, `bal:${account}`]);
    assert.deepEqual(cache.sets, [`bal:${account}`]);
  });

  test('a committed posting invalidates every account it touched', async () => {
    const cache = recordingCache();
    const economy = makeCachedEconomy(cache);
    const account = spendable('usr_buyer');

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    await economy.read.balance(account);
    await economy.read.balance(account);
    assert.deepEqual(cache.gets.length, 2);

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );
    assert.equal(cache.invalidations.includes(`bal:${account}`), true);

    const after = await economy.read.balance(account);
    assert.deepEqual(after, credit('15.00'));
  });

  test('a bare sharded account reads through per-shard keys and sums them', async () => {
    const cache = recordingCache();
    const economy = makeCachedEconomy(cache, 1, { platformShards: 4 });
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    const total = await economy.read.balance(SYSTEM.STORED_VALUE);
    assert.deepEqual(total, credit('10.00'));
    const keys = shardsOf(SYSTEM.STORED_VALUE, 4).map(
      (shard) => `bal:${shard}`,
    );
    assert.deepEqual(cache.gets, keys);
    assert.deepEqual(cache.sets, keys);

    // The second read is four hits: the same gets again, no new sets.
    assert.deepEqual(await economy.read.balance(SYSTEM.STORED_VALUE), total);
    assert.deepEqual(cache.gets, [...keys, ...keys]);
    assert.deepEqual(cache.sets, keys);
  });

  test('a rejected operation invalidates nothing', async () => {
    const cache = recordingCache();
    const economy = makeCachedEconomy(cache);
    const account = spendable('usr_buyer');

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    await economy.read.balance(account);

    // The committed top-up already invalidated its touched accounts; snapshot that count to assert
    // the rejected op below adds nothing.
    const invalidationsBefore = cache.invalidations.length;

    const outcome = await economy.submit({
      kind: 'spend',
      idempotencyKey: 'idem_overspend',
      actor: { kind: 'user', userId: 'usr_buyer' },
      orderId: 'ord_overspend',
      buyerId: 'usr_buyer',
      sku: 'sku_pricey',
      price: credit('999.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    });
    assert.equal(outcome.status, 'rejected');
    assert.equal(cache.invalidations.length, invalidationsBefore);
  });

  test('a cache outage degrades to a direct ledger read, never fails the request', async () => {
    const economy = makeCachedEconomy(throwingCache());
    const account = spendable('usr_buyer');

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    const balance = await economy.read.balance(account);
    assert.deepEqual(balance, credit('10.00'));
  });

  test('a cache outage during invalidation still commits the posting', async () => {
    const economy = makeCachedEconomy(throwingCache());

    const outcome = await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});
