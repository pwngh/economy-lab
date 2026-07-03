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

import { memoryCache } from '#src/adapters/memory-cache.ts';
import { runCacheConformance } from '#test/conformance/cache.ts';

import type { Clock } from '#src/ports.ts';

// Builds a clock the test advances by hand. Manual control makes TTL expiry deterministic.
function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

runCacheConformance('memory', () => memoryCache());

describe('memoryCache: ttl expiry', () => {
  test('an entry past its ttl reads back null', async () => {
    const clock = manualClock();
    const cache = memoryCache(clock);

    await cache.set('bal:usr_1', 'CREDIT:1.00', 1_000);
    assert.equal(await cache.get('bal:usr_1'), 'CREDIT:1.00');

    clock.advance(1_000);
    assert.equal(await cache.get('bal:usr_1'), null);
  });

  test('an entry without a ttl never expires', async () => {
    const clock = manualClock();
    const cache = memoryCache(clock);

    await cache.set('bal:usr_1', 'CREDIT:1.00');
    clock.advance(10_000_000);

    assert.equal(await cache.get('bal:usr_1'), 'CREDIT:1.00');
  });
});
