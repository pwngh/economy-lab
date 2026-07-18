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

import { memoryRateLimiter } from '#src/adapters/memory-rate-limit.ts';
import { fixedClock } from '#test/support/capabilities.ts';

describe('memoryRateLimiter', () => {
  test('allows up to the limit inside one window', async () => {
    const limiter = memoryRateLimiter(
      { limit: 2, windowMs: 1_000 },
      fixedClock(0),
    );

    assert.deepEqual(await limiter.allow('k'), { allowed: true });
    assert.deepEqual(await limiter.allow('k'), { allowed: true });
    assert.deepEqual(await limiter.allow('k'), {
      allowed: false,
      retryAfterMs: 1_000,
    });
  });

  test('a denial reports the time left until the window resets', async () => {
    const clock = fixedClock(0);
    const limiter = memoryRateLimiter({ limit: 1, windowMs: 1_000 }, clock);

    await limiter.allow('k');
    clock.advance(400);

    assert.deepEqual(await limiter.allow('k'), {
      allowed: false,
      retryAfterMs: 600,
    });
  });

  test('a lapsed window resets and counting starts over', async () => {
    const clock = fixedClock(0);
    const limiter = memoryRateLimiter({ limit: 1, windowMs: 1_000 }, clock);

    await limiter.allow('k');
    assert.equal((await limiter.allow('k')).allowed, false);
    clock.advance(1_000);

    assert.deepEqual(await limiter.allow('k'), { allowed: true });
  });

  test('keys count independently', async () => {
    const limiter = memoryRateLimiter(
      { limit: 1, windowMs: 1_000 },
      fixedClock(0),
    );

    await limiter.allow('a');

    assert.deepEqual(await limiter.allow('b'), { allowed: true });
  });
});
