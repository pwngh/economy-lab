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

// Client JavaScript budget: a held ceiling, not a per-change ratchet. Run after `react-router
// build`; exits non-zero when the client assets outgrow it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// A deliberate ceiling with headroom (~14 KB over the current ~561 KB), so ordinary refactors do
// not nudge it and only a real jump trips the gate. Move it only when a major surface deliberately
// lands, not to absorb incremental churn. The gzipped wire cost is reported beside the raw figure.
const BUDGET_BYTES = 575_000;

const dir = new URL('../build/client/assets/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const total = files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
// The wire cost, reported beside the ratchet number: hosts serve these gzipped.
const gzipped = files.reduce(
  (sum, f) => sum + gzipSync(readFileSync(join(dir, f))).length,
  0,
);

console.log(
  `client js: ${total} bytes (budget ${BUDGET_BYTES}), ${gzipped} gzipped on the wire`,
);
if (total > BUDGET_BYTES) {
  console.error('over budget - the client bundle may only shrink.');
  process.exit(1);
}
