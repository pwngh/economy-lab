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

import { credit as creditLeg } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM, earned } from '#src/accounts.ts';
import { feeForPrice } from '#src/pricing.ts';

import type {
  Clock,
  Digest,
  Logger,
  Meter,
  Processor,
  Rate,
  Rates,
  Signer,
} from '#src/ports.ts';
import type { Currency, Amount } from '#src/money.ts';
import type { FeePolicy, Recipient } from '#src/contract.ts';
import type { Leg } from '#src/ports.ts';
import type { Config } from '#src/config.ts';

// --- Clock & ids ------------------------------------------------------------------

/**
 * Builds a test clock whose time only moves when a test calls `advance(ms)`. The clock reports
 * `start` until then. Calling `advance(ms)` jumps the time forward by `ms` and returns the new
 * time. A manual clock keeps test runs reproducible.
 */
export function fixedClock(
  start = 0,
): Clock & { advance: (ms: number) => number } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

/**
 * Builds a deterministic id generator. It counts up from `seed` and returns `<prefix>_<n>`, for
 * example `txn_1` then `txn_2`. The ids are the same on every run.
 */
export function sequentialIds(seed = 0): { next: (prefix: string) => string } {
  let n = seed;
  return {
    next: (prefix: string) => {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

// --- Digest & signer (seeded, deterministic) --------------------------------------

// Prefixes the bytes with `seed:<seed>:` before hashing. Different seeds produce different hashes
// for the same input, and a given seed is stable across runs. The caller hashes the framed bytes
// with the platform's SHA-256, so results match across runtimes.
let ENCODER = new TextEncoder();
function withSeed(seed: number, bytes: Uint8Array): Uint8Array {
  let prefix = ENCODER.encode(`seed:${seed}:`);
  let framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.length);
  return framed;
}

/**
 * Builds a test hasher that returns the SHA-256 of the input. The seed is mixed in first, see
 * `withSeed`. It uses `crypto.subtle` rather than Node's `crypto` so the hash matches on Node, Bun,
 * and Deno.
 */
export function seededDigest(seed = 1): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', withSeed(seed, bytes)),
      ),
  };
}

/**
 * Builds a test signer that uses `seed` as a stand-in secret key. `sign` returns a SHA-256 hash
 * with the seed mixed in. `verify` re-signs the bytes and compares the result. This is not real
 * crypto. It only does enough to exercise the sign and verify path.
 */
