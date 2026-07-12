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

/**
 * The `toInt64BE` encoder feeds the v2 checkpoint preimages (chain.ts), where the same sum must
 * become the same bytes on every runtime. These pin the two's-complement layout at the edges and
 * the refusal to wrap: `DataView.setBigInt64` would silently reduce an out-of-range value modulo
 * 2^64, and a wrapped sum must never reach a hash.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { toHex, toInt64BE } from '#src/bytes.ts';
import { EconomyError } from '#src/errors.ts';

const MAX = 2n ** 63n - 1n;
const MIN = -(2n ** 63n);

describe('toInt64BE', () => {
  test("encodes fixed-width big-endian two's complement", () => {
    assert.equal(toHex(toInt64BE(0n)), '0000000000000000');
    assert.equal(toHex(toInt64BE(1n)), '0000000000000001');
    assert.equal(toHex(toInt64BE(-1n)), 'ffffffffffffffff');
    assert.equal(toHex(toInt64BE(256n)), '0000000000000100');
    assert.equal(toHex(toInt64BE(MAX)), '7fffffffffffffff');
    assert.equal(toHex(toInt64BE(MIN)), '8000000000000000');
  });

  test('throws on values outside the signed 64-bit range instead of wrapping', () => {
    for (const value of [MAX + 1n, MIN - 1n, 2n ** 64n]) {
      assert.throws(
        () => toInt64BE(value),
        (error: unknown) =>
          error instanceof EconomyError && error.code === 'MONEY.OVERFLOW',
      );
    }
  });
});
