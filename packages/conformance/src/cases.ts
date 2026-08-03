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

// Counts the cases a conformance suite registers, so that number lives in the file that defines
// the suite.
//
// `./testing` is the one published subpath built from outside `src/`, so these files' emit is what
// every driving package loads. A case added here and not rebuilt is published by the NEXT lane's
// `build-dist`, and lands in that lane's fan-out as a delta it did not cause and cannot attribute:
// `@pwngh/economy-postgres` moved 141 -> 143 with nothing under `packages/` touched. Freshness
// cannot catch it — the emit was already newer than every source when that lane arrived.
//
// So each suite declares how many cases it registers and proves it as one of them. The root suite
// drives these from source, so a case added without the count moves fails there immediately, and
// the number moves in this repository's diff instead of in a neighbouring package's tally.

import assert from 'node:assert/strict';

import type { TestContext } from 'node:test';

/** One conformance case, as `node:test` takes it. */
export type ConformanceCase = (t: TestContext) => Promise<void> | void;

/**
 * A `test` that counts. Register every case in the suite through it, and it registers one more
 * that fails when the total is not the declared one. `declared` counts that case too, so it is
 * the number a driver sees in its own totals for one call of the suite.
 *
 * `register` is the caller's own `test`, wrapped at the caller. It is a parameter rather than an
 * import here because `node:test` stamps each event with the file the registration was written
 * in, and `test/support/numbered.reporter.mjs` groups a suite's children by that file: a case
 * registered from this module lands under a suite that is not in its group and is dropped from
 * the report without a word. Measured — see Q361.
 */
export function countedCases(
  suite: string,
  declared: number,
  register: (name: string, body: ConformanceCase) => void,
): (name: string, body: ConformanceCase) => void {
  let registered = 0;
  const counted = (name: string, body: ConformanceCase): void => {
    registered += 1;
    register(name, body);
  };
  // Registered first, so it exists however the caller's own registrations go. `registered` is
  // final by the time any body runs: node:test registers a suite synchronously and runs it after.
  counted(`registers the ${declared} cases ${suite} declares`, () => {
    assert.equal(
      registered,
      declared,
      `${suite} registers ${registered} cases and declares ${declared}. Every driver's test total moves by the difference, so put the new number here rather than reading it off a package.`,
    );
  });
  return counted;
}
