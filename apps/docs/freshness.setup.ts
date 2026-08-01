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

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const APP = fileURLToPath(new URL('./', import.meta.url));

/**
 * This app resolves every <ApiLink> into the generated reference at `docs/`, so a suite started
 * against a reference older than the source it documents certifies the previous build under this
 * build's name.
 *
 * The check runs as a subprocess rather than an import: it reads the repository's typedoc config
 * and source tree, and this app's tsconfig deliberately keeps the lab's source graph out (the
 * reason is at the `exclude` in tsconfig.json).
 */
export default function setup(): void {
  const run = spawnSync('node', [`${REPO}scripts/check-docs-fresh.ts`, APP], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    throw new Error(
      `${run.stderr || run.stdout || ''}`.trim() ||
        `docs-freshness: check-docs-fresh.ts did not run (${run.error?.message ?? `status ${run.status}`})`,
    );
  }
}
