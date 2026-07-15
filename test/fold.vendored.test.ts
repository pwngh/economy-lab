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

import { moduleBytes, selfTest, vectors } from '#src/fold.vendored.ts';

describe('vendored @pwngh/money fold', () => {
  test(`passes its ${vectors.length} embedded conformance vectors and cross-check`, () => {
    assert.deepEqual(selfTest(), []);
  });

  test('assembles the deterministic 125-byte module its header claims', () => {
    assert.equal(moduleBytes().length, 125);
  });
});
