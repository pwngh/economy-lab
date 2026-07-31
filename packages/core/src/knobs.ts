/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { readIntOrNull, withinIntBounds } from '@pwngh/economy-lab';
import type { IntBounds } from '@pwngh/economy-lab';

/** The knob table: incumbent env spellings, flags override env. */
export const KNOB_DEFAULTS = {
  PORT: 3000,
  WORKER_INTERVAL_MS: 60_000,
  WORKER_BATCH: 100,
  SHUTDOWN_TIMEOUT_MS: 5_000,
} as const;

export type KnobKey = keyof typeof KNOB_DEFAULTS;

// What each knob will accept from the environment. A batch of 0 is a worker that sweeps nothing
// and a port of 0 is one the OS picks, so both floors are 1 rather than the default 0.
export const KNOB_BOUNDS: Record<KnobKey, IntBounds | undefined> = {
  PORT: { min: 1, max: 65_535 },
  WORKER_INTERVAL_MS: { min: 1 },
  WORKER_BATCH: { min: 1 },
  SHUTDOWN_TIMEOUT_MS: undefined,
};

// What a knob admits when a person types it, rather than a file stating it. One row differs:
// `--port 0` asks the OS for an ephemeral port, which is a thing to type at a prompt with the
// bound port printed back, and never a thing to leave in a deploy file.
const TYPED_BOUNDS: Record<KnobKey, IntBounds | undefined> = {
  ...KNOB_BOUNDS,
  PORT: { min: 0, max: 65_535 },
};

/**
 * The one reading of a knob written on a command line, in a module file, or handed to
 * `createApp` — the lab's integer rule, and the bounds the environment reader already uses.
 * Takes the typed form or the parsed one, so every door admits the same values.
 *
 * `null` is a refusal, never a fallback: a number written by a person present at the keyboard
 * has no sensible silent substitute, while a string in a deploy file does. `--port 0x1f` reads
 * as 31 under `Number`, which is the whole reason this exists.
 */
export function readKnobOrNull(
  key: KnobKey,
  value: string | number,
  bounds: Record<KnobKey, IntBounds | undefined> = TYPED_BOUNDS,
): number | null {
  return typeof value === 'number'
    ? withinIntBounds(value, bounds[key])
      ? value
      : null
    : readIntOrNull(value, bounds[key]);
}

/** The rule in words, so a refusal can quote what it wanted. */
export function knobRule(
  key: KnobKey,
  bounds: Record<KnobKey, IntBounds | undefined> = TYPED_BOUNDS,
): string {
  const b = bounds[key];
  const min = b?.min ?? 0;
  return b?.max === undefined
    ? `a whole number ${min} or greater`
    : `a whole number from ${min} to ${b.max}`;
}
