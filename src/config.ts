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
  /** Secret for verifying the HMAC signature on incoming webhook/settlement messages. */
  webhookSecret: string;

  /**
   * Secret for signing checkpoints. A checkpoint hashes the ledger's current state and signs
   * it, so the signature later proves the ledger wasn't tampered with. Only the signing
   * component consumes this key.
   */
  signingSecret: string;

  /** How long (ms) a signed request stays valid; older ones are rejected as possible replays. */
  replayWindowMs: number;

  /** Max provider attempts for a single payout before the system gives up and reverses it. */
  maxPayoutAttempts: number;

  /**
   * Delivery attempts an outbox message gets before the relay dead-letters it as status 'dead'.
   * The cap stops a poison event from wedging the queue forever.
   */
  maxOutboxAttempts: number;

  /**
   * Apply attempts an inbox event gets before the apply worker dead-letters it as status 'dead'.
   * The cap stops a poison inbound event from wedging the queue forever. This is the inbound
   * mirror of `maxOutboxAttempts`.
   */
  maxInboxAttempts: number;

  /**
   * Consecutive retryable renewal failures before the renewal sweep lapses a subscription instead
   * of re-billing forever. Lapses once `attempts` reaches this cap.
   */
  maxSubscriptionAttempts: number;

  /**
   * Longest (ms) a payout may sit in SUBMITTED before the worker force-fails it as timed out,
   * meaning the provider never reported back. This differs from `payoutSla.SUBMITTED`, which only
   * schedules the next settle check.
   */
  maxPayoutAgeMs: number;

  /** Platform's cut in basis points (hundredths of a percent); 10000 = 100%, 1530 = 15.3%. */
  platformFeeBps: number;

  /** Payout-rail fee in basis points: the processor's own cut, deducted from the disbursement so
   *  the seller receives the net. Not platform revenue. */
  payoutFeeBps: number;

  /** Most a user may spend within one window before the risk check steps in, in CREDIT minor units. */
  velocityLimitMinor: bigint;

  /** Length (ms) of the rolling spending window for `velocityLimitMinor`. Only a subject's attempts
   *  from the last `velocityWindowMs` count toward the limit. */
  velocityWindowMs: number;

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

  /**
   * Smallest payout a user may request, counted only against earned CREDIT (not bought or
   * promo-granted), in minor units. The floor keeps tiny disbursements from costing more in rail
   * fees than they pay out. Default 20,000 credits (~$100).
   */
  payoutMinimumEarnedMinor: bigint;

  /**
   * Min time (ms) between payout requests. The default is 24h to match the live docs. The legal
   * requirement is 14 days (1_209_600_000).
   */
  payoutMinIntervalMs: number;

  /**
   * Optional scheduled maintenance window (epoch ms) during which end-user discretionary writes are
   * refused with a clean ECONOMY_PAUSED decline. Both bounds must be set for the pause to be active;
   * it holds when `pauseStartMs <= now < pauseEndMs`. Settlement (actor 'system') and operator fixes
   * are never gated, and reads never reach the gate. Either bound null means no window is configured.
   */
  pauseStartMs: number | null;
  pauseEndMs: number | null;

  /**
   * Rows each hot platform account is split across, so concurrent postings stop queueing on one
   * row. Default 1 = unsharded, identical to before the knob existed. Shard 0 keeps the bare id,
   * so raising the count later is safe; only ever lower it back to 1.
   */
  platformShards: number;
}

// True in production, where a missing secret must fail rather than default to empty string.
function isProduction(env: EnvMap): boolean {
  return env.NODE_ENV === 'production';
}

type EnvMap = Record<string, string | undefined>;

/**
 * Build {@link Config} from env vars, defaulting any value that is unset or invalid.
 *
 * If any required secret is missing in production, throws a single CONFIG.INVALID fault
 * listing all missing keys at once, so the program fails at startup rather than one key
 * at a time during requests.
 */
