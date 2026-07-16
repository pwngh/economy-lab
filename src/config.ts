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

import { ERROR_CODES, fault } from '#src/errors.ts';
import {
  isProduction,
  missingSecrets,
  readBigInt,
  readBigIntOrNull,
  readInt,
  readIntOrNull,
} from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';

/**
 * All tunable settings in one object.
 *
 * No module reads env vars itself; the startup program builds this once (via
 * {@link loadConfig}) and passes it in, so a misconfigured deploy fails at startup
 * rather than deep inside a request.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration}
 *   for every tunable and its default.
 */
export interface Config {
  webhookSecret: string;

  signingSecret: string;

  replayWindowMs: number;

  maxPayoutAttempts: number;

  maxOutboxAttempts: number;

  maxInboxAttempts: number;

  maxSubscriptionAttempts: number;

  /** Force-fail deadline (ms) for a SUBMITTED payout — unlike `payoutSla.SUBMITTED`, which only
   *  schedules the next settle check. */
  maxPayoutAgeMs: number;

  /** Platform's cut in basis points (hundredths of a percent); 10000 = 100%, 1530 = 15.3%. */
  platformFeeBps: number;

  /** Payout-rail fee in basis points: the processor's own cut, deducted from the disbursement so
   *  the seller receives the net. Not platform revenue. */
  payoutFeeBps: number;

  /** The single-knob velocity ceiling (CREDIT minor units): both window classes fall back to it
   *  unless their own limit below is set. */
  velocityLimitMinor: bigint;

  /** Ceiling for the inflow window (topUp, grantPromo) — card testing fills this one. Unset
   *  means `velocityLimitMinor`. */
  velocityInflowLimitMinor?: bigint;

  /** Ceiling for the outflow window (spend, subscribe, requestPayout) — a drained wallet fills
   *  this one. Unset means `velocityLimitMinor`. */
  velocityOutflowLimitMinor?: bigint;

  /** Length (ms) of the velocity window. Captured at store construction; changing it means a
   *  rebuild over the same store (the config object is frozen for exactly this reason). */
  velocityWindowMs: number;

  /** Smallest subscription price, in CREDIT minor units. A price outside the band is refused
   *  at subscribe time; the band keeps a typo'd price from silently binding a buyer. */
  subscriptionPriceMinMinor: bigint;

  /** Largest subscription price, in CREDIT minor units. */
  subscriptionPriceMaxMinor: bigint;

  /**
   * How long (ms) topped-up funds must wait before they can be spent or paid out, keyed by
   * funding source ("card", "crypto", "steam", "meta"); unlisted sources use "default".
   */
  maturityHorizonMs: Record<string, number>;

  /**
   * Time budget (ms) per payout-processing step, used to schedule when the worker next examines
   * a saga. `PENDING` delays the first submit pass after a request, `SUBMITTED` delays the next
   * check on a submitted payout, and `DEFAULT` covers either when unset.
   */
  payoutSla: Record<string, number>;

  /** Smallest payout a user may request, counted only against earned CREDIT — never bought or
   *  promo-granted. */
  payoutMinimumEarnedMinor: bigint;

  /**
   * Min time (ms) between payout requests. The default is 24h to match the live docs. The legal
   * requirement is 14 days (1_209_600_000).
   */
  payoutMinIntervalMs: number;

  /**
   * Scheduled maintenance window (epoch ms): end-user discretionary writes decline as
   * ECONOMY_PAUSED while `pauseStartMs <= now < pauseEndMs`; either bound null means no window.
   * Settlement (actor 'system'), operator fixes, and reads are never gated.
   */
  pauseStartMs: number | null;
  pauseEndMs: number | null;

  /**
   * Rows each hot platform account is split across. Shard 0 keeps the bare id, so raising the
   * count later is safe; only ever lower it back to 1.
   */
  platformShards: number;
}

// The per-class velocity limits stay absent unless their env var parses, so the single-knob
// fallback keeps working after a later velocityLimitMinor override.
function bigIntIfSet(
  key: 'velocityInflowLimitMinor' | 'velocityOutflowLimitMinor',
  value: string | undefined,
): Partial<Config> {
  const parsed = readBigIntOrNull(value);
  return parsed === null ? {} : { [key]: parsed };
}

