/// <reference types="node" />
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
 * Conformance gate for the unpromoted wire-trial drivers (test/support/wire-trial.ts): the full
 * store conformance suite against a store whose pool seam carries a trial wire implementation.
 * Registers only when WIRE_TRIAL names a driver — the default run never depends on the trial
 * packages, which install with `npm install --no-save postgres`.
 *
 *   WIRE_TRIAL=postgresjs node --test test/adapters/wire-trial.test.ts
 */

import { runStoreConformance } from '#test/conformance/store.ts';
import {
  makeIsolatedPostgresStore,
  testPostgresUrl,
} from '#test/support/adapters.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

const trials = new Set(
  (process.env.WIRE_TRIAL ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== ''),
);

if (trials.has('postgresjs')) {
  runStoreConformance('postgres (postgres.js wire)', () =>
    makeIsolatedPostgresStore({
      url: testPostgresUrl(process.env),
      digest: seededDigest(1),
      clock: fixedClock(0),
      driver: 'postgresjs',
    }),
  );
}
