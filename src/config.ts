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
  readBigInt,
  readBigIntOrNull,
  readInt,
  readIntOrNull,
  readList,
} from '#src/env.ts';

import type { EnvMap } from '#src/env.ts';

/**
 * All tunable policy settings in one object. Policy only — no secrets live here, so the whole
 * object is safe to log; credentials ride in {@link Secrets}.
 *
 * No module reads env vars itself; the startup program builds this once (via
 * {@link loadConfig}) and passes it in, so a misconfigured deploy fails at startup
 * rather than deep inside a request.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration}
 *   for every tunable and its default.
 */
export interface Config {
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
   *  unless their own limit below is set. The default is demo-scale; production must state it. */
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

  /** The purchase catalog: the only top-up amounts accepted, in CREDIT minor units. Stores sell
   *  credits in fixed bundles, so a deployment that mirrors its store sets the same list and a
   *  mispriced grant fails at submit. Unset means any positive amount. */
  topUpBundlesMinor?: readonly bigint[];

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
   * Max connections in the SQL engine's pool (`DB_POOL_MAX`). Null keeps each driver's default
   * of 10. Excess concurrent submits queue for a connection; a transaction holds exactly one
   * connection for its whole life, so the queue always drains.
   */
  dbPoolMax: number | null;

  /**
   * Rows each hot platform account is split across. Shard 0 keeps the bare id, so raising the
   * count later is safe; only ever lower it back to 1.
   */
  platformShards: number;
}

// The per-class velocity limits stay absent unless their env var parses, so the single-knob
// fallback keeps working after a later velocityLimitMinor override.
// The submit pipeline's per-operation amount ceiling; a bundle above it could never be bought.
const MAX_BUNDLE_MINOR = 1_000_000_000_000_000n;