export function loadConfig(env: EnvMap): Config {
  const cardHorizonMs = toInt(
    env.MATURITY_HORIZON_CARD_MS,
    7 * 24 * 60 * 60_000,
  );
  const production = isProduction(env);

  const webhookSecret = required(
    env.WEBHOOK_SECRET,
    'WEBHOOK_SECRET',
    production,
  );
  const signingSecret = required(
    env.SIGNING_SECRET,
    'SIGNING_SECRET',
    production,
  );

  const missing = [webhookSecret, signingSecret]
    .filter((r) => r.missing)
    .map((r) => r.key);
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
    webhookSecret: webhookSecret.value,
    signingSecret: signingSecret.value,
    replayWindowMs: toInt(env.REPLAY_WINDOW_MS, 5 * 60_000),
    maxPayoutAttempts: toInt(env.MAX_PAYOUT_ATTEMPTS, 5),
    maxOutboxAttempts: toInt(env.MAX_OUTBOX_ATTEMPTS, 10),
    maxInboxAttempts: toInt(env.MAX_INBOX_ATTEMPTS, 10),
    maxSubscriptionAttempts: toInt(env.MAX_SUBSCRIPTION_ATTEMPTS, 10),
    // Three days: real payout rails settle in one to two business days, so the force-fail
    // backstop must outlast a weekend-adjacent settlement, not race it.
    maxPayoutAgeMs: toInt(env.MAX_PAYOUT_AGE_MS, 72 * 60 * 60_000),

    platformFeeBps: toInt(env.PLATFORM_FEE_BPS, 1530),
    payoutFeeBps: toInt(env.PAYOUT_FEE_BPS, 150),
    velocityLimitMinor: toBigInt(env.VELOCITY_LIMIT_MINOR, 100_000n),
    velocityWindowMs: toInt(env.VELOCITY_WINDOW_MS, 60 * 60_000),
    maturityHorizonMs: {
      card: cardHorizonMs,
      crypto: toInt(env.MATURITY_HORIZON_CRYPTO_MS, 24 * 60 * 60_000),
      // Store rails for VRChat Credits. Each defaults to the card horizon, the most
      // conservative shipped value, until the rail's real refund window is decided.
      steam: toInt(env.MATURITY_HORIZON_STEAM_MS, cardHorizonMs),
      meta: toInt(env.MATURITY_HORIZON_META_MS, cardHorizonMs),
      // Fallback for unlisted funding sources. It defaults to the card horizon, the longest of the
      // shipped defaults, and can be overridden via MATURITY_HORIZON_DEFAULT_MS.
      default: toInt(env.MATURITY_HORIZON_DEFAULT_MS, cardHorizonMs),
    },
    payoutSla: {
      PENDING: toInt(env.SLA_PENDING_MS, 30_000),
      SUBMITTED: toInt(env.SLA_SUBMITTED_MS, 120_000),
      DEFAULT: toInt(env.SLA_DEFAULT_MS, 60_000),
    },
    payoutMinimumEarnedMinor: toBigInt(env.PAYOUT_MIN_EARNED_MINOR, 2_000_000n),
    payoutMinIntervalMs: toInt(env.PAYOUT_MIN_INTERVAL_MS, 24 * 60 * 60_000),
    // Optional maintenance window. An unset or non-integer bound stays null, which means no pause, and
    // both bounds must parse for the window to be active. Each bound passes the same range check as the
    // other numeric tunables, except it falls to null instead of to a numeric default.
    pauseStartMs: toIntOrNull(env.ECONOMY_PAUSE_START_MS),
    pauseEndMs: toIntOrNull(env.ECONOMY_PAUSE_END_MS),
    platformShards: toInt(env.PLATFORM_SHARDS, 1),
  };
}

/**
 * Whether the scheduled maintenance window is active at `now`. True only when both bounds are set and
 * `pauseStartMs <= now < pauseEndMs`; either bound null (no window configured) reads as not paused.
 * Pure: derives solely from `now` and the two config bounds, so the gate and the read surface agree.
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

// Reports absence via a `missing` flag instead of throwing, so loadConfig can report all
// missing keys together. Empty values count as missing only in production.
function required(
  value: string | undefined,
  key: string,
  production: boolean,
): { key: string; value: string; missing: boolean } {
  if (value === undefined || value === '') {
    return { key, value: '', missing: production };
  }
  return { key, value, missing: false };
}

// Parses an integer, falling back when unset or invalid, so a bad override never leaves
// the config partly applied.
function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Parses an optional integer to null when unset or invalid. Absent must stay distinct from any
// real value, so a missing pause-window bound leaves the window inactive.
function toIntOrNull(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Parses a bigint for minor-unit amounts that can exceed 2^53; returns the fallback unless
// the value is a string of digits.
function toBigInt(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  return BigInt(value);
}
