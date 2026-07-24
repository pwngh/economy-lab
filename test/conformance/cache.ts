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
 * Runs the shared {@link Cache} contract that every adapter must satisfy. The suite runs against
 * the in-process reference (`memoryCache`) and the Redis adapter over a fake client. This follows
 * the same pattern as `test/conformance/store.ts`: one suite, many backends, so a new Cache
 * implementation cannot silently diverge.
 *
 * The suite covers the cross-adapter contract: miss, round-trip, overwrite, invalidate, and
 * read-back before expiry. Backend-specific behavior stays in each adapter's own test. That
 * includes Redis key prefixing and a real `PX` expiry, plus the memory cache's clock-driven expiry.
 *
 * A host wires its own adapter in by calling this at the top level of a `node --test` file with a
 * display name and a factory. The factory runs afresh inside each test, so every test starts from
 * an empty cache and the implementation needs no cross-test cleanup. The expiry test only reads
 * back before the ttl elapses — the suite never waits a ttl out, so no fake clock is required.
 */
export function runCacheConformance(
  name: string,
  makeCache: () => Cache,
): void {
  describe(`Cache Conformance: ${name}`, () => {
    test('a missing key reads back null', async () => {
      const cache = makeCache();
      assert.equal(await cache.get('bal:absent'), null);
    });

    test('a value round-trips under its key', async () => {
      const cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:12.34');
      assert.equal(await cache.get('bal:usr_1'), 'CREDIT:12.34');
    });

    test('a later set overwrites the prior value', async () => {
      const cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:1.00');
      await cache.set('bal:usr_1', 'CREDIT:2.00');
      assert.equal(await cache.get('bal:usr_1'), 'CREDIT:2.00');
    });

    test('invalidate removes a key, so it reads back null', async () => {
      const cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:1.00');
      await cache.invalidate('bal:usr_1');
      assert.equal(await cache.get('bal:usr_1'), null);
    });

    test('invalidating an absent key is a no-op', async () => {
      const cache = makeCache();
      await cache.invalidate('bal:never_set'); // must not throw
      assert.equal(await cache.get('bal:never_set'), null);
    });

    test('a value set with a ttl still reads back before it expires', async () => {
      const cache = makeCache();
      await cache.set('bal:usr_1', 'CREDIT:1.00', 60_000);
      assert.equal(await cache.get('bal:usr_1'), 'CREDIT:1.00');
    });
  });
}
