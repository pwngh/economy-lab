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

// A recording in-memory cache. It behaves like a real string store (get/set/invalidate) and
// also keeps a per-method call log, so a test can assert exactly when serving a balance read
// hit the cache, populated it, or dropped an entry. This is the only cache the economy ever
// sees in these tests; the production Redis adapter is exercised elsewhere.
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

// Build an economy wired with the standard deterministic test doubles plus the given cache,
// against a fresh in-memory store. Mirrors `makeEconomy` but injects a `cache` capability,
// which `makeEconomy` deliberately leaves unset.
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

    // Fund the account so it has a real, non-zero balance to cache.
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    // First read is a miss: it asks the cache (get), finds nothing, and populates it (set).
    let first = await economy.read.balance(account);
    assert.deepEqual(first, credit('10.00'));
    assert.deepEqual(cache.gets, [`bal:${account}`]);
    assert.deepEqual(cache.sets, [`bal:${account}`]);

    // Second read is a hit: it asks the cache again and gets the stored value back, with no
    // new populate. The cache only holds strings, so the balance is serialized on the way in and
    // parsed back out; this asserts that round-trip returns the exact same amount.
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

    // A second committed top-up touches `spendable(usr_buyer)`, so its cache key is invalidated.
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );
    assert.equal(cache.invalidations.includes(`bal:${account}`), true);

    // The next read is therefore a fresh miss that re-derives the balance by summing the
    // recorded entries, returning the new balance rather than the stale cached 10.00.
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

    // The committed top-up already invalidated its touched accounts; snapshot that count so we
    // can assert the rejected op below adds nothing on top of it.
    let invalidationsBefore = cache.invalidations.length;

    // A spend the buyer can't afford is rejected (a normal "no" that records no ledger entry),
    // so it changes no balance and must drop no cache entry.
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
});
