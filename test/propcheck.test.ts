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
 * Unit tests for the property-checking core itself — the generators and, above all, the shrinker.
 * Pure and deterministic: no economy, no clock, just seeded values in and minimal counterexamples out.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  array,
  check,
  choice,
  int,
  minimize,
  record,
} from '#test/support/propcheck.ts';

describe('propcheck generators', () => {
  test('int shrinks toward its minimum', () => {
    assert.deepEqual(int(0, 100).shrink(0), []);
    const towardZero = int(0, 100).shrink(80);
    assert.equal(towardZero[0], 0);
    assert.ok(towardZero.every((n) => n < 80));
  });

  test('choice shrinks toward earlier values only', () => {
    const arb = choice('a', 'b', 'c');
    assert.deepEqual(arb.shrink('a'), []);
    assert.deepEqual(arb.shrink('c'), ['a', 'b']);
  });

  test('record shrinks one field at a time', () => {
    const arb = record<{ a: number; b: number }>({
      a: int(0, 9),
      b: int(0, 9),
    });
    const candidates = arb.shrink({ a: 3, b: 2 });
    assert.ok(candidates.length > 0, 'a shrinkable record offers candidates');
    for (const candidate of candidates) {
      const changed = (candidate.a === 3 ? 0 : 1) + (candidate.b === 2 ? 0 : 1);
      assert.equal(changed, 1, 'exactly one field differs per candidate');
    }
    assert.ok(candidates.some((c) => c.a < 3 && c.b === 2));
    assert.ok(candidates.some((c) => c.b < 2 && c.a === 3));
    assert.deepEqual(arb.shrink({ a: 0, b: 0 }), []);
  });

  test('array shrinks by dropping and by shrinking elements', () => {
    const candidates = array(int(0, 9), 8).shrink([3, 4]);
    assert.ok(
      candidates.some((c) => c.length === 0),
      'offers the empty array',
    );
    assert.ok(
      candidates.some((c) => c.length === 1),
      'offers dropping one element',
    );
    // Same length as the input, one element shrunk toward its minimum — only the element-shrinking
    // pass produces this, so it pins that axis (dropping alone would never keep the length).
    assert.ok(
      candidates.some((c) => c.length === 2 && (c[0]! < 3 || c[1]! < 4)),
      'offers a same-length candidate with a smaller element',
    );
  });
});

describe('propcheck minimize', () => {
  test('reduces a failing array to a minimal still-failing core', async () => {
    // "every array sums to less than 10" — false; the minimal counterexample is small and still sums high.
    const arb = array(int(0, 5), 12);
    const underTen = (xs: number[]) => xs.reduce((a, b) => a + b, 0) < 10;
    const failing = [5, 0, 4, 1, 5, 2, 3];
    assert.equal(underTen(failing), false, 'the seed case must fail');
    const [minimal] = await minimize(arb, underTen, failing);
    assert.equal(underTen(minimal), false, 'the minimized case still fails');
    assert.ok(minimal.length < failing.length, 'it shrank the input');
    // A local minimum: dropping any single element stops it failing (greedy, so not the global min).
    const dropOneAlwaysHolds = minimal.every((_, i) =>
      underTen([...minimal.slice(0, i), ...minimal.slice(i + 1)]),
    );
    assert.ok(dropOneAlwaysHolds, 'no single element can be dropped — minimal');
  });

  test('reduces a scalar by shrinking its value, with nothing to drop', async () => {
    // An int has no length to trim; reaching the boundary is only possible by shrinking the value.
    const [minimal] = await minimize(int(0, 9), (n) => n < 5, 9);
    assert.equal(
      minimal,
      5,
      'shrinks 9 down to the boundary value that still fails',
    );
  });
});

describe('propcheck check', () => {
  test('reports ok for a property that always holds', async () => {
    const report = await check(int(0, 1000), (n) => n >= 0, {
      seed: 0x1234,
      runs: 200,
    });
    assert.equal(report.ok, true);
  });

  test('finds and shrinks a counterexample, reproducibly by seed', async () => {
    const arb = array(int(0, 9), 10);
    const noNine = (xs: number[]) => !xs.includes(9);
    const first = await check(arb, noNine, { seed: 0x77, runs: 500 });
    const again = await check(arb, noNine, { seed: 0x77, runs: 500 });
    assert.equal(first.ok, false);
    assert.equal(again.ok, false);
    if (!first.ok && !again.ok) {
      assert.equal(first.seed, again.seed, 'same seed → same failing case');
      assert.deepEqual(
        first.counterexample,
        again.counterexample,
        'same seed → same shrunk counterexample',
      );
      assert.deepEqual(
        first.counterexample,
        [9],
        'shrinks to the single element that trips the property',
      );
    }
  });
});