/** Every name {@link loadConfig} reads; .env.example is held to this list. */
export const CONFIG_KEYS = [
  'NODE_ENV',
  'WEBHOOK_SECRET',
  'SIGNING_SECRET',
  'REPLAY_WINDOW_MS',
  'MAX_PAYOUT_ATTEMPTS',
  'MAX_OUTBOX_ATTEMPTS',
  'MAX_INBOX_ATTEMPTS',
  'MAX_SUBSCRIPTION_ATTEMPTS',
  'MAX_PAYOUT_AGE_MS',
  'PLATFORM_FEE_BPS',
  'PAYOUT_FEE_BPS',
  'VELOCITY_LIMIT_MINOR',
  'VELOCITY_INFLOW_LIMIT_MINOR',
  'VELOCITY_OUTFLOW_LIMIT_MINOR',
  'VELOCITY_WINDOW_MS',
  'SUBSCRIPTION_PRICE_MIN_MINOR',
  'SUBSCRIPTION_PRICE_MAX_MINOR',
  'MATURITY_HORIZON_CARD_MS',
  'MATURITY_HORIZON_CRYPTO_MS',
  'MATURITY_HORIZON_STEAM_MS',
  'MATURITY_HORIZON_META_MS',
  'MATURITY_HORIZON_DEFAULT_MS',
  'SLA_PENDING_MS',
  'SLA_SUBMITTED_MS',
  'SLA_DEFAULT_MS',
  'PAYOUT_MIN_EARNED_MINOR',
  'PAYOUT_MIN_INTERVAL_MS',
  'ECONOMY_PAUSE_START_MS',
  'ECONOMY_PAUSE_END_MS',
  'PLATFORM_SHARDS',
] as const;

/**
 * Build {@link Config} from env vars, defaulting any value that is unset or invalid.
 *
 * If any required secret — or the maturity anchor MATURITY_HORIZON_CARD_MS — is missing in
 * production, throws a single CONFIG.INVALID fault listing all missing keys at once, so the
 * program fails at startup rather than one key at a time during requests.
 */