export function seededSigner(seed = 1): Signer {
  let sign = async (bytes: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', withSeed(seed, bytes)),
    );
  return {
    sign,
    verify: async (bytes, signature) => {
      let expected = await sign(bytes);
      return equalBytes(expected, signature);
    },
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// --- Rates (fixed-point) -------------------------------------------------------------

// Three fixed CREDIT-to-USD rates, one per read site. These use round values rather than the exact
// $0.00833 acquisition rate, which is not a clean cent, so the topUp split lands on whole cents.
// `buy` is the acquisition rate a user pays per credit, $0.01, so 100 credits cost $1. `par` is the
// redemption and settlement rate the backing check uses, $0.005, so 200 credits are worth $1.
// `payout` equals `par`, the settlement rate. The gap between `buy` and `par` is 50%, which is the
// platform spread. A separate test pins a realistic ~40% spread and a creator-nets-50% outcome with
// the exact 120/200 rates. Each rate is exact integers, where the value is `rate / 10^scale`, plus
// a `rateId`. The trailing "r/s" in a `rateId` is rate over scale, not a fraction: 1/2 means
// 1·10^-2 = $0.01, and 5/3 means 5·10^-3 = $0.005.
let BUY_CREDIT: Rate = { rate: 1n, scale: 2, rateId: 'buy:CREDIT->USD:1/2' };
let PAR_CREDIT: Rate = { rate: 5n, scale: 3, rateId: 'par:CREDIT->USD:5/3' };
let PAYOUT_CREDIT: Rate = {
  rate: 5n,
  scale: 3,
  rateId: 'payout:CREDIT->USD:5/3',
};

/**
 * Builds a test rate source with buy $0.01, par $0.005, and payout $0.005. `payout` gives the
 * conversion rate for a payout. It returns the pinned CREDIT-to-USD payout rate when converting
 * CREDIT to USD, and 1-to-1 for any other pair. `par` gives the backing peg. `buy` gives the rate a
 * user pays at top-up.
 */
export function fixedRates(): Rates {
  return {
    payout: async (from, to) => {
      if (from === 'CREDIT' && to === 'USD') {
        return PAYOUT_CREDIT;
      }
      return { rate: 1n, scale: 0, rateId: `payout:${from}->${to}:1` };
    },
    par: (currency: Currency) =>
      currency === 'CREDIT'
        ? PAR_CREDIT
        : { rate: 1n, scale: 0, rateId: `par:${currency}->USD:1` },
    buy: (currency: Currency) =>
      currency === 'CREDIT'
        ? BUY_CREDIT
        : { rate: 1n, scale: 0, rateId: `buy:${currency}->USD:1` },
  };
}

// --- logger, meter, processor -----------------------------------------------------

// Builds a logger that discards every line, so tests produce no log noise.
export function testLogger(): Logger {
  return { log: () => {} };
}

// Builds a metrics sink that records nothing. It exists so code that emits metrics has something to
// call.
export function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

/**
 * Builds a fake payment provider. It approves every payout and returns a predictable reference,
 * `prov_<key>`, instead of calling a real provider.
 */
export function fakeProcessor(): Processor {
  return {
    submitPayout: async (input) => ({ providerRef: `prov_${input.key}` }),
  };
}

// --- Pricing (a flat-percentage split, expressed in basis points) -----------------

// Returns `bps` basis points (hundredths of a percent) of `minor`, rounded down, as `minor * bps /
// 10000`. The math stays in bigint so large totals stay exact. A JS number would lose precision at
// that size.
function applyBps(minor: bigint, bps: number): bigint {
  return (minor * BigInt(bps)) / 10_000n;
}

// Splits a sale's `price` into the credit legs that pay each party. It takes the platform fee off
// the top via the same `feeForPrice` that production uses, which rounds the fee up to a whole credit
// and posts it to REVENUE, so this fixture agrees with the fee that `saleOf` records. Each recipient
// gets a rounded-down share of the rest, posted to that seller's `earned` account. The rounding
// leftover goes to REVENUE along with the fee, so the legs sum to exactly `price`. This covers the
// payout legs only. The operation handler adds the matching line that debits the buyer.
function splitLegs(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): Leg[] {
  let fee = feeForPrice(price.minor, feeBps);
  let net = price.minor - fee;
  let legs: Leg[] = [];
  let distributed = 0n;
  for (let recipient of recipients) {
    let share = applyBps(net, recipient.shareBps);
    distributed += share;
    legs.push(
      creditLeg(earned(recipient.sellerId), toAmount(price.currency, share)),
    );
  }
  let residual = net - distributed;
  legs.push(
    creditLeg(SYSTEM.REVENUE, toAmount(price.currency, fee + residual)),
  );
  return legs;
}

/**
 * Builds a test fee policy that applies a flat-percentage split, see `splitLegs`. The policy is
 * stateless, so the legs depend only on the inputs.
 */
export function defaultPricing(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// --- Config -----------------------------------------------------------------------

/**
 * Builds a test config with throwaway secrets. The config tests already cover `loadConfig`'s
 * startup check for missing secrets, so placeholder values are fine here.
 */
export function testConfig(): Config {
  return {
    webhookSecret: 'test-webhook-secret',
    signingSecret: 'test-signing-secret',
    replayWindowMs: 5 * 60_000,
    maxPayoutAttempts: 5,
    maxOutboxAttempts: 10,
    maxInboxAttempts: 10,
    maxSubscriptionAttempts: 3,
    maxPayoutAgeMs: 24 * 60 * 60_000,
    platformFeeBps: 3000,
    payoutFeeBps: 150,
    velocityLimitMinor: 100_000_000n,
    velocityWindowMs: 60 * 60_000,
    maturityHorizonMs: { card: 0, crypto: 0, default: 0 },
    payoutSla: { PENDING: 30_000, SUBMITTED: 120_000, DEFAULT: 60_000 },
    payoutMinimumEarnedMinor: 0n, // this fixture sets no minimum; the minimum-payout test supplies its own
    payoutMinIntervalMs: 0,
    // No maintenance window by default; the pause test supplies its own bounds via the config override.
    pauseStartMs: null,
    pauseEndMs: null,
  };
}
