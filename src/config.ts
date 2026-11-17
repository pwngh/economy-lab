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

import { ERROR_CODES, EconomyError, fault } from '#src/errors.ts';
import {
  isProduction,
  readBigInt,
  readBigIntOrNull,
  readFlag,
  readInt,
  readIntOrNull,
  readList,
  withinIntBounds,
} from '#src/env.ts';

import type { EnvMap, IntBounds } from '#src/env.ts';

/**
 * All tunable policy settings in one object. It holds policy only, no secrets, so the whole
 * object is safe to log. Credentials ride in {@link Secrets}.
 *
 * No module reads env vars itself. The startup program builds this once (via
 * {@link loadConfig}) and passes it in — a misconfigured deploy fails at startup
 * rather than deep inside a request.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration}
 *   for every tunable and its default.
 */
export interface Config {
  /** Max clock skew (ms) the HTTP service accepts on an inbound webhook's `x-timestamp`. Default 5
   *  minutes. This bounds staleness, not replay: the timestamp rides in a header the provider's
   *  signature does not cover, so inside the window the identical signed delivery replays. The
   *  replay defence is `ServerOptions.replay` claiming the provider's event id. */
  freshnessWindowMs: number;

  /** Retryable-failure cap on a payout saga. At this many attempts the worker stops
   *  resubmitting, marks the saga FAILED, and returns the reserved credits to the seller's
   *  earned account. Default 5. */
  maxPayoutAttempts: number;

  /** Delivery-attempt cap per outbox event. The relay dead-letters the event when it is
   *  reached. Default 10. */
  maxOutboxAttempts: number;

  /** Processing-attempt cap per inbound webhook. The inbox sweep dead-letters the row when it
   *  is reached or the failure is not retryable. Default 10. */
  maxInboxAttempts: number;

  /** Failed-renewal cap per subscription. At this many attempts the sweep lapses the
   *  subscription instead of re-billing it. Default 10. */
  maxSubscriptionAttempts: number;

  /** Force-fail deadline (ms) for a SUBMITTED payout — unlike `payoutSla.SUBMITTED`, which only
   *  schedules the next settle check. */
  maxPayoutAgeMs: number;

  /** Platform's cut in basis points (hundredths of a percent). 10000 = 100%, 1530 = 15.3%. */
  platformFeeBps: number;

  /** Payout-rail fee in basis points. This is the processor's own cut, deducted from the
   *  disbursement so the seller receives the net. It is not platform revenue. */
  payoutFeeBps: number;

  /** The single-knob velocity ceiling (CREDIT minor units). Both window classes fall back to it
   *  unless their own limit below is set. The default is demo-scale. Production must state it. */
  velocityLimitMinor: bigint;

  /** Ceiling for the inflow window (topUp, grantPromo) — card testing fills this one. Unset
   *  means `velocityLimitMinor`. */
  velocityInflowLimitMinor?: bigint;

  /** Ceiling for the outflow window (spend, subscribe, requestPayout) — a drained wallet fills
   *  this one. Unset means `velocityLimitMinor`. */
  velocityOutflowLimitMinor?: bigint;

  /** Length (ms) of the velocity window. The store captures it at construction, so changing it
   *  means a rebuild over the same store. The config object is frozen for exactly this reason. */
  velocityWindowMs: number;

  /** Smallest subscription price, in CREDIT minor units. Subscribe refuses a price outside the
   *  band. The band keeps a typo'd price from silently binding a buyer. */
  subscriptionPriceMinMinor: bigint;

  /** Largest subscription price, in CREDIT minor units. */
  subscriptionPriceMaxMinor: bigint;

  /** The purchase catalog, listing the only top-up amounts accepted, in CREDIT minor units.
   *  Stores sell credits in fixed bundles. A deployment that mirrors its store sets the same
   *  list, so a mispriced grant fails at submit. Unset means any positive amount. */
  topUpBundlesMinor?: readonly bigint[];

  /**
   * How long (ms) topped-up funds must wait before they can be spent or paid out, keyed by
   * funding source ("card", "crypto", "steam", "meta"). Unlisted sources use "default".
   */
  maturityHorizonMs: Record<string, number>;

  /**
   * Time budget (ms) per payout-processing step. The worker uses it to schedule when it next
   * examines a saga. `PENDING` delays the first submit pass after a request, `SUBMITTED` delays
   * the next check on a submitted payout, and `DEFAULT` covers either when unset.
   */
  payoutSla: Record<string, number>;

