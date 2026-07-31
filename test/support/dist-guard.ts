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

// Dates the emit as this file is loaded, for a root test file that reads the lab through a
// published specifier. `scripts/suite.mjs` and `scripts/check.ts` already refuse such a file
// against a build behind its source, but a `node --test <file>` typed into a shell reaches
// neither, and its green describes the previous build. An import runs under every runner, which
// is the only property that closes that.
//
// The whole tree is dated, deliberately: the two prescribed runners refuse on the same reading
// and print the same message, and a second, narrower idea of fresh enough would be one more
// thing to hold in mind about which command refused and why.
//
// Costs the prescribed runners nothing. They date once before they spawn and pass BUILDS_DATED,
// so the files they run skip the work rather than repeating it 41 times.
//
// `test/dist-reach.test.ts` holds the roster: a root test file reaches a published door if and
// only if it imports this module. The exception it derives is `test/conformance/`, which the
// lab's own build compiles into the published emit — a file that ships cannot import a check on
// this repository's build.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BUILDS_DATED, assertBuildsFresh } from '#scripts/check-dist-fresh.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

if (process.env[BUILDS_DATED] !== '1') {
  assertBuildsFresh(ROOT, 'a test file that reads the lab through a package');
}
