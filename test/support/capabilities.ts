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
import { configuredRates } from '#src/adapters/rates.ts';

import type {
  Clock,
  Digest,
  Logger,
  Meter,
  Processor,
  Rates,
  Signer,
} from '#src/ports.ts';
import type { Amount } from '#src/money.ts';
import type { Ctx, FeePolicy, Recipient, WorkerCtx } from '#src/contract.ts';
import type { Leg } from '#src/ports.ts';
import type { Config } from '#src/config.ts';

// --- Clock & ids ------------------------------------------------------------------

/** A manual clock: reports `start` until `advance(ms)` jumps it forward and returns the new time. */
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

/** Deterministic ids: `<prefix>_<n>`, counting up from `seed`. */
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

// Frames the bytes with `seed:<seed>:` so different seeds hash differently and a seed is stable
// across runs.
const ENCODER = new TextEncoder();
function withSeed(seed: number, bytes: Uint8Array): Uint8Array {
  const prefix = ENCODER.encode(`seed:${seed}:`);
  const framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.length);
  return framed;
}

/** Seeded SHA-256 (see `withSeed`), via `crypto.subtle` so the hash matches on Node, Bun, and Deno. */
export function seededDigest(seed = 1): Digest {
  return {
    hash: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', withSeed(seed, bytes)),
      ),
  };
}

/** Not real crypto: sign is a seeded hash, verify re-signs and compares — enough to exercise the path. */
export function seededSigner(seed = 1): Signer {
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', withSeed(seed, bytes)),
    );
  return {
    sign,
    verify: async (bytes, signature) => {
      const expected = await sign(bytes);
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

/**
 * The production {@link configuredRates} pinned to round values so splits land on whole cents:
 * `buy` $0.01, `par` (the backing peg) and `payout` both $0.005 — a 50% platform spread.
 */
export function fixedRates(): Rates {
  return configuredRates({
    buyRate: 1n,
    buyScale: 2,
    parRate: 5n,
    parScale: 3,
    payoutRate: 5n,
    payoutScale: 3,
  });
}

// --- logger, meter, processor -----------------------------------------------------

export function testLogger(): Logger {
  return { log: () => {} };
}

export function noopMeter(): Meter {
  return { count: () => {}, observe: () => {} };
}

/** Approves every payout with the predictable reference `prov_<key>`. */
export function fakeProcessor(): Processor {
  return {
    submitPayout: async (input) => ({ providerRef: `prov_${input.key}` }),
  };
}

// --- Pricing (a flat-percentage split, expressed in basis points) -----------------

// Basis points of `minor`, rounded down; bigint so large totals stay exact.
function applyBps(minor: bigint, bps: number): bigint {
  return (minor * BigInt(bps)) / 10_000n;
}

// Fee off the top via the production `feeForPrice`, rounded-down shares to each seller, and the
// rounding leftover to REVENUE so the legs sum to exactly `price`. Payout legs only — the
// operation handler adds the buyer's debit.
function splitLegs(
  price: Amount,
  recipients: ReadonlyArray<Recipient>,
  feeBps: number,
): Leg[] {
  const fee = feeForPrice(price.minor, feeBps);
  const net = price.minor - fee;
  const legs: Leg[] = [];
  let distributed = 0n;
  for (const recipient of recipients) {
    const share = applyBps(net, recipient.shareBps);
    distributed += share;
    legs.push(
      creditLeg(earned(recipient.sellerId), toAmount(price.currency, share)),
    );
  }
  const residual = net - distributed;
  legs.push(
    creditLeg(SYSTEM.REVENUE, toAmount(price.currency, fee + residual)),
  );
  return legs;
}

/** A flat-percentage split (see `splitLegs`); stateless, so legs depend only on inputs. */
export function defaultPricing(): FeePolicy {
  return (input) => splitLegs(input.price, input.recipients, input.feeBps);
}

// --- Config -----------------------------------------------------------------------

/** Throwaway secrets are fine here; test/config.test.ts covers loadConfig's missing-secret check. */
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
    // Unsharded platform accounts, the byte-identical default; sharding tests override this.
    platformShards: 1,
  };
}

// --- Ctx --------------------------------------------------------------------------

/**
 * The Ctx a handler reads, wired from the deterministic doubles above; a test calls the handler
 * directly instead of routing through `submit`.
 */
export function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    ...overrides,
  };
}

/** The background worker's context (no pricing), the WorkerCtx counterpart to {@link makeCtx}. */
export function makeWorkerCtx(overrides: Partial<WorkerCtx> = {}): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
    ...overrides,
  };
}

/** Predicate for assert.throws/rejects: the thrown Error carries exactly this stable code. */
export function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}
