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

/**
 * The README says how many sweeps the worker runs. This test ties that number to
 * SWEEP_NAMES. Add or remove a sweep, and the README must change too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SWEEP_NAMES } from '#src/worker/index.ts';

const WORDS: Record<number, string> = { 16: 'sixteen' };

test('README sweep count matches SWEEP_NAMES', () => {
  const md = readFileSync(
    new URL('../README.md', import.meta.url),
    'utf8',
  ).toLowerCase();
  const n = SWEEP_NAMES.length;
  assert.ok(
    md.includes(`${n} sweeps`) || md.includes(`${WORDS[n]} sweeps`),
    `README must state ${n} sweeps`,
  );
});
