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

// Client JavaScript budget: a ratchet re-baselined to the measured cost when a new surface
// deliberately lands, then only allowed to shrink until the next. Run after `react-router build`;
// exits non-zero when the client assets outgrow it.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Measured 557,855 after vite.config.ts stubbed the unreachable node drivers out of the bundle.
const BUDGET_BYTES = 560_000;

const dir = new URL('../build/client/assets/', import.meta.url).pathname;
const total = readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);

console.log(`client js: ${total} bytes (budget ${BUDGET_BYTES})`);
if (total > BUDGET_BYTES) {
  console.error('over budget - the client bundle may only shrink.');
  process.exit(1);
}