  /** Smallest payout a user may request, counted only against earned CREDIT — never bought or
   *  promo-granted. */
  payoutMinimumEarnedMinor: bigint;

  /**
   * Minimum wait (ms) since the user's latest payout saga update, in any state. Processing a
   * payout can restart this wait. The default is 24 hours; zero disables the cooldown.
   */
  payoutMinIntervalMs: number;

  /**
   * Start of the scheduled maintenance window (epoch ms). While
   * `pauseStartMs <= now < pauseEndMs`, end-user discretionary writes decline as ECONOMY_PAUSED.
   * Either bound null means no window.
   * Settlement (actor 'system'), operator fixes, and reads are never gated.
   */
  pauseStartMs: number | null;
  /** The window's exclusive end (epoch ms). See `pauseStartMs` for the gate. */
  pauseEndMs: number | null;

  /**
   * Max connections in the SQL engine's pool (`DB_POOL_MAX`). Null keeps each driver's default
   * of 10. Excess concurrent submits queue for a connection. A transaction holds exactly one
   * connection for its whole life, so the queue always drains.
   */
  dbPoolMax: number | null;

  /**
   * How long the SQL engine waits for a connection before it fails (`DB_CONNECT_TIMEOUT_MS`).
   * Null keeps each engine's bounded default of 10s. It also bounds the wait for a free pool
   * connection, so set it above the slowest transaction, never below.
   */
  dbConnectTimeoutMs: number | null;

  /**
   * Rows each hot platform account is split across. Shard 0 keeps the bare id, so raising the
   * count later is safe. Only ever lower it back to 1.
   */
  platformShards: number;

  /**
   * The accrual split (`ACCRUAL_DRAIN=1`). When on, spend and subscribe park seller shares on a
   * SETTLEMENT_ACCRUAL shard, and the worker's drain sweep moves them to `earned` in batches.
   * Concurrent buyers of one seller then stop serializing on that seller's row. Off (the
   * default) posts exactly today's legs. Meant to run with `platformShards >= 2`.
   */
  accrualDrain: boolean;
}

// The submit pipeline's per-operation amount ceiling. A bundle above it could never be bought.
const MAX_BUNDLE_MINOR = 1_000_000_000_000_000n;

