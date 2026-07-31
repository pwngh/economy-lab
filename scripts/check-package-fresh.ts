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

// Dates the emit a package's own tests read, run from that package's directory:
//
//   node ../../scripts/check-package-fresh.ts
//
// A package test imports the lab and its siblings through their exports maps, so it runs against
// `dist` — last build's copy of that source. Nothing on the single-package loop dated that, so
// `npm test -w <pkg>` reported a green that could describe the previous build. It is the test
// script rather than the `pretest` that carries this: the pretest is one string driven verbatim
// against a throwaway package outside the tree by `test/package-test-typechecks.test.ts`, where
// a path back into this repository does not resolve.
//
// Only the units this package reads are dated, which is the difference between a refusal a lane
// can act on and one it has to wait out: a package's build being behind has nothing to do with a
// package that never loads it.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  BUILDS_DATED,
  assertFresh,
  checkUnits,
  unitsRead,
} from './check-dist-fresh.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function main(): number {
  // The fan-out dates the whole tree once before it spawns anything, so its sixteen children
  // skip the work rather than repeating it. A shell that sets this by hand is asserting
  // something it has not checked.
  if (process.env[BUILDS_DATED] === '1') return 0;
  const dir = process.cwd();
  try {
    const units = unitsRead(ROOT, dir);
    const report = assertFresh(checkUnits(units, ROOT), `${dir}'s own tests`);
    process.stdout.write(
      `dist-freshness: ${report.comparedOutputs.size} build outputs across the ${report.units.length} units these tests read are at least as new as their sources\n`,
    );
    return 0;
  } catch (refusal) {
    console.error((refusal as Error).message);
    return 1;
  }
}

process.exitCode = main();
