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

import { paginate } from '#src/paginate.ts';

async function* stream(n: number): AsyncIterable<number> {
  for (let i = 0; i < n; i += 1) {
    yield i;
  }
}

describe('paginate', () => {
  test('returns the window and the full total', async () => {
    const page = await paginate(stream(10), { offset: 3, limit: 4 });
    assert.deepEqual(page, { rows: [3, 4, 5, 6], total: 10 });
  });

  test('a window past the end is empty but the total still counts', async () => {
    const page = await paginate(stream(5), { offset: 50, limit: 10 });
    assert.deepEqual(page, { rows: [], total: 5 });
  });

  test('a short tail yields fewer rows than the limit', async () => {
    const page = await paginate(stream(5), { offset: 3, limit: 10 });
    assert.deepEqual(page, { rows: [3, 4], total: 5 });
  });

  test('limit zero counts without collecting', async () => {
    const page = await paginate(stream(4), { offset: 0, limit: 0 });
    assert.deepEqual(page, { rows: [], total: 4 });
  });

  test('an empty stream pages to nothing', async () => {
    const page = await paginate(stream(0), { offset: 0, limit: 10 });
    assert.deepEqual(page, { rows: [], total: 0 });
  });
});