// Parses a comma-separated list of positive minor-unit counts. A malformed entry throws rather
// than defaulting, because a silent fallback here would be an unenforced catalog, not a safe
// value. The list is deduped, sorted, and frozen, so the stored catalog reads in bundle order
// and cannot be mutated later.
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
      // The env name rides in the detail so preflight can report the fault against the knob the
      // operator edits rather than against the config as a whole.
      { detail: { key: 'TOP_UP_BUNDLES_MINOR', value }, retryable: false },
    );
  }
  const bundles = Object.freeze(
    [...new Set(entries.map(BigInt))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
  return { [key]: bundles };
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

/**
 * How one {@link Config} knob is read and what values it admits.
 *
 * Stated once and read four ways: {@link buildConfig} hands each row's bounds to the env reader,
 * {@link configIssues} refuses a supplied value outside them, the same function reports an env
 * value the reader silently discarded, and {@link CONFIG_KEYS} is the row's env names. Keyed by
 * `keyof Config`, so a knob added to the interface leaves the table short a key and fails the
 * typecheck.
 */
interface Knob {
  /** The env name that sets it, or one name per member for a record-valued knob. */
  readonly env: string | Readonly<Record<string, string>>;
  /** Integer bounds, applied exactly as {@link readInt} applies them. On a record-valued knob
   *  they bound every member. */
  readonly int?: IntBounds;
  /** Minor-unit bounds, for a knob carried as a bigint or as a list of them. */
  readonly big?: {
    readonly min: bigint;
    readonly max?: bigint;
    readonly list?: true;
  };
  /** The knob is a boolean. */
  readonly flag?: true;
  /** The knob is a record of integers. */
  readonly record?: true;
  /** Null is this knob's "off". */
  readonly nullable?: true;
  /** The knob may be left out of a Config entirely. */
  readonly absent?: true;
}

// The row order is the order CONFIG_KEYS publishes, since that list is derived from it.
const KNOBS = {
  // Max 24h, the one window in this table where a larger value weakens a check rather than
  // tightening or deferring one. It tolerates clock skew on a header no signature covers, so a day
  // admits the worst real misconfiguration — a host a whole time zone out — and refuses a window
  // that is no longer skew tolerance: past the current epoch every timestamp is fresh and the gate
  // is off.
  freshnessWindowMs: {
    env: 'FRESHNESS_WINDOW_MS',
    int: { max: 24 * 60 * 60_000 },
  },
  maxPayoutAttempts: { env: 'MAX_PAYOUT_ATTEMPTS', int: { min: 1 } },
  maxOutboxAttempts: { env: 'MAX_OUTBOX_ATTEMPTS', int: { min: 1 } },
  maxInboxAttempts: { env: 'MAX_INBOX_ATTEMPTS', int: { min: 1 } },
  maxSubscriptionAttempts: {
    env: 'MAX_SUBSCRIPTION_ATTEMPTS',
    int: { min: 1 },
  },
  maxPayoutAgeMs: { env: 'MAX_PAYOUT_AGE_MS' },
  platformFeeBps: { env: 'PLATFORM_FEE_BPS', int: { max: 10_000 } },
  payoutFeeBps: { env: 'PAYOUT_FEE_BPS', int: { max: 10_000 } },
  velocityLimitMinor: { env: 'VELOCITY_LIMIT_MINOR', big: { min: 0n } },
  velocityInflowLimitMinor: {
    env: 'VELOCITY_INFLOW_LIMIT_MINOR',
    big: { min: 0n },
    absent: true,
  },
  velocityOutflowLimitMinor: {
    env: 'VELOCITY_OUTFLOW_LIMIT_MINOR',
    big: { min: 0n },
    absent: true,
  },
  velocityWindowMs: { env: 'VELOCITY_WINDOW_MS', int: { min: 1 } },
  subscriptionPriceMinMinor: {
    env: 'SUBSCRIPTION_PRICE_MIN_MINOR',
    big: { min: 0n },
  },
  subscriptionPriceMaxMinor: {
    env: 'SUBSCRIPTION_PRICE_MAX_MINOR',
    big: { min: 0n },
  },
  topUpBundlesMinor: {
    env: 'TOP_UP_BUNDLES_MINOR',
    big: { min: 1n, max: MAX_BUNDLE_MINOR, list: true },
    absent: true,
  },
  maturityHorizonMs: {
    env: {
      card: 'MATURITY_HORIZON_CARD_MS',
      crypto: 'MATURITY_HORIZON_CRYPTO_MS',
      steam: 'MATURITY_HORIZON_STEAM_MS',
      meta: 'MATURITY_HORIZON_META_MS',
      default: 'MATURITY_HORIZON_DEFAULT_MS',
    },
    record: true,
  },
  payoutSla: {
    env: {
      PENDING: 'SLA_PENDING_MS',
      SUBMITTED: 'SLA_SUBMITTED_MS',
      DEFAULT: 'SLA_DEFAULT_MS',
    },
    record: true,
  },
  payoutMinimumEarnedMinor: {
    env: 'PAYOUT_MIN_EARNED_MINOR',
    big: { min: 0n },
  },
  payoutMinIntervalMs: { env: 'PAYOUT_MIN_INTERVAL_MS' },
  pauseStartMs: { env: 'ECONOMY_PAUSE_START_MS', nullable: true },
  pauseEndMs: { env: 'ECONOMY_PAUSE_END_MS', nullable: true },
  platformShards: { env: 'PLATFORM_SHARDS', int: { min: 1 } },
  accrualDrain: { env: 'ACCRUAL_DRAIN', flag: true },
  dbPoolMax: { env: 'DB_POOL_MAX', nullable: true },
  // Min 1: a 0 would read as "no timeout" to both drivers, the very hang this knob bounds.
  dbConnectTimeoutMs: {
    env: 'DB_CONNECT_TIMEOUT_MS',
    int: { min: 1 },
    nullable: true,
  },
} as const satisfies Readonly<Record<keyof Config, Knob>>;

// The table with its literal types dropped, for the readers that take any row.
const rowOf = (knob: keyof Config): Knob => KNOBS[knob];

// The bounds a knob is read under, so the env reader below and the supplied-value check share one
// statement of each.
function boundsOf(knob: keyof Config): IntBounds | undefined {
  return rowOf(knob).int;
}

/** One knob's env name, or one per member for a record-valued knob. */
type EnvNamesOf<K> = K extends { readonly env: infer E }
  ? E extends string
    ? E
    : E[keyof E]
  : never;

/** Every name {@link loadConfig} reads, and the union of them. */
export type ConfigKey = 'NODE_ENV' | EnvNamesOf<(typeof KNOBS)[keyof Config]>;

/**
 * Every name {@link loadConfig} reads: `NODE_ENV`, then the env name on each {@link KNOBS} row.
 * .env.example is held to this list, so a knob added to the table arrives documented or turns the
 * env-surface gate red. It holds policy names only; the secret names live in {@link SECRET_KEYS}.
 */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  'NODE_ENV',
  ...Object.values(KNOBS).flatMap((knob) =>
    typeof knob.env === 'string' ? [knob.env] : Object.values(knob.env),
  ),
] as ConfigKey[];

/**
 * Names {@link loadConfig} once read, each mapped to the name that replaced it. Nothing reads a
 * retired name, so a deploy that still sets one gets the default silently — `preflight` reports it
 * instead. Kept out of {@link CONFIG_KEYS} on purpose: `.env.example` is held to that list, and a
 * retired name must not be documented as a knob.
 */
export const RETIRED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  // Renamed in 0.8.0. The window bounds clock skew on an unsigned header, never replay.
  REPLAY_WINDOW_MS: 'FRESHNESS_WINDOW_MS',
};

