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
 * Money-movement laws over generated inputs. Split conservation: however a sale's shareBps
 * composition is generated, every minor unit of the price lands on a seller or the platform and
 * no cut is negative. Velocity ceiling: the gate's observable outcomes match an external
 * reconstruction of the window — commits fit under the limit, RISK_DENIED crossed it, and
 * denied attempts still fill the window. Exactly-once: every committed operation resubmitted
 * verbatim replays as `duplicate` with the same transaction id and moves nothing.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { arbProgram } from '#test/support/arbitraries.ts';
import {
  arbSplit,
  runSplitLaw,
  runVelocityAndOnce,
} from '#test/support/money-laws.ts';
import { check } from '#test/support/propcheck.ts';

const SPLIT_SEEDS = [0x5b17, 0xbead];
const SPLIT_RUNS = 80;
const WINDOW_SEEDS = [0xce11, 0x0cea];
const WINDOW_RUNS = 40;

describe('property-based: split conservation over generated recipient sets', () => {
  for (const seed of SPLIT_SEEDS) {
    test(`conserves every minor unit across ${SPLIT_RUNS} generated sales (base seed 0x${seed.toString(16)})`, async () => {
      const report = await check(
        arbSplit,
        async (sale) => (await runSplitLaw(sale)) === null,
        { seed, runs: SPLIT_RUNS },
      );
      if (!report.ok) {
        const violation = await runSplitLaw(report.counterexample);
        assert.fail(
          `law "${violation?.law}" broke: minimal sale is ` +
            `${JSON.stringify(report.counterexample)} after ${report.shrinks} ` +
            `shrinks (seed 0x${report.seed.toString(16)}); ` +
            `detail=${JSON.stringify(violation?.detail)}`,
        );
      }
      assert.equal(report.ok, true);
    });
  }
});

describe('property-based: velocity ceiling and exactly-once over generated programs', () => {
  for (const seed of WINDOW_SEEDS) {
    test(`window oracle and duplicate replay hold across ${WINDOW_RUNS} programs (base seed 0x${seed.toString(16)})`, async () => {
      const report = await check(
        arbProgram,
        async (steps) => (await runVelocityAndOnce(steps)) === null,
        { seed, runs: WINDOW_RUNS },
      );
      if (!report.ok) {
        const violation = await runVelocityAndOnce(report.counterexample);
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
