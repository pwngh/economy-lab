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
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';
import { topUp, credit } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';

import type { Economy } from '#src/economy.ts';
import type { Cache } from '#src/ports.ts';

// In-memory string store (get/set/invalidate) with a per-method call log, so tests can assert
// when a balance read hit, populated, or dropped a cache entry. The production Redis adapter is
// exercised elsewhere.
function recordingCache(): Cache & {
  readonly gets: ReadonlyArray<string>;
  readonly sets: ReadonlyArray<string>;
  readonly invalidations: ReadonlyArray<string>;
} {
  let store = new Map<string, string>();
  let gets: string[] = [];
  let sets: string[] = [];
  let invalidations: string[] = [];
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

// A cache whose every operation throws, standing in for an unreachable Redis. The read path must
// degrade to the ledger and a committed posting must still succeed. This is the Cache port's
// best-effort contract: a cache only speeds reads, it never breaks them.
function throwingCache(): Cache {
  let boom = (): never => {
    throw new Error('redis unavailable');
  };
  return {
    get: async () => boom(),
    set: async () => boom(),
    invalidate: async () => boom(),
  };
}

// Economy wired with the standard deterministic test doubles plus the given cache, on a fresh
// in-memory store. Mirrors `makeEconomy` but injects a `cache` capability, which `makeEconomy`
// leaves unset.
function makeCachedEconomy(cache: Cache, seed = 1): Economy {
  let digest = seededDigest(seed);
  let clock = fixedClock(0);
  return createEconomy({
    store: memoryStore({ digest, clock }),
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(seed),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
    cache,
  });
}

describe('Read-Through Balance Cache', () => {
  test('first read populates the cache, second read hits it', async () => {
    let cache = recordingCache();
    let economy = makeCachedEconomy(cache);
    let account = spendable('usr_buyer');

    // Fund the account so it has a non-zero balance to cache.
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    // First read misses: get finds nothing, then set populates.
    let first = await economy.read.balance(account);
    assert.deepEqual(first, credit('10.00'));
    assert.deepEqual(cache.gets, [`bal:${account}`]);
    assert.deepEqual(cache.sets, [`bal:${account}`]);

    // The second read hits the cache and returns the stored value without populating again. The
    // cache holds strings, so the balance is serialized in and parsed back out. Assert the round
    // trip returns the same amount.
    let second = await economy.read.balance(account);
    assert.deepEqual(second, credit('10.00'));
    assert.deepEqual(cache.gets, [`bal:${account}`, `bal:${account}`]);
    assert.deepEqual(cache.sets, [`bal:${account}`]); // still just the one populate
  });

  test('a committed posting invalidates every account it touched', async () => {
    let cache = recordingCache();
    let economy = makeCachedEconomy(cache);
    let account = spendable('usr_buyer');

    // Fund and warm the cache so the account's balance is cached at 10.00.
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    await economy.read.balance(account); // miss -> populate
    await economy.read.balance(account); // hit
    assert.deepEqual(cache.gets.length, 2);

    // Second committed top-up touches `spendable(usr_buyer)`, so its cache key is invalidated.
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );
    assert.equal(cache.invalidations.includes(`bal:${account}`), true);

    // The next read is a fresh miss. It re-derives the balance by summing the recorded entries, so
    // it returns the new balance rather than the stale cached 10.00.
    let after = await economy.read.balance(account);
    assert.deepEqual(after, credit('15.00'));
  });

  test('a rejected operation invalidates nothing', async () => {
    let cache = recordingCache();
    let economy = makeCachedEconomy(cache);
    let account = spendable('usr_buyer');

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    await economy.read.balance(account); // warm the cache

    // The committed top-up already invalidated its touched accounts; snapshot that count to assert
    // the rejected op below adds nothing.
    let invalidationsBefore = cache.invalidations.length;

    // A spend the buyer can't afford is rejected and records no ledger entry, so it changes no
    // balance and drops no cache entry.
    let outcome = await economy.submit({
      kind: 'spend',
      idempotencyKey: 'idem_overspend',
      actor: { kind: 'user', userId: 'usr_buyer' },
      orderId: 'ord_overspend',
      buyerId: 'usr_buyer',
      sku: 'sku_pricey',
      price: credit('999.00'),
    });
    assert.equal(outcome.status, 'rejected');
    assert.equal(cache.invalidations.length, invalidationsBefore);
  });

  test('a cache outage degrades to a direct ledger read, never fails the request', async () => {
    let economy = makeCachedEconomy(throwingCache());
    let account = spendable('usr_buyer');

    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    // The get throws and is absorbed as a miss, so the read falls back to the ledger. The set then
    // throws and is also absorbed. The read returns the right balance instead of propagating the
    // cache failure.
    let balance = await economy.read.balance(account);
    assert.deepEqual(balance, credit('10.00'));
  });

  test('a cache outage during invalidation still commits the posting', async () => {
    let economy = makeCachedEconomy(throwingCache());

    // The top-up commits; invalidateCache hits the throwing cache after commit, but the failure is
    // absorbed so the operation reports committed rather than failing post-commit.
    let outcome = await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});