/** The retired names `env` still sets, paired with what to set instead. */
export function retiredConfigKeys(env: EnvMap): [string, string][] {
  return Object.entries(RETIRED_CONFIG_KEYS).filter(
    ([name]) => (env[name] ?? '') !== '',
  );
}

/** Every name `loadSecrets` reads. Kept apart from {@link CONFIG_KEYS} so the log-safe
 * policy list can never grow a credential. */
export const SECRET_KEYS = [
  'WEBHOOK_SECRET',
  'SIGNING_SECRET',
  'SIGNING_SECRETS_PRIOR',
] as const;

/** Boolean flags (1/true) that declare a production deployment runs without the named optional
 * port on purpose. openPorts treats a bare omission as an error. */
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
 * Build {@link Secrets} from env vars, any `overrides` winning per field.
 *
 * In production a blank required secret on the merged bag throws one CONFIG.INVALID fault
 * listing every missing key.
 *
 * Outside production a blank stays blank, and the construction layer supplies its dev stand-in.
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

/** The required secret env names still blank on a merged bag. `preflight` reports these. */
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
 * production, this throws a single CONFIG.INVALID fault listing all missing keys at once. The
 * program then fails at startup rather than one key at a time during requests.
 */
export function loadConfig(env: EnvMap): Config {
  return inspectConfig(env);
}

