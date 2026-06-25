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
 * Test clock that only moves when you call `advance(ms)` (jumps forward by `ms`, returns the
 * new time). Reports `start` until then. Keeps runs reproducible.
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
 * Deterministic id generator: counts up from `seed` and returns `<prefix>_<n>` (e.g. `txn_1`,
 * `txn_2`). Same ids every run.
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

// Prefix the bytes with `seed:<seed>:` before hashing. Different seeds give different hashes for
// the same input; a given seed is stable. Hashed with the platform's SHA-256, so results match
// across runtimes.
let ENCODER = new TextEncoder();
function withSeed(seed: number, bytes: Uint8Array): Uint8Array {
  let prefix = ENCODER.encode(`seed:${seed}:`);
  let framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.length);
  return framed;
}

/**
 * Test hasher: SHA-256 of the input (seed mixed in first, see `withSeed`), via `crypto.subtle`
 * rather than Node's `crypto` so the hash matches on Node, Bun, and Deno.
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
 * Test signer with `seed` as the stand-in secret key. `sign` returns a SHA-256 hash (seed mixed
 * in); `verify` re-signs and compares. Not real crypto, just enough to exercise the sign/verify
 * path.
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

// True when the two byte arrays are the same length and hold the same bytes.
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

// Three fixed CREDIT-to-USD rates, one per read site. Round values (not the exact $0.00833
// acquisition rate, which isn't a clean cent) so the topUp split lands on whole cents: `buy` = the
// acquisition rate a user pays per credit ($0.01, 100 credits = $1); `par` = the
// redemption/settlement rate the backing check uses ($0.005, 200 credits = $1); `payout` = `par`,
// the settlement rate. The buy-par gap (50%) is the platform spread. (A separate test pins a
// real ~40% spread + creator-nets-50% with the exact 120/200 rates.) Each rate is exact integers
// (multiplier `rate / 10^scale`) plus a `rateId`.
// The rateId's trailing "r/s" is rate/scale, not a fraction: 1/2 = 1·10^-2 = $0.01, 5/3 = 5·10^-3 = $0.005.
let BUY_CREDIT: Rate = { rate: 1n, scale: 2, rateId: 'buy:CREDIT->USD:1/2' };
let PAR_CREDIT: Rate = { rate: 5n, scale: 3, rateId: 'par:CREDIT->USD:5/3' };
let PAYOUT_CREDIT: Rate = {
  rate: 5n,
  scale: 3,
  rateId: 'payout:CREDIT->USD:5/3',
};

/**
 * A test rate source: buy $0.01, par $0.005, payout $0.005. `payout` gives the conversion rate for
 * a payout (the pinned CREDIT-to-USD payout rate when converting CREDIT to USD, or 1-to-1 for any
 * other pair); `par` gives the backing peg; `buy` gives the rate a user pays at top-up.
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

// Logger that discards every line, so tests produce no log noise.
export function testLogger(): Logger {
  return { log: () => {} };
}

// Metrics sink that records nothing; exists so code emitting metrics has something to call.
export function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

/**
 * A fake payment provider that approves every payout and returns a predictable reference
 * (`prov_<key>`) instead of calling a real provider.
 */
export function fakeProcessor(): Processor {
  return {
    submitPayout: async (input) => ({ providerRef: `prov_${input.key}` }),
  };
}

// --- Pricing (a flat-percentage split, expressed in basis points) -----------------

// `bps` basis points (hundredths of a percent) of `minor`, rounded down: minor * bps / 10000.
// All bigint so large totals stay exact (a JS number would lose precision at that size).
function applyBps(minor: bigint, bps: number): bigint {
  return (minor * BigInt(bps)) / 10_000n;
}

// Split a sale's `price` into the credit legs that pay each party. Take the platform fee off the
// top via the same `feeForPrice` production uses (rounds the fee up to a whole credit, posts to
// REVENUE), so this fixture agrees with the fee `saleOf` records. Each recipient gets a
// rounded-down share of the rest, into that seller's `earned` account. Rounding leftover goes to
// REVENUE with the fee, so the legs sum to exactly `price`. Covers payouts only; the operation
// handler adds the matching line that debits the buyer.
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
 * Test fee policy: a flat-percentage split (see `splitLegs`). Stateless, so the legs depend only
 * on the inputs.
 */
export function defaultPricing(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// --- Config -----------------------------------------------------------------------

/**
 * Test config with throwaway secrets. `loadConfig`'s startup check for missing secrets is covered
 * in the config tests, so placeholder values are fine here.
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
