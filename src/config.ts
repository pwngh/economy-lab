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
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/configuration/ Configuration} for every tunable and its default.
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

  /** Delivery attempts an outbox message gets before the relay dead-letters it (status 'failed'), so a poison event can't wedge the queue. Dead-letters once `attempts` reaches this cap. */
  maxOutboxAttempts: number;

  /** Apply attempts an inbox event gets before the apply worker dead-letters it (status 'dead'), so a poison inbound event can't wedge the queue. Dead-letters once `attempts` reaches this cap. The inbound mirror of `maxOutboxAttempts`. */
  maxInboxAttempts: number;

  /** Consecutive retryable renewal failures before the renewal sweep lapses a subscription instead of re-billing forever. Lapses once `attempts` reaches this cap. */
  maxSubscriptionAttempts: number;

  /** Longest (ms) a payout may sit in SUBMITTED before the worker force-fails it as timed out (provider never reported back). Distinct from `payoutSla.SUBMITTED`, which only schedules the next settle check. */
  maxPayoutAgeMs: number;

  /** Platform's cut in basis points (hundredths of a percent); 10000 = 100%, 1530 = 15.3%. */
  platformFeeBps: number;

  /** Payout-rail fee in basis points, charged on the USD a creator cashes out (≈1.5%, varies by
   *  destination). This is the payout processor's own cut (e.g. PayPal's), deducted from the
   *  disbursement so the creator receives the net; it is not platform revenue. */
  payoutFeeBps: number;

  /** Most a user may spend within one window before the risk check steps in, in CREDIT minor units. */
  velocityLimitMinor: bigint;

  /** Length (ms) of the rolling spending window for `velocityLimitMinor`. Only a subject's attempts
   *  within the last `velocityWindowMs` count toward the limit; each ages out once older than the window. */
  velocityWindowMs: number;

  /**
   * How long (ms) topped-up funds must wait before they can be spent or paid out, keyed by
   * funding source ("card", "crypto"). Sources not listed use the "default" entry.
   */
  maturityHorizonMs: Record<string, number>;

  /** Time budget (ms) per payout-processing step, keyed by state name (PENDING, SUBMITTED). A background worker uses these to decide when a step has been stuck too long. */
  payoutSla: Record<string, number>;

  /**
   * Smallest payout a user may request, counted only against earned CREDIT (not bought or
   * promo-granted), in minor units. The floor keeps tiny disbursements from costing more in rail
   * fees than they pay out. Default 20,000 credits (≈$100).
   */
  payoutMinimumEarnedMinor: bigint;

  /** Min time (ms) between payout requests. Defaults to 24h to match the live docs; the legal requirement is 14 days (1_209_600_000). */
  payoutMinIntervalMs: number;

  /**
   * Optional scheduled maintenance window (epoch ms) during which end-user discretionary writes are
   * refused with a clean ECONOMY_PAUSED decline. Both bounds must be set for the pause to be active;
   * it holds when `pauseStartMs <= now < pauseEndMs`. Settlement (actor 'system') and operator fixes
   * are never gated, and reads never reach the gate. Either bound null means no window is configured.
   */
  pauseStartMs: number | null;
  pauseEndMs: number | null;
}

// True in production, where a missing secret must fail rather than default to empty string.
function isProduction(env: EnvMap): boolean {
  return env.NODE_ENV === 'production';
}

// Raw environment: variable names to string values (or undefined if unset).
type EnvMap = Record<string, string | undefined>;

/**
 * Build {@link Config} from env vars, defaulting any value that is unset or invalid.
 *
 * If any required secret is missing in production, throws a single CONFIG.INVALID fault
 * listing all missing keys at once, so the program fails at startup rather than one key
 * at a time during requests.
 */
export function loadConfig(env: EnvMap): Config {
  let cardHorizonMs = toInt(env.MATURITY_HORIZON_CARD_MS, 7 * 24 * 60 * 60_000);
  let production = isProduction(env);

  let webhookSecret = required(
    env.WEBHOOK_SECRET,
    'WEBHOOK_SECRET',
    production,
  );
  let signingSecret = required(
    env.SIGNING_SECRET,
    'SIGNING_SECRET',
    production,
  );

  let missing = [webhookSecret, signingSecret]
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
    // One day: a payout stuck in SUBMITTED longer than this is force-failed as timed out.
    maxPayoutAgeMs: toInt(env.MAX_PAYOUT_AGE_MS, 24 * 60 * 60_000),
    // Default is an example marketplace transaction fee of about 15.3%.
    platformFeeBps: toInt(env.PLATFORM_FEE_BPS, 1530),
    payoutFeeBps: toInt(env.PAYOUT_FEE_BPS, 150),
    velocityLimitMinor: toBigInt(env.VELOCITY_LIMIT_MINOR, 100_000n),
    velocityWindowMs: toInt(env.VELOCITY_WINDOW_MS, 60 * 60_000),
    maturityHorizonMs: {
      card: cardHorizonMs,
      crypto: toInt(env.MATURITY_HORIZON_CRYPTO_MS, 24 * 60 * 60_000),
      // Fallback for unlisted funding sources; defaults to the card horizon (the longest under the
      // shipped defaults; overridable via MATURITY_HORIZON_DEFAULT_MS).
      default: toInt(env.MATURITY_HORIZON_DEFAULT_MS, cardHorizonMs),
    },
    payoutSla: {
      PENDING: toInt(env.SLA_PENDING_MS, 30_000),
      SUBMITTED: toInt(env.SLA_SUBMITTED_MS, 120_000),
      DEFAULT: toInt(env.SLA_DEFAULT_MS, 60_000),
    },
    payoutMinimumEarnedMinor: toBigInt(env.PAYOUT_MIN_EARNED_MINOR, 2_000_000n),
    payoutMinIntervalMs: toInt(env.PAYOUT_MIN_INTERVAL_MS, 24 * 60 * 60_000),
    // Optional maintenance window. Unset or non-integer leaves the bound null (no pause); both must
    // parse for the window to be active. Validated like the other numeric tunables (toInt's range
    // check), only falling to null instead of a numeric default.
    pauseStartMs: toIntOrNull(env.ECONOMY_PAUSE_START_MS),
    pauseEndMs: toIntOrNull(env.ECONOMY_PAUSE_END_MS),
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
  let { pauseStartMs, pauseEndMs } = config;
  if (pauseStartMs === null || pauseEndMs === null) {
    return false;
  }
  return pauseStartMs <= now && now < pauseEndMs;
}

// Check one required value. Reports absence via a `missing` flag instead of throwing, so
// loadConfig can collect and report all missing keys together. Empty values are tolerated
// outside production but count as missing in production.
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

// Parse an integer, returning the fallback when unset or not a valid whole number, so a
// bad override can never leave the config partly applied.
function toInt(value: string | undefined, fallback: number): number {
  let parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Parse an optional integer tunable, returning null (not a numeric fallback) when unset or not a
// valid whole number. Used for the pause-window bounds, where "absent" must stay distinct from any
// real epoch value so a missing bound leaves the window inactive rather than defaulting to one.
function toIntOrNull(value: string | undefined): number | null {
  let parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Parse a bigint (for minor-unit amounts that can exceed 2^53, the largest exact JS number).
// Returns the fallback unless the value is a string of digits.
function toBigInt(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  return BigInt(value);
}