/**
 * The production policy-anchor env names satisfied by neither `env` nor `overrides`. The list
 * is empty outside production. `preflight` reports these. {@link inspectConfig} throws on them.
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
  const horizon = boundsOf('maturityHorizonMs');
  const sla = boundsOf('payoutSla');
  const cardHorizonMs = readInt(env.MATURITY_HORIZON_CARD_MS, 0, horizon);

  return {
    freshnessWindowMs: readInt(
      env.FRESHNESS_WINDOW_MS,
      5 * 60_000,
      boundsOf('freshnessWindowMs'),
    ),
    maxPayoutAttempts: readInt(
      env.MAX_PAYOUT_ATTEMPTS,
      5,
      boundsOf('maxPayoutAttempts'),
    ),
    maxOutboxAttempts: readInt(
      env.MAX_OUTBOX_ATTEMPTS,
      10,
      boundsOf('maxOutboxAttempts'),
    ),
    maxInboxAttempts: readInt(
      env.MAX_INBOX_ATTEMPTS,
      10,
      boundsOf('maxInboxAttempts'),
    ),
    maxSubscriptionAttempts: readInt(
      env.MAX_SUBSCRIPTION_ATTEMPTS,
      10,
      boundsOf('maxSubscriptionAttempts'),
    ),
    // The default is three days. Real payout rails settle in one to two business days, so the
    // force-fail backstop must outlast a weekend-adjacent settlement, not race it.
    maxPayoutAgeMs: readInt(
      env.MAX_PAYOUT_AGE_MS,
      72 * 60 * 60_000,
      boundsOf('maxPayoutAgeMs'),
    ),

    platformFeeBps: readInt(
      env.PLATFORM_FEE_BPS,
      1530,
      boundsOf('platformFeeBps'),
    ),
    payoutFeeBps: readInt(env.PAYOUT_FEE_BPS, 150, boundsOf('payoutFeeBps')),
    // The default is 1,000 credits an hour, small enough that the velocity demos can trip the gate.
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
    velocityWindowMs: readInt(
      env.VELOCITY_WINDOW_MS,
      60 * 60_000,
      boundsOf('velocityWindowMs'),
    ),
    maturityHorizonMs: {
      card: cardHorizonMs,
      // Every other rail defaults to the card horizon, the conservative anchor. A deployment
      // that knows a rail's real refund window overrides it per rail.
      crypto: readInt(env.MATURITY_HORIZON_CRYPTO_MS, cardHorizonMs, horizon),
      steam: readInt(env.MATURITY_HORIZON_STEAM_MS, cardHorizonMs, horizon),
      meta: readInt(env.MATURITY_HORIZON_META_MS, cardHorizonMs, horizon),
      // Fallback for unlisted funding sources.
      default: readInt(env.MATURITY_HORIZON_DEFAULT_MS, cardHorizonMs, horizon),
    },
    payoutSla: {
      PENDING: readInt(env.SLA_PENDING_MS, 30_000, sla),
      SUBMITTED: readInt(env.SLA_SUBMITTED_MS, 120_000, sla),
      DEFAULT: readInt(env.SLA_DEFAULT_MS, 60_000, sla),
    },
    payoutMinimumEarnedMinor: readBigInt(
      env.PAYOUT_MIN_EARNED_MINOR,
      2_000_000n,
    ),
    payoutMinIntervalMs: readInt(
      env.PAYOUT_MIN_INTERVAL_MS,
      24 * 60 * 60_000,
      boundsOf('payoutMinIntervalMs'),
    ),
    pauseStartMs: readIntOrNull(
      env.ECONOMY_PAUSE_START_MS,
      boundsOf('pauseStartMs'),
    ),
    pauseEndMs: readIntOrNull(env.ECONOMY_PAUSE_END_MS, boundsOf('pauseEndMs')),
    dbPoolMax: readIntOrNull(env.DB_POOL_MAX, boundsOf('dbPoolMax')),
    dbConnectTimeoutMs: readIntOrNull(
      env.DB_CONNECT_TIMEOUT_MS,
      boundsOf('dbConnectTimeoutMs'),
    ),
    platformShards: readInt(env.PLATFORM_SHARDS, 1, boundsOf('platformShards')),
    accrualDrain: readFlag(env.ACCRUAL_DRAIN),
  };
}

/**
 * Builds the default {@link Config} without an environment. It returns the exact values
 * {@link loadConfig} derives from an empty env, with any knobs in `overrides` applied on top
 * ({@link mergeConfig} semantics). Tests and the in-memory quickstart use it to get a Config in
 * hand without assembling an {@link EnvMap}.
 *
 * @example
 * const config = defaultConfig({
 *   platformFeeBps: 3000,
 *   maturityHorizonMs: { card: 7 * 24 * 60 * 60_000 }, // the other rails keep their defaults
 * });
 */
export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return mergeConfig(loadConfig({}), overrides);
}

/**
 * Applies `overrides` on top of `base`, last-wins per knob. The record-valued knobs
 * (`maturityHorizonMs`, `payoutSla`) instead merge one level deep. Overriding one funding source
 * or one SLA step therefore keeps the others instead of replacing the whole record.
 *
 * An override outside its knob's bounds throws CONFIG.INVALID naming the knob and the range. This
 * is the one refusal point every supplied config reaches: `defaultConfig`, `inspectConfig`,
 * `memoryPorts` and `openPorts` all merge through here. The environment reader defaults such a
 * value instead — see {@link configIssues} for why the two paths part.
 */
