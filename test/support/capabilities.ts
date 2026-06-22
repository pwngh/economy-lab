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
 * A test clock whose time never moves on its own. It reports `start` until you call
 * `advance(ms)`, which jumps it forward by `ms` and returns the new time. Tests use this
 * so time only changes when they make it change, keeping each run reproducible.
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
 * A fake id generator that hands out predictable ids. Instead of random uuids, it counts
 * up from `seed` and returns `<prefix>_<n>` (for example `txn_1`, then `txn_2`). Because
 * the sequence is fixed, the same ids appear every run.
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

// Mix the seed into the bytes before hashing them. Two different seeds produce two
// different hashes for the same input, but a given seed always produces the same hash.
// We do this by gluing `seed:<seed>:` onto the front of the bytes, then hashing the
// combined buffer with the platform's built-in SHA-256, which gives identical results on
// every JavaScript runtime.
let ENCODER = new TextEncoder();
function withSeed(seed: number, bytes: Uint8Array): Uint8Array {
  let prefix = ENCODER.encode(`seed:${seed}:`);
  let framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.length);
  return framed;
}

/**
 * A test hasher. It returns the SHA-256 hash of the input (with the seed mixed in first,
 * see `withSeed`), using the platform's built-in `crypto.subtle` rather than Node's
 * `crypto` module so the same hash comes out on Node, Bun, and Deno.
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
 * A test signer where the `seed` plays the part of the secret key. `sign` produces a
 * predictable "signature" (a SHA-256 hash with the seed mixed in), and `verify` re-signs
 * the same bytes and checks the result matches. This is not real cryptography; it is just
 * enough to exercise the code path that signs a value and then verifies that signature.
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

// --- Rates (fixed-point, audited) -------------------------------------------------

// Three fixed CREDIT-to-USD rates, one for each place a rate is read. Round test values (not
// VRChat's exact $0.00833 buy rate, which is not a clean cent) chosen so the topUp split lands on
// whole cents: `buy` is what a user pays per credit ($0.01, so 100 credits = $1); `par` is the
// credit's backing/cash-out value the backing check uses ($0.005, so 200 credits = $1); `payout`
// equals `par`. The buy-vs-par gap (50% here) is the platform's purchase-spread cut. (A separate
// test pins VRChat's real ~40% spread + creator-nets-50% with the exact 120/200 rates.) A rate is
// stored as exact integers (multiplier `rate / 10^scale`) plus a `rateId` naming which it is.
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

// A logger that throws every line away, so tests produce no log noise.
export function testLogger(): Logger {
  return { log: () => {} };
}

// A metrics sink that records nothing. It exists only so code that emits metrics has
// something to call.
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

// Take `bps` basis points (hundredths of a percent) of `minor` and round down to a whole
// minor unit: minor * bps / 10000. Everything is bigint so even the platform's largest
// totals stay exact (a regular JavaScript number would lose precision at that size).
function applyBps(minor: bigint, bps: number): bigint {
  return (minor * BigInt(bps)) / 10_000n;
}

// Split a sale's `price` into the individual credit lines — the legs — that pay each party.
// First take the platform fee off the top, using the SAME `feeForPrice` the production pricing
// uses: it rounds the fee UP to a whole credit and posts it to the REVENUE account, so this
// fixture never disagrees with the fee `saleOf` records. Then give each recipient their
// rounded-down share of what is left, paid into that seller's `earned` account (the credits the
// platform owes that seller). Any rounding leftover goes to the platform's REVENUE account along
// with the fee, so the legs add up to exactly `price` with nothing lost. This only covers who
// gets paid; the operation handler adds the matching line that takes the money from the buyer.
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
 * The test fee policy: a flat-percentage split (see `splitLegs`). It keeps no state of its
 * own, so the legs it returns depend only on the inputs it is handed.
 */
export function defaultPricing(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// --- Config -----------------------------------------------------------------------

/**
 * A ready-made test config with throwaway secrets. The real `loadConfig` startup check
 * that rejects missing secrets is tested on its own in the config tests, not here, so
 * these placeholder values are fine.
 */
export function testConfig(): Config {
  return {
    webhookSecret: 'test-webhook-secret',
    signingSecret: 'test-signing-secret',
    replayWindowMs: 5 * 60_000,
    maxPayoutAttempts: 5,
    maxOutboxAttempts: 10,
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
  };
}
