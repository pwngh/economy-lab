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
 * Adversarial property suite: generated hostile operations — malformed amounts (including
 * brand-cast smuggling past `toAmount`), blank identities and keys, broken recipient splits,
 * wrong principals — fired at a funded economy. The laws: hostile input never commits, every
 * refusal is a known typed code, a refusal leaves no trace on any balance or invariant, and the
 * refused idempotency key stays usable. A failing seed reproduces the exact payload.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { arbHostile, refusedCleanly } from '#test/support/hostile.ts';
import { check } from '#test/support/propcheck.ts';

const SEEDS = [0xdead, 0xf0e5];
const RUNS = 100;

describe('property-based: hostile operations are refused cleanly', () => {
  for (const seed of SEEDS) {
    test(`refuses ${RUNS} generated hostile payloads without a trace (base seed 0x${seed.toString(16)})`, async () => {
      const report = await check(
        arbHostile,
        async (hostile) => (await refusedCleanly(hostile)) === null,
        { seed, runs: RUNS },
      );
      if (!report.ok) {
        const violation = await refusedCleanly(report.counterexample);
        assert.fail(
          `law "${violation?.law}" broke: minimal hostile case is ` +
            `${JSON.stringify(report.counterexample)} after ${report.shrinks} ` +
            `shrinks (seed 0x${report.seed.toString(16)}); ` +
            `detail=${JSON.stringify(violation?.detail)}`,
        );
      }
      assert.equal(report.ok, true);
    });
  }
});
