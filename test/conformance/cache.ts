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

import type { Cache } from '#src/ports.ts';

/**
 * The shared {@link Cache} contract every adapter must satisfy, run against the in-process
 * reference (`memoryCache`) and the Redis adapter (over a fake client) — the same pattern as
 * `test/conformance/store.ts`: one suite, many backends, so a new Cache implementation can't
 * silently diverge.
 *
 * Covers the cross-adapter contract (miss, round-trip, overwrite, invalidate, read-back before
 * expiry). Backend-specific behavior — Redis key prefixing and a real `PX` expiry, the memory
 * cache's clock-driven expiry — stays in each adapter's own test.
 */
export function runCacheConformance(
  name: string,
  makeCache: () => Cache,
): void {
  describe(`Cache Conformance: ${name}`, () => {
    test('a missing key reads back null', async () => {
      let cache = makeCache();
      assert.equal(await cache.get('bal:absent'), null);
    });

    test('a value round-trips under its key', async () => {
      let cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:12.34');
      assert.equal(await cache.get('bal:usr_1'), 'CREDIT:12.34');
    });

    test('a later set overwrites the prior value', async () => {
      let cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:1.00');
      await cache.set('bal:usr_1', 'CREDIT:2.00');
      assert.equal(await cache.get('bal:usr_1'), 'CREDIT:2.00');
    });

    test('invalidate removes a key, so it reads back null', async () => {
      let cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:1.00');
      await cache.invalidate('bal:usr_1');
      assert.equal(await cache.get('bal:usr_1'), null);
    });

    test('invalidating an absent key is a no-op', async () => {
      let cache = makeCache();
      await cache.invalidate('bal:never_set'); // must not throw
      assert.equal(await cache.get('bal:never_set'), null);
    });

    test('a value set with a ttl still reads back before it expires', async () => {
      let cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:1.00', 60_000);
      assert.equal(await cache.get('bal:usr_1'), 'CREDIT:1.00');
    });
  });
}