export function mergeConfig(base: Config, overrides: Partial<Config>): Config {
  assertSuppliedConfig(overrides);
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
 * Returns the resolved {@link Config} a given env produces, with `overrides` applied on top.
 *
 * This is the same derivation openPorts runs, so an override-supplied policy anchor satisfies
 * the production check.
 *
 * Config carries no secrets, so the result is safe to print whole.
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

// --- Knob checking ------------------------------------------------------------------

/** One thing wrong with a config, ready to become a `preflight` row. */
export interface ConfigIssue {
  /** The knob at fault: the env name for an env row, the {@link Config} field for a supplied one. */
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

/**
 * Everything wrong with a config before anything is built, from the one bounds table: a supplied
 * knob outside the bounds {@link buildConfig} applies to the same knob, an env value
 * {@link loadConfig} would throw on, and an env value it silently discards.
 *
 * The first two are errors — `openPorts` refuses on both. The third is a warning: the env reader
 * substitutes its documented default rather than failing, so the deployment is servable, but until
 * it is reported the deployment runs on a value nobody chose.
 *
 * A supplied knob is refused rather than defaulted, and that asymmetry is deliberate. A string in
 * a deploy file has a fallback because the alternative is a crash loop on a typo an operator
 * cannot see parsed. A knob written in code is different: substituting 15.3% for a caller who
 * asked for 999.99% moves money at a rate nobody chose, in silence, forever.
 */
export function configIssues(
  env: EnvMap = {},
  supplied: Partial<Config> = {},
): ConfigIssue[] {
  return [
    ...suppliedIssues(supplied),
    ...envFaultIssues(env),
    ...ignoredEnvIssues(env),
  ];
}

declare const checked: unique symbol;

/**
 * A {@link Config} whose every knob has been held to its bounds. {@link checkedConfig} is the only
 * mint, and the money path's own context bundles accept nothing else, so a new way into the
 * economy that hands a handler a finished config fails to compile rather than posting at a rate
 * nobody chose.
 */
export type CheckedConfig = Config & { readonly [checked]: true };

/**
 * Holds a finished {@link Config} to the bounds {@link mergeConfig} holds an override to, and
 * returns it as the type the money path accepts. Throws CONFIG.INVALID naming the knob and the
 * range.
 *
 * `mergeConfig` covers every door that BUILDS a config. This is what a door that takes a finished
 * one runs: `Ports.config` is a structural field of a published bag, so a hand-built bag reaches
 * the ledger without ever meeting `mergeConfig`.
 */
export function checkedConfig(config: Config): CheckedConfig {
  assertSuppliedConfig(config);
  return config as CheckedConfig;
}

// The refusal openPorts, defaultConfig and memoryPorts all reach through mergeConfig. preflight
// raises the same rows off the same function, so the deploy-time report and the boot-time refusal
// cannot drift.
function assertSuppliedConfig(supplied: Partial<Config>): void {
  const found = suppliedIssues(supplied);
  if (found.length === 0) {
    return;
  }
  throw fault(
    ERROR_CODES.CONFIG_INVALID,
    found.map((one) => one.message).join(' '),
    { detail: { knobs: found.map((one) => one.path) }, retryable: false },
  );
}

function suppliedIssues(supplied: Partial<Config>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const name of Object.keys(KNOBS) as (keyof Config)[]) {
    if (!(name in supplied)) {
      continue;
    }
    const found = knobFault(name, KNOBS[name], supplied[name]);
    if (found !== null) {
      issues.push({ path: name, message: found, severity: 'error' });
    }
  }
  return issues;
}

// The fault loadConfig would throw on this env. Only the purchase catalog refuses rather than
// defaults, and without this row a deploy gate calls clean an environment the boot then refuses.
function envFaultIssues(env: EnvMap): ConfigIssue[] {
  try {
    buildConfig(env);
    return [];
  } catch (error) {
    const key = EconomyError.is(error) ? error.detail.key : undefined;
    return [
      {
        path: typeof key === 'string' ? key : 'config',
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
      },
    ];
  }
}

// Every env name set to a value the reader threw away for its default.
function ignoredEnvIssues(env: EnvMap): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const knob of Object.values(KNOBS)) {
    for (const name of typeof knob.env === 'string'
      ? [knob.env]
      : Object.values(knob.env)) {
      const raw = env[name];
      if (raw === undefined || raw.trim() === '') {
        continue;
      }
      const wanted = envShapeWanted(knob, raw);
      if (wanted !== null) {
        issues.push({
          path: name,
          message: `${name} is ${JSON.stringify(raw)}, which is not ${wanted}; loadConfig ignores it and uses its default.`,
          severity: 'warning',
        });
      }
    }
  }
  return issues;
}

// What the reader wanted of an env value it discarded, or null when it kept the value. The
// purchase catalog is absent on purpose: it throws, and envFaultIssues carries it.
function envShapeWanted(knob: Knob, raw: string): string | null {
  if (knob.flag === true) {
    // On is readFlag's own rule; off is the two spellings that say so deliberately. Anything
    // else read as off without being one, which is the value nobody was told about.
    return readFlag(raw) || ['0', 'false'].includes(raw)
      ? null
      : '1, true, 0 or false';
  }
  if (knob.big?.list === true) {
    return null;
  }
  if (knob.big !== undefined) {
    return readBigIntOrNull(raw) === null ? bigRange(knob.big) : null;
  }
  return readIntOrNull(raw, knob.int) === null ? intRange(knob.int) : null;
}

