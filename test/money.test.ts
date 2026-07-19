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
  convertCeil,
  convertFloor,
  credits,
  decodeAmount,
  decodeAmountWire,
  encodeAmount,
  isNegative,
  isZero,
  negate,
  toAmount,
  zero,
} from '#src/money.ts';

describe('Money', () => {
  test('round-trips a decimal through decode and encode unchanged', () => {
    const cases = ['0.00', '12.34', '0.05', '1000000.99', '-0.01', '-99.50'];

    for (const decimal of cases) {
      const amount = decodeAmount(decimal, 'CREDIT');
      assert.equal(encodeAmount(amount), `CREDIT:${decimal}`);
    }
  });

  test('decodes minor units exactly as a bigint', () => {
    const amount = decodeAmount('12.34', 'CREDIT');

    assert.deepEqual(amount, toAmount('CREDIT', 1234n));
  });

  test('decodes a bare integer as whole units with zero cents', () => {
    const amount = decodeAmount('7', 'USD');

    assert.deepEqual(amount, toAmount('USD', 700n));
  });

  test('credits() builds a whole-credit Amount from number or bigint', () => {
    assert.deepEqual(credits(120), toAmount('CREDIT', 12_000n));
    assert.deepEqual(credits(0), toAmount('CREDIT', 0n));
    assert.deepEqual(credits(120n), toAmount('CREDIT', 12_000n));
  });

  test('credits() rejects a fractional count as a fault', () => {
    assert.throws(
      () => credits(4.5),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
  });

  test('rejects a decimal with excess precision as a fault', () => {
    assert.throws(
      () => decodeAmount('1.234', 'CREDIT'),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
  });

  test('adds two same-currency amounts in minor units', () => {
    const sum = add(
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
      negate(decodeAmount('4.00', 'USD')),
      decodeAmount('-4.00', 'USD'),
    );
  });

  test('orders two same-currency amounts by minor value', () => {
    const lo = decodeAmount('1.00', 'CREDIT');
    const hi = decodeAmount('2.00', 'CREDIT');

    assert.equal(compare(lo, hi), -1);
    assert.equal(compare(hi, lo), 1);
    assert.equal(compare(lo, lo), 0);
  });

  test('reads zero and sign predicates off the minor value', () => {
    assert.equal(isZero(zero('CREDIT')), true);
    assert.equal(isNegative(decodeAmount('-0.01', 'USD')), true);
    assert.equal(isNegative(zero('USD')), false);
  });

  test('holds every amount inside the 64-bit range the schema stores', () => {
    assert.equal(
      decodeAmount('92233720368547758.07', 'CREDIT').minor,
      9223372036854775807n,
    );
    assert.throws(
      () => toAmount('CREDIT', 9223372036854775808n),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.OVERFLOW',
    );
    assert.throws(
      () =>
        add(toAmount('CREDIT', 9223372036854775807n), toAmount('CREDIT', 1n)),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.OVERFLOW',
    );
    assert.throws(
      () => decodeAmount('92233720368547758.08', 'CREDIT'),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
  });

  test('keeps the canonical wire byte-strict', () => {
    assert.throws(
      () => decodeAmount('1,234.56', 'CREDIT'),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
    assert.throws(
      () => decodeAmountWire('12.34'),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
    assert.throws(
      () => decodeAmountWire('EUR:1.00'),
      (error: unknown) =>
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
    assert.deepEqual(decodeAmountWire('USD:12.34'), toAmount('USD', 1234n));
  });

  test('converts with a true floor and ceiling for either sign', () => {
    const rate = { rate: 1n, scale: 1, rateId: 'rate_test' };

    assert.equal(convertFloor(toAmount('CREDIT', 5n), rate, 'USD').minor, 0n);
    assert.equal(convertCeil(toAmount('CREDIT', 5n), rate, 'USD').minor, 1n);
    assert.equal(convertFloor(toAmount('CREDIT', -5n), rate, 'USD').minor, -1n);
    assert.equal(convertCeil(toAmount('CREDIT', -5n), rate, 'USD').minor, 0n);
  });
});
