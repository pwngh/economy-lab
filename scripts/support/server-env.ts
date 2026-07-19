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

// The serve/dev/worker host's own runtime knobs: the names, the bounds, and the one parse.
// scripts/main.ts builds ServerRuntime once at dispatch and threads the values from there — the
// raw env map flows only into openPorts()/the hosts, the library's designed env seam. The key lists
// live here (not in main.ts) so test/env-surface.test.ts can import them without executing the
// entry point.

import { readInt } from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';

/** Every host runtime knob scripts/main.ts reads; .env.example is held to this list. */
export const SERVER_KEYS = [
  'PORT',
  'SHUTDOWN_TIMEOUT_MS',
  'WORKER_INTERVAL_MS',
  'WORKER_BATCH',
] as const;

/**
 * The production-externals names scripts/main.ts reads: the fixed-point CREDIT-to-USD rates and
 * the payout provider's bearer token (PROCESSOR_URL itself is a service URL, src/env.ts).
 */
export const EXTERNALS_KEYS = [
  'CREDIT_BUY_RATE',
  'CREDIT_BUY_SCALE',
  'CREDIT_PAR_RATE',
  'CREDIT_PAR_SCALE',
  'PAYOUT_RATE',
  'PAYOUT_SCALE',
  'PROCESSOR_API_KEY',
] as const;

/** The host runtime, parsed once. Past this struct no run function touches the env map. */
export interface ServerRuntime {
  /** PORT — where serve/dev listen. */
  port: number;
  /** SHUTDOWN_TIMEOUT_MS — how long shutdown waits for in-flight work before forcing exit. */
  shutdownTimeoutMs: number;
  /** WORKER_INTERVAL_MS — gap between worker sweep ticks. */
  workerIntervalMs: number;
  /** WORKER_BATCH — rows one worker sweep processes per tick. */
  workerBatch: number;
}

/** The one parse of the host runtime knobs (defaults documented on {@link ServerRuntime}). */
export function serverRuntime(env: EnvMap): ServerRuntime {
  return Object.freeze({
    port: readInt(env.PORT, 3000, { min: 1, max: 65_535 }),
    shutdownTimeoutMs: readInt(env.SHUTDOWN_TIMEOUT_MS, 5000),
    workerIntervalMs: readInt(env.WORKER_INTERVAL_MS, 60_000, { min: 1 }),
    workerBatch: readInt(env.WORKER_BATCH, 100, { min: 1 }),
  });
}
