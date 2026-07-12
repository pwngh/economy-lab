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

import { prove, selfTest, vectors } from '#src/money.vendored.ts';

describe('vendored @pwngh/money', () => {
  test(`passes its ${vectors.length} embedded conformance vectors`, () => {
    assert.deepEqual(selfTest(), []);
  });

  test('holds its laws under the seeded prover', () => {
    assert.deepEqual(prove(), []);
  });
});
