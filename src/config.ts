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
 * Every tunable setting the library needs, gathered into one object.
 *
 * No module reads environment variables on its own. The program that starts the
 * library builds this object once (via {@link loadConfig}) and passes it in, so a
 * misconfigured deploy is caught at startup instead of failing deep inside a request.
 */
export interface Config {
  /** Secret key used to verify that an incoming webhook or settlement message really came from the expected sender (it checks an HMAC signature on the request). */
  webhookSecret: string;

  /**
   * Secret key used to sign each checkpoint: a checkpoint is a snapshot that reduces the
   * whole ledger's current state to one hash and signs it, so the signature later proves the
   * ledger has not been tampered with. The signing component is this key's only consumer.
   */
  signingSecret: string;

  /** How long, in milliseconds, a signed request stays valid; older requests are rejected as possible replays. */
  replayWindowMs: number;

  /** How many times the payment provider may be tried for a single payout before the system gives up and reverses it. */
  maxPayoutAttempts: number;

  /** How many delivery attempts an outbox message gets before the relay dead-letters it (sets status 'failed'), so a poison event can't wedge the queue. The relay dead-letters once `attempts` reaches this cap. */
  maxOutboxAttempts: number;

  /** How many consecutive retryable renewal failures a subscription gets before the renewal sweep stops retrying and LAPSES it instead of re-billing forever. The sweep lapses once `attempts` reaches this cap. */
  maxSubscriptionAttempts: number;

  /** The longest, in milliseconds, a payout may sit in SUBMITTED before the worker force-fails it as timed out (the provider never reported back). Distinct from `payoutSla.SUBMITTED`, which only schedules the next settle check. */
  maxPayoutAgeMs: number;

  /** The platform's cut, in basis points (hundredths of a percent), so 10000 means 100% and 1530 means 15.3%. */
  platformFeeBps: number;

  /** The payout-rail fee, in basis points, charged on the USD a creator cashes out — VRChat's
   *  third fee point (≈1.5% for PayPal, varies by destination). It is the rail's (e.g. PayPal's)
   *  cut, deducted from the disbursement so the creator receives the net; it is NOT VRChat revenue. */
  payoutFeeBps: number;

  /** The most a user may spend within one time window before the risk check steps in, measured in CREDIT minor units (the smallest CREDIT unit). */
  velocityLimitMinor: bigint;

  /** The length of the rolling (sliding) spending window for `velocityLimitMinor`, in
   *  milliseconds: only a subject's attempts within the last `velocityWindowMs` count toward the
   *  limit, and each one ages out of the total on its own once it is older than the window. */
  velocityWindowMs: number;

  /**
   * How long topped-up funds must wait before they can be spent or paid out,
   * in milliseconds, keyed by how the money was funded (for example "card" or
   * "crypto"). A funding source not listed here uses the "default" entry.
   */
  maturityHorizonMs: Record<string, number>;

  /** Time budgets in milliseconds for each step of processing a payout, keyed by the step's state name (such as PENDING or SUBMITTED); a background worker uses these to decide when a step has been stuck too long. */
  payoutSla: Record<string, number>;

  /**
   * The smallest payout a user may request, counted only against CREDIT the user earned
   * (not credit they bought or were granted as a promotion), in minor units (the smallest
   * CREDIT unit). The default of 20,000 credits (about $100) matches VRChat's published floor.
   */
  payoutMinimumEarnedMinor: bigint;

  /** The minimum time, in milliseconds, a user must wait between payout requests. Defaults to 24h to match the live docs; the legal requirement is 14 days (1_209_600_000). */
  payoutMinIntervalMs: number;
}

// True when running in production, where a missing secret must fail rather than fall
// back to an empty-string default.
function isProduction(env: EnvMap): boolean {
  return env.NODE_ENV === 'production';
}

// The raw environment: variable names mapped to their string values (or undefined if unset).
type EnvMap = Record<string, string | undefined>;

/**
 * Build the {@link Config} from environment variables, applying a default for any
 * value that is unset or invalid.
 *
 * If any required secret is missing in production, this throws a single
 * CONFIG.INVALID fault that lists all of the missing keys at once, so the program
 * fails at startup instead of one key at a time during requests.
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
    maxSubscriptionAttempts: toInt(env.MAX_SUBSCRIPTION_ATTEMPTS, 10),
    // One day: a payout stuck in SUBMITTED longer than this is force-failed as timed out.
    maxPayoutAgeMs: toInt(env.MAX_PAYOUT_AGE_MS, 24 * 60 * 60_000),
    // Default matches VRChat's real marketplace transaction fee of about 15.3%.
    platformFeeBps: toInt(env.PLATFORM_FEE_BPS, 1530),
    payoutFeeBps: toInt(env.PAYOUT_FEE_BPS, 150),
    velocityLimitMinor: toBigInt(env.VELOCITY_LIMIT_MINOR, 100_000n),
    velocityWindowMs: toInt(env.VELOCITY_WINDOW_MS, 60 * 60_000),
    maturityHorizonMs: {
      card: cardHorizonMs,
      crypto: toInt(env.MATURITY_HORIZON_CRYPTO_MS, 24 * 60 * 60_000),
      // A funding source not listed above falls back to this entry, which itself
      // defaults to the longer (more cautious) card horizon.
      default: toInt(env.MATURITY_HORIZON_DEFAULT_MS, cardHorizonMs),
    },
    payoutSla: {
      PENDING: toInt(env.SLA_PENDING_MS, 30_000),
      SUBMITTED: toInt(env.SLA_SUBMITTED_MS, 120_000),
      DEFAULT: toInt(env.SLA_DEFAULT_MS, 60_000),
    },
    payoutMinimumEarnedMinor: toBigInt(env.PAYOUT_MIN_EARNED_MINOR, 2_000_000n),
    payoutMinIntervalMs: toInt(env.PAYOUT_MIN_INTERVAL_MS, 24 * 60 * 60_000),
  };
}

// Check one required value. Instead of throwing right away, this reports whether the
// value is missing via a `missing` flag, so loadConfig can collect all the missing
// keys and report them together. An empty value is tolerated outside production but
// counts as missing in production.
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

// Parse a value as an integer, returning the fallback when it is unset or not a valid
// whole number, so a bad override can never leave the config partly applied.
function toInt(value: string | undefined, fallback: number): number {
  let parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Parse a value as a bigint (used for minor-unit amounts that can exceed the largest
// integer a regular JavaScript number can hold exactly, 2^53). Returns the fallback
// unless the value is a string of digits.
function toBigInt(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  return BigInt(value);
}
