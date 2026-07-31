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
 * Prints the lab's public surface, in the form `test/fixtures/lab-surface.json` is pinned to.
 *
 * Redirect it over the fixture to accept a surface change:
 * `node test/fixtures/generate-lab-surface.ts > test/fixtures/lab-surface.json`.
 *
 * What it prints is a subpath → symbol → kind map read off THIS tree, and three real breaks have
 * gone through it silently: a member removed from a published interface, a subpath the registry
 * answers and this tree does not, and — for the two totals a report quotes — a subpath key renamed
 * with its symbols intact. So regenerating this file and seeing a small diff is not evidence a
 * change was additive. `test/lab-surface.test.ts` names all three and demonstrates each.
 */

import process from 'node:process';

import { readSurface } from '#test/support/lab-surface.ts';

process.stdout.write(
  `${JSON.stringify(readSurface(process.cwd()), null, 2)}\n`,
);