// A comma-separated list of positive minor-unit counts. A malformed entry throws rather than
// defaulting: the silent fallback here would be an unenforced catalog, not a safe value. Deduped,
// sorted, and frozen so the stored catalog reads in bundle order and cannot be mutated later.
function bigIntListIfSet(
  key: 'topUpBundlesMinor',
  value: string | undefined,
): Partial<Config> {
  if (value === undefined || value.trim() === '') {
    return {};
  }
  const entries = value.split(',').map((entry) => entry.trim());
  const valid = entries.every((entry) => {
    if (!/^\d+$/.test(entry)) {
      return false;
    }
    const minor = BigInt(entry);
    return minor > 0n && minor <= MAX_BUNDLE_MINOR;
  });
  if (!valid) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'TOP_UP_BUNDLES_MINOR must be a comma-separated list of positive minor-unit counts.',
      { detail: { value }, retryable: false },
    );
  }
  const bundles = Object.freeze(
    [...new Set(entries.map(BigInt))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
  return { [key]: bundles };
}

function bigIntIfSet(
  key: 'velocityInflowLimitMinor' | 'velocityOutflowLimitMinor',
  value: string | undefined,
): Partial<Config> {
  const parsed = readBigIntOrNull(value);
  return parsed === null ? {} : { [key]: parsed };
}

/** Every name {@link loadConfig} reads; .env.example is held to this list. Policy only —
 * the secret names live in {@link SECRET_KEYS}. */
export const CONFIG_KEYS = [
  'NODE_ENV',
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
  'TOP_UP_BUNDLES_MINOR',
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
  'DB_POOL_MAX',
] as const;

/** Every name {@link loadSecrets} reads. Kept apart from {@link CONFIG_KEYS} so the log-safe
 * policy list can never grow a credential. */
export const SECRET_KEYS = [
  'WEBHOOK_SECRET',
  'SIGNING_SECRET',
  'SIGNING_SECRETS_PRIOR',
] as const;

/** Boolean flags (1/true) that declare a production deployment runs without the named optional
 * port on purpose; openPorts treats a bare omission as an error (§ absence policy). */
export const DECLINE_KEYS = [
  'DISPATCHER_DECLINED',
  'PAYEES_DECLINED',
  'ANCHOR_DECLINED',
] as const;

/**
 * Credentials, split from {@link Config} so the policy object stays log-safe. `signingSecretsPrior`
 * lists rotated-out signing secrets old checkpoints must still verify against.
 */
export interface Secrets {
  readonly webhookSecret: string;
  readonly signingSecret: string;
  readonly signingSecretsPrior?: readonly string[];
}

/**
 * Build {@link Secrets} from env vars, any `overrides` winning per field. In production a blank
 * required secret on the merged bag throws one CONFIG.INVALID fault listing every missing key;
 * outside production a blank stays blank and the construction layer supplies its dev stand-in.
 */
export function loadSecrets(
  env: EnvMap,
  overrides: Partial<Secrets> = {},
): Secrets {
  const prior = readList(env.SIGNING_SECRETS_PRIOR);
  const secrets: Secrets = {
    webhookSecret: overrides.webhookSecret ?? env.WEBHOOK_SECRET ?? '',
    signingSecret: overrides.signingSecret ?? env.SIGNING_SECRET ?? '',
    ...(overrides.signingSecretsPrior !== undefined
      ? { signingSecretsPrior: overrides.signingSecretsPrior }
      : prior.length > 0
        ? { signingSecretsPrior: prior }
        : {}),
  };
  if (isProduction(env)) {
    const missing = missingSecretFields(secrets);
    if (missing.length > 0) {
      throw fault(ERROR_CODES.CONFIG_INVALID, 'Required secrets are missing.', {
        detail: { missing },
      });
    }
  }
  return secrets;
}

/** The required secret env names still blank on a merged bag; `preflight` reports these. */
export function missingSecretFields(secrets: Secrets): string[] {
  const missing: string[] = [];
  if (secrets.webhookSecret === '') missing.push('WEBHOOK_SECRET');
  if (secrets.signingSecret === '') missing.push('SIGNING_SECRET');
  return missing;
}

/**
 * Build {@link Config} from env vars, defaulting any value that is unset or invalid.
 *
 * If a policy anchor — MATURITY_HORIZON_CARD_MS or VELOCITY_LIMIT_MINOR — is missing in
 * production, throws a single CONFIG.INVALID fault listing all missing keys at once, so the
 * program fails at startup rather than one key at a time during requests.
 */
export function loadConfig(env: EnvMap): Config {
  return inspectConfig(env);
}

/**
 * The production policy-anchor env names satisfied by neither `env` nor `overrides`; empty
 * outside production. `preflight` reports these; {@link inspectConfig} throws on them.
 */
export function missingPolicyAnchors(
  env: EnvMap,
  overrides: Partial<Config> = {},
): string[] {
  if (!isProduction(env)) {
    return [];
  }
  const missing: string[] = [];
  if (
    overrides.maturityHorizonMs?.card === undefined &&
    (env.MATURITY_HORIZON_CARD_MS ?? '') === ''
  ) {
    missing.push('MATURITY_HORIZON_CARD_MS');
  }
  if (
    overrides.velocityLimitMinor === undefined &&
    (env.VELOCITY_LIMIT_MINOR ?? '') === ''
  ) {
    missing.push('VELOCITY_LIMIT_MINOR');
  }
  return missing;
}

function buildConfig(env: EnvMap): Config {
  // Outside production unset horizons are 0, so the zero-config quickstart's topUp → spend
  // works. Production must state the card horizon, the anchor every other rail defaults to.
  const cardHorizonMs = readInt(env.MATURITY_HORIZON_CARD_MS, 0);

  return {
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
    // 1,000 credits an hour: small enough that the velocity demos can trip the gate.
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
    ...bigIntListIfSet('topUpBundlesMinor', env.TOP_UP_BUNDLES_MINOR),
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
    dbPoolMax: readIntOrNull(env.DB_POOL_MAX),
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
 * The resolved {@link Config} a given env produces, with `overrides` applied on top — the same
 * derivation openPorts runs, so an override-supplied policy anchor satisfies the production
 * check. Config carries no secrets, so the result is safe to print whole.
 */
export function inspectConfig(
  env: EnvMap = {},
  overrides: Partial<Config> = {},
): Config {
  const missing = missingPolicyAnchors(env, overrides);
  if (missing.length > 0) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Required configuration is missing.',
      {
        detail: { missing },
      },
    );
  }
  return mergeConfig(buildConfig(env), overrides);
}

/**
 * The config slice for a scheduled maintenance window, ready to spread into a PortsInit config:
 * `{ config: maintenanceWindow(start, end) }`. Bounds are epoch ms; end is exclusive.
 */
export function maintenanceWindow(
  startMs: number,
  endMs: number,
): Pick<Config, 'pauseStartMs' | 'pauseEndMs'> {
  return { pauseStartMs: startMs, pauseEndMs: endMs };
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
