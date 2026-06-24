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

// Demo wiring for the console: the simulation clock and the env the demo feeds the engine. Kept
// apart from economy.server.ts (the live engine + facade) and views.server.ts (the render shapes).

import type { Clock } from '#src/ports.ts';

export const DAY_MS = 86_400_000;

// A clock the simulation controls. Time only advances when the panel advances it; the economy,
// store, and worker all share this one clock object.
export function makeClock(): Clock & {
  advance: (ms: number) => void;
  set: (t: number) => void;
} {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

// Demo config, as the engine reads it (env vars). Most limits are relaxed so the everyday flow
// always goes through. The maturity horizon is the one knob the demo exercises: only the default
// horizon is raised (the one earned credits fall under), so card/crypto clear at once and only
// payouts are gated.
export function demoEnv(
  maturityDays: number,
  maxAttempts: number,
): Record<string, string> {
  return {
    WEBHOOK_SECRET: 'console',
    SIGNING_SECRET: 'console',
    REPLAY_WINDOW_MS: String(5 * 60_000),
    MAX_PAYOUT_ATTEMPTS: String(maxAttempts),
    PLATFORM_FEE_BPS: '1530', // ~15.3%, VRChat's real marketplace transaction fee
    VELOCITY_LIMIT_MINOR: String(100_000_000),
    VELOCITY_WINDOW_MS: String(60 * 60_000),
    MATURITY_HORIZON_CARD_MS: '0',
    MATURITY_HORIZON_CRYPTO_MS: '0',
    MATURITY_HORIZON_DEFAULT_MS: String(maturityDays * DAY_MS),
    SLA_PENDING_MS: String(30_000),
    SLA_SUBMITTED_MS: String(120_000),
    SLA_DEFAULT_MS: String(60_000),
    PAYOUT_MIN_EARNED_MINOR: '0',
    PAYOUT_MIN_INTERVAL_MS: '0',
    MAX_OUTBOX_ATTEMPTS: '10',
    MAX_SUBSCRIPTION_ATTEMPTS: '10',
    MAX_PAYOUT_AGE_MS: String(86_400_000),
    ...(process.env.DATABASE_URL
      ? { DATABASE_URL: process.env.DATABASE_URL }
      : {}),
  };
}
