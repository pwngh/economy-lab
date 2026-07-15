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
 * Property-based ledger laws. Generates programs of operations, replays each against a fresh economy,
 * and after every step asserts the ProveReport invariants hold and that authorization was honored.
 * Unlike the seeded suites, a counterexample is shrunk to its minimal failing form and printed with
 * the seed that reproduces it — a failing seed is a real bug, never flake.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for the
 *   invariants themselves.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { check } from '#test/support/propcheck.ts';
import { arbProgram, runProgram } from '#test/support/arbitraries.ts';

// A handful of base seeds; each check() runs `RUNS` consecutive seeds from its base. Fixed, so the
// suite is deterministic and any failure reproduces from the printed seed alone.
const SEEDS = [0xa17, 0xb0b5, 0xcafe];
const RUNS = 60;

describe('property-based: ledger laws over generated operation programs', () => {
  for (const seed of SEEDS) {
    test(`holds every invariant and honors authorization across ${RUNS} programs (base seed 0x${seed.toString(16)})`, async () => {
      const report = await check(
        arbProgram,
        async (steps) => (await runProgram(steps)) === null,
        { seed, runs: RUNS },
      );
      if (!report.ok) {
        // Re-run the minimal counterexample to name the law it broke.
        const violation = await runProgram(report.counterexample);
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