// The fault in one supplied knob's value, or null.
function knobFault(name: string, knob: Knob, value: unknown): string | null {
  const path = `config.${name}`;
  if (value === undefined) {
    return knob.absent === true
      ? null
      : `${path} was set to undefined; leave the knob out to keep the default.`;
  }
  if (value === null) {
    return knob.nullable === true ? null : `${path} must not be null.`;
  }
  if (knob.flag === true) {
    return mustBe(path, 'true or false', value, typeof value === 'boolean');
  }
  if (knob.record === true) {
    return recordFault(path, knob, value);
  }
  if (knob.big !== undefined) {
    return knob.big.list === true
      ? listFault(path, knob.big, value)
      : mustBe(path, bigRange(knob.big), value, bigOk(knob.big, value));
  }
  return intFault(path, knob.int, value);
}

/**
 * The fault in one integer knob's value, or null. Exported because the supervisor states its own
 * knob table over a different config, and the rule a caller is held to has to read the same on
 * both — one statement of it, not two that can drift.
 */
export function intFault(
  path: string,
  bounds: IntBounds | undefined,
  value: unknown,
): string | null {
  return mustBe(
    path,
    intRange(bounds),
    value,
    typeof value === 'number' && withinIntBounds(value, bounds),
  );
}

function recordFault(path: string, knob: Knob, value: unknown): string | null {
  if (typeof value !== 'object') {
    return `${path} must be an object keyed by ${typeof knob.env === 'string' ? 'name' : Object.keys(knob.env).join(', ')}; it was ${valueSeen(value)}.`;
  }
  for (const [member, held] of Object.entries(value as object)) {
    const found = intFault(`${path}.${member}`, knob.int, held);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function listFault(
  path: string,
  big: NonNullable<Knob['big']>,
  value: unknown,
): string | null {
  if (!Array.isArray(value)) {
    return `${path} must be a list of ${bigRange(big)}; it was ${valueSeen(value)}.`;
  }
  for (const [index, held] of value.entries()) {
    const found = mustBe(
      `${path}[${index}]`,
      bigRange(big),
      held,
      bigOk(big, held),
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function bigOk(big: NonNullable<Knob['big']>, value: unknown): boolean {
  return (
    typeof value === 'bigint' &&
    value >= big.min &&
    (big.max === undefined || value <= big.max)
  );
}

/**
 * The one sentence shape every knob refusal in the tree hands a caller: the path, what the knob
 * admits, and the value it was given. Exported for the supervisor's table, which bounds shapes
 * this module has no row for.
 */
export function mustBe(
  path: string,
  wanted: string,
  value: unknown,
  ok: boolean,
): string | null {
  return ok ? null : `${path} must be ${wanted}; it was ${valueSeen(value)}.`;
}

function intRange(bounds: IntBounds | undefined): string {
  const min = bounds?.min ?? 0;
  return bounds?.max === undefined
    ? `a whole number of at least ${min}`
    : `a whole number from ${min} to ${bounds.max}`;
}

function bigRange(big: NonNullable<Knob['big']>): string {
  return big.max === undefined
    ? `a bigint of at least ${big.min}`
    : `a bigint from ${big.min} to ${big.max}`;
}

// Renders a refused value for its message. A bigint keeps its n so the reader can see the value
// was the right kind and the wrong size, and a container is named rather than dumped.
function valueSeen(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && value !== null) {
    return Array.isArray(value) ? 'a list' : 'an object';
  }
  return String(value);
}

/**
 * The config slice for a scheduled maintenance window, ready to spread into a PortsInit config:
 * `{ config: maintenanceWindow(start, end) }`. Bounds are epoch ms. The end is exclusive.
 */
export function maintenanceWindow(
  startMs: number,
  endMs: number,
): Pick<Config, 'pauseStartMs' | 'pauseEndMs'> {
  return { pauseStartMs: startMs, pauseEndMs: endMs };
}

/**
 * Whether the maintenance window is active at `now`. The function is pure. It derives solely
 * from `now` and the two config bounds, so the gate and the read surface agree.
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