export function loadConfig(env: EnvMap): Config {
  const production = isProduction(env);
  // Outside production unset horizons are 0, so the zero-config quickstart's topUp → spend
  // works. Production must state the card horizon, the anchor every other rail defaults to.
  const cardHorizonMs = readInt(env.MATURITY_HORIZON_CARD_MS, 0);

  const missing = production ? missingSecrets(env) : [];
  if (production && (env.MATURITY_HORIZON_CARD_MS ?? '') === '') {
    missing.push('MATURITY_HORIZON_CARD_MS');
  }
  if (missing.length > 0) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Required configuration is missing.',
      {
        detail: { missing },
      },
    );
  }

  return {
    webhookSecret: env.WEBHOOK_SECRET ?? '',
    signingSecret: env.SIGNING_SECRET ?? '',
    replayWindowMs: readInt(env.REPLAY_WINDOW_MS, 5 * 60_000),
    maxPayoutAttempts: readInt(env.MAX_PAYOUT_ATTEMPTS, 5, { min: 1 }),
    maxOutboxAttempts: readInt(env.MAX_OUTBOX_ATTEMPTS, 10, { min: 1 }),
    maxInboxAttempts: readInt(env.MAX_INBOX_ATTEMPTS, 10, { min: 1 }),
    maxSubscriptionAttempts: readInt(env.MAX_SUBSCRIPTION_ATTEMPTS, 10, {
      min: 1,
    }),
    // Three days: real payout rails settle in one to two business days, so the force-fail
    // backstop must outlast a weekend-adjacent settlement, not race it.
    maxPayoutAgeMs: readInt(env.MAX_PAYOUT_AGE_MS, 72 * 60 * 60_000),

    platformFeeBps: readInt(env.PLATFORM_FEE_BPS, 1530, { max: 10_000 }),
    payoutFeeBps: readInt(env.PAYOUT_FEE_BPS, 150, { max: 10_000 }),
    velocityLimitMinor: readBigInt(env.VELOCITY_LIMIT_MINOR, 100_000n),
    ...bigIntIfSet('velocityInflowLimitMinor', env.VELOCITY_INFLOW_LIMIT_MINOR),
    ...bigIntIfSet(
      'velocityOutflowLimitMinor',
      env.VELOCITY_OUTFLOW_LIMIT_MINOR,
    ),
    subscriptionPriceMinMinor: readBigInt(
      env.SUBSCRIPTION_PRICE_MIN_MINOR,
      10_000n,
    ),
    subscriptionPriceMaxMinor: readBigInt(
      env.SUBSCRIPTION_PRICE_MAX_MINOR,
      1_000_000n,
    ),
    velocityWindowMs: readInt(env.VELOCITY_WINDOW_MS, 60 * 60_000, { min: 1 }),
    maturityHorizonMs: {
      card: cardHorizonMs,
      // Every other rail defaults to the card horizon, the conservative anchor; a deployment
      // that knows a rail's real refund window overrides it per rail.
      crypto: readInt(env.MATURITY_HORIZON_CRYPTO_MS, cardHorizonMs),
      steam: readInt(env.MATURITY_HORIZON_STEAM_MS, cardHorizonMs),
      meta: readInt(env.MATURITY_HORIZON_META_MS, cardHorizonMs),
      // Fallback for unlisted funding sources.
      default: readInt(env.MATURITY_HORIZON_DEFAULT_MS, cardHorizonMs),
    },
    payoutSla: {
      PENDING: readInt(env.SLA_PENDING_MS, 30_000),
      SUBMITTED: readInt(env.SLA_SUBMITTED_MS, 120_000),
      DEFAULT: readInt(env.SLA_DEFAULT_MS, 60_000),
    },
    payoutMinimumEarnedMinor: readBigInt(
      env.PAYOUT_MIN_EARNED_MINOR,
      2_000_000n,
    ),
    payoutMinIntervalMs: readInt(env.PAYOUT_MIN_INTERVAL_MS, 24 * 60 * 60_000),
    pauseStartMs: readIntOrNull(env.ECONOMY_PAUSE_START_MS),
    pauseEndMs: readIntOrNull(env.ECONOMY_PAUSE_END_MS),
    platformShards: readInt(env.PLATFORM_SHARDS, 1, { min: 1 }),
  };
}

/**
 * The default {@link Config} without an environment: the exact values {@link loadConfig} derives from
 * an empty env, with any knobs in `overrides` applied on top ({@link mergeConfig} semantics). For
 * tests and the in-memory quickstart that want a Config in hand without assembling an {@link EnvMap}.
 */
export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return mergeConfig(loadConfig({}), overrides);
}

/**
 * `overrides` on top of `base`, last-wins per knob — except the record-valued knobs
 * (`maturityHorizonMs`, `payoutSla`), which merge one level deep: overriding one funding source
 * or one SLA step keeps the others instead of replacing the whole record.
 */
export function mergeConfig(base: Config, overrides: Partial<Config>): Config {
  const merged = { ...base, ...overrides };
  if (overrides.maturityHorizonMs) {
    merged.maturityHorizonMs = {
      ...base.maturityHorizonMs,
      ...overrides.maturityHorizonMs,
    };
  }
  if (overrides.payoutSla) {
    merged.payoutSla = { ...base.payoutSla, ...overrides.payoutSla };
  }
  return merged;
}

/**
 * Whether the maintenance window is active at `now`. Pure: derives solely from `now` and the two
 * config bounds, so the gate and the read surface agree.
 */
export function economyPaused(
  now: number,
  config: Pick<Config, 'pauseStartMs' | 'pauseEndMs'>,
): boolean {
  const { pauseStartMs, pauseEndMs } = config;
  if (pauseStartMs === null || pauseEndMs === null) {
    return false;
  }
  return pauseStartMs <= now && now < pauseEndMs;
}
