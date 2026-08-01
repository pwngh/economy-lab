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

// The env names .env.example documents whose readers export no roster of their own: the four
// knobs the CLI resolves, the production externals src/from-env.ts reads, and the supervisor
// flag this app turns into `flags.supervisor`. test/env-surface.test.ts holds .env.example to
// the union of every declared family, so a name with no family here is a name nobody reads.

import type { KnobKey } from '@pwngh/economy/app';

// Checked both ways against the framework's own knob roster: a knob the CLI gained and this list
// does not carry fails to compile, and so does a name here the CLI no longer resolves.
const SERVER_KEY_SET = {
  PORT: true,
  SHUTDOWN_TIMEOUT_MS: true,
  WORKER_INTERVAL_MS: true,
  WORKER_BATCH: true,
} as const satisfies Record<KnobKey, true>;

/** The runtime knobs `economy dev|serve|worker` resolves, env spelling. */
export const SERVER_KEYS = Object.keys(SERVER_KEY_SET) as readonly KnobKey[];

/**
 * The production externals: the fixed-point CREDIT-to-USD rates and the payout provider's bearer
 * token (PROCESSOR_URL itself is a service URL, declared in src/env.ts). Unset in production,
 * every one of these is a preflight error, which is what `economy serve` refuses to bind past.
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

/** The supervisor opt-in, which economy/app.ts compiles to the module's `flags.supervisor`. */
export const SUPERVISOR_KEYS = ['SUPERVISOR'] as const;
