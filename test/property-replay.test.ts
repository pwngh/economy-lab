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
 * Replay determinism as a property: for generated programs, two identical live runs and a data
 * replay of the first run's recorded operations must agree on every outcome, every minted
 * transaction id, and every final balance. This is the docs↔console journal handoff's
 * foundation promoted to a library law — a divergence means a hidden wall clock or RNG on the
 * submit path.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { arbProgram } from '#test/support/arbitraries.ts';
import { check } from '#test/support/propcheck.ts';
import { runReplayLaws } from '#test/support/replay-laws.ts';

const SEEDS = [0x11e9, 0x5eed];
const RUNS = 30;

describe('property-based: replay determinism over generated programs', () => {
  for (const seed of SEEDS) {
    test(`live runs and data replays converge across ${RUNS} programs (base seed 0x${seed.toString(16)})`, async () => {
      const report = await check(
        arbProgram,
        async (steps) => (await runReplayLaws(steps)) === null,
        { seed, runs: RUNS },
      );
      if (!report.ok) {
        const violation = await runReplayLaws(report.counterexample);
        assert.fail(
          `law "${violation?.law}" broke at step ${violation?.step}: minimal ` +
            `counterexample is ${report.counterexample.length} steps after ` +
            `${report.shrinks} shrinks (seed 0x${report.seed.toString(16)}); ` +
            `detail=${JSON.stringify(violation?.detail)}; ` +
            `program=${JSON.stringify(report.counterexample)}`,
        );
      }
      assert.equal(report.ok, true);
    });
  }
});
