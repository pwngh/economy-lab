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

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP = fileURLToPath(new URL('../', import.meta.url));

/**
 * This app runs on the built packages, not on the sources beside them, so a suite started
 * against an emit older than its source reports on the previous build under this build's name.
 *
 * The check runs as a subprocess rather than an import: `test/console-front-door.test.ts` holds
 * this app's module graph to the umbrella doors alone, and repository tooling is not a door.
 */
export default function setup(): void {
  const run = spawnSync('node', [`${REPO}scripts/check-dist-fresh.ts`, APP], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    throw new Error(
      `${run.stderr || run.stdout || ''}`.trim() ||
        `dist-freshness: check-dist-fresh.ts did not run (${run.error?.message ?? `status ${run.status}`})`,
    );
  }
}
