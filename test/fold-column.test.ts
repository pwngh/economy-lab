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

import { I64Column, foldColumn } from '#src/fold-column.ts';
import { I64_MAX } from '#src/fold.vendored.ts';
import { ERROR_CODES } from '#src/errors.ts';
import { seededDeltas } from '#test/support/seeded-deltas.ts';

function columnOf(values: readonly bigint[]): I64Column {
  const column = new I64Column();
  for (const value of values) {
    column.push(value);
  }
  return column;
}

const sum = (values: readonly bigint[]): bigint =>
  values.reduce((a, b) => a + b, 0n);

describe('I64Column', () => {
  test('push grows past its initial capacity and view is the live prefix', () => {
    const values = seededDeltas(50);
    const column = columnOf(values);
    assert.equal(column.length, 50);
    assert.deepEqual([...column.view()], values);
  });

  test('pop shrinks the live length without disturbing the kept prefix', () => {
    const values = seededDeltas(300);
    const column = columnOf(values);
    for (let i = 0; i < 50; i += 1) {
      column.pop();
    }
    assert.equal(column.length, 250);
    assert.deepEqual([...column.view()], values.slice(0, 250));
  });

  test('pop on an empty column is a no-op', () => {
    const column = new I64Column();
    column.pop();
    assert.equal(column.length, 0);
  });
});

describe('foldColumn', () => {
  // Sizes straddle the 256-leg threshold so both the plain-loop and the fold path are covered.
  for (const count of [0, 1, 10, 255, 256, 257, 1_000, 5_000]) {
    test(`folds a ${count}-leg column to the same total as a scalar sum`, () => {
      const values = seededDeltas(count);
      assert.equal(foldColumn(columnOf(values)), sum(values));
    });
  }

  test('folds the live prefix after a rollback pops the tail', () => {
    const values = seededDeltas(1_000);
    const column = columnOf(values);
    for (let i = 0; i < 400; i += 1) {
      column.pop();
    }
    assert.equal(foldColumn(column), sum(values.slice(0, 600)));
  });

  test('surfaces an over-64-bit running total on the fold path as AMOUNT_OVERFLOW', () => {
    // Two maxima overflow at the second step; padding to 256 selects the checked fold path.
    const column = columnOf([
      I64_MAX,
      I64_MAX,
      ...seededDeltas(254).map(() => 0n),
    ]);
    assert.throws(
      () => foldColumn(column),
      (error: unknown) =>
        (error as { code?: string }).code === ERROR_CODES.AMOUNT_OVERFLOW,
    );
  });

  test('leaves the range check to the caller on the small plain-loop path', () => {
    // Below the threshold the loop just sums; toAmount is the range gate at the call site.
    assert.equal(foldColumn(columnOf([I64_MAX, I64_MAX])), I64_MAX * 2n);
  });
});
