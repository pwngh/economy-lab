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

import {
  add,
  compare,
  decodeAmount,
  encodeAmount,
  isNegative,
  isZero,
  neg,
  toAmount,
  zero,
} from '#src/money.ts';

describe('Money', () => {
  test('round-trips a decimal through decode and encode unchanged', () => {
    let cases = ['0.00', '12.34', '0.05', '1000000.99', '-0.01', '-99.50'];

    for (let decimal of cases) {
      let amount = decodeAmount(decimal, 'CREDIT');
      assert.equal(encodeAmount(amount), `CREDIT:${decimal}`);
    }
  });

  test('decodes minor units exactly as a bigint', () => {
    let amount = decodeAmount('12.34', 'CREDIT');

    assert.deepEqual(amount, toAmount('CREDIT', 1234n));
  });

  test('decodes a bare integer as whole units with zero cents', () => {
    let amount = decodeAmount('7', 'USD');

    assert.deepEqual(amount, toAmount('USD', 700n));
  });

  test('rejects a decimal with excess precision as a fault', () => {
    assert.throws(
      () => decodeAmount('1.234', 'CREDIT'),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
  });

  test('adds two same-currency amounts in minor units', () => {
    let sum = add(
      decodeAmount('1.50', 'CREDIT'),
      decodeAmount('2.25', 'CREDIT'),
    );

    assert.deepEqual(sum, decodeAmount('3.75', 'CREDIT'));
  });

  test('throws CURRENCY_MISMATCH when combining across currencies', () => {
    assert.throws(
      () => add(toAmount('CREDIT', 100n), toAmount('USD', 100n)),
      (error: unknown) =>
        (error as { code?: string }).code === 'LEDGER.CURRENCY_MISMATCH',
    );
  });

  test('negates an amount while preserving its currency', () => {
    assert.deepEqual(
      neg(decodeAmount('4.00', 'USD')),
      decodeAmount('-4.00', 'USD'),
    );
  });

  test('orders two same-currency amounts by minor value', () => {
    let lo = decodeAmount('1.00', 'CREDIT');
    let hi = decodeAmount('2.00', 'CREDIT');

    assert.equal(compare(lo, hi), -1);
    assert.equal(compare(hi, lo), 1);
    assert.equal(compare(lo, lo), 0);
  });

  test('reads zero and sign predicates off the minor value', () => {
    assert.equal(isZero(zero('CREDIT')), true);
    assert.equal(isNegative(decodeAmount('-0.01', 'USD')), true);
    assert.equal(isNegative(zero('USD')), false);
  });
});
