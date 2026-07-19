/// <reference types="node" />
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

/**
 * Property-based invariant test: replays seeded randomized operation sequences against a fresh
 * in-memory economy and proves every ProveReport flag at checkpoints. The generator is lifted
 * unchanged from scripts/fuzz.ts and scripts/prove.ts, so a seed reproduces the byte-identical
 * sequence in all three. The seed alone reproduces any failure; a failing seed is a real bug,
 * not a flaky test.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { decodeAmount, encodeAmount } from '#src/money.ts';

import type { Economy, Operation, ProveReport } from '#src/contract.ts';

// The 0x9e00 base keeps these seeds distinct from the ranges scripts/fuzz.ts and scripts/prove.ts use.
const SEEDS = Array.from({ length: 24 }, (_, i) => 0x9e00 + i);

// Long enough to interleave every operation kind across the users; short enough the suite stays fast.
const OPS_PER_SEED = 64;

// Mid-stream re-proves catch a violation near the operation that introduced it.
const CHECKPOINTS = 4;

// --- Seeded operation generator (mulberry32 + wallet tally) -----------------------------
// Adds one kind the scripts do not produce: requestPayout. Under testConfig() there is no minimum,
// no interval throttle, and immediate maturity, so an affordable request commits.

// mulberry32, in [0, 1). Keep identical to the copies in scripts/fuzz.ts and scripts/prove.ts — a
// seed must yield the same stream in all three.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Local tally, in minor units, so the generator emits only affordable spends and payout asks.
type Wallet = { spendable: bigint; promo: bigint; earned: bigint };

function dollars(minor: bigint): string {
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

function creditMinor(minor: bigint) {
  return decodeAmount(dollars(minor), 'CREDIT');
}

function walletOf(wallets: Map<string, Wallet>, userId: string): Wallet {
  let wallet = wallets.get(userId);
  if (!wallet) {
    wallet = { spendable: 0n, promo: 0n, earned: 0n };
    wallets.set(userId, wallet);
  }
  return wallet;
}

// One fixed seller keeps earnings accumulating so payouts have something to claim.
const SELLER = 'usr_seller';

// Charges promo before spendable, matching the real spend handler — a tally out of step would start
// emitting spends the user cannot afford.
function spendOperation(
  next: () => number,
  step: number,
  parties: { userId: string; wallet: Wallet; seller: Wallet },
): Operation {
  const { userId, wallet, seller } = parties;
  const available = wallet.spendable + wallet.promo;
  let priceMinor =
    BigInt(1 + Math.floor(next() * Number(available / 100n))) * 100n;
  if (priceMinor > available) {
    priceMinor = available;
  }
  const fromPromo = wallet.promo < priceMinor ? wallet.promo : priceMinor;
  wallet.promo -= fromPromo;
  wallet.spendable -= priceMinor - fromPromo;
  seller.earned += priceMinor;
  return op('spend', step, {
    // The contract requires an orderId; deriving it from the step keeps replay byte-identical.
    orderId: `ord_prop_${step}`,
    buyerId: userId,
    sku: 'wrld_pass',
    price: creditMinor(priceMinor),
    recipients: [{ sellerId: SELLER, shareBps: 10_000 }],
  });
}

// With nothing earned, the token ask is rejected by design and moves no money. The saga a committed
// request opens needs no worker to keep the ledger sound — the credits are already reserved.
function payoutOperation(step: number, seller: Wallet): Operation {
  const askMinor =
    seller.earned >= 100n
      ? (seller.earned / 100n / 2n + 1n) * 100n < seller.earned
        ? (seller.earned / 100n / 2n + 1n) * 100n
        : seller.earned
      : 100n;
  if (askMinor <= seller.earned) {
    seller.earned -= askMinor;
  }
  return op('requestPayout', step, {
    userId: SELLER,
    amount: creditMinor(askMinor),
  });
}

// The distribution mirrors the scripts, with a payout slice carved from the spend band. All ids
// derive from the step number alone, so replay is byte-identical.
function nextOperation(
  next: () => number,
  step: number,
  wallets: Map<string, Wallet>,
): Operation {
  const userId = `usr_p${1 + Math.floor(next() * 3)}`;
  const wallet = walletOf(wallets, userId);
  const seller = walletOf(wallets, SELLER);
  const roll = next();

  if (roll < 0.45 || wallet.spendable + wallet.promo < 100n) {
    const minor = BigInt(1 + Math.floor(next() * 50)) * 100n;
    wallet.spendable += minor;
    return op('topUp', step, {
      userId,
      amount: creditMinor(minor),
      source: 'card',
    });
  }
  if (roll < 0.6) {
    const minor = BigInt(1 + Math.floor(next() * 20)) * 100n;
    wallet.promo += minor;
    return op('grantPromo', step, {
      userId,
      amount: creditMinor(minor),
      expiresAt: 86_400_000,
    });
  }
  if (roll < 0.72) {
    return payoutOperation(step, seller);
  }
  return spendOperation(next, step, { userId, wallet, seller });
}

// Runs every request as the system actor: this test proves accounting invariants, not authorization.
function op(
  kind: Operation['kind'],
  step: number,
  fields: Record<string, unknown>,
): Operation {
  return {
    kind,
    idempotencyKey: `idem_prop_${step}`,
    actor: { kind: 'system', service: 'property' },
    ...fields,
  } as Operation;
}

function program(seed: number, length: number): Operation[] {
  const next = rng(seed);
  const wallets = new Map<string, Wallet>();
  const operations: Operation[] = [];
  for (let step = 0; step < length; step += 1) {
    operations.push(nextOperation(next, step, wallets));
  }
  return operations;
}

// --- Invariant assertion ----------------------------------------------------------------

// Asserting the flags by name lets the failure message say which guarantee broke.
const FLAGS = [
  'conserved',
  'backed',
  'noOverdraft',
  'chainIntact',
  'consistent',
] as const;

async function assertInvariants(
  economy: Economy,
  seed: number,
  at: number,
  total: number,
): Promise<void> {
  const report: ProveReport = await economy.read.health();
  const where =
    `seed 0x${seed.toString(16)} after ${at}/${total} ops ` +
    `(reproduce: program(0x${seed.toString(16)}, ${OPS_PER_SEED}))`;

  for (const flag of FLAGS) {
    assert.equal(report[flag], true, `invariant "${flag}" violated — ${where}`);
  }
  // Pinning drift directly guards a regression that leaves a drifted row yet still reports consistent.
  assert.deepEqual(
    report.drift,
    [],
    `prove().drift must be empty — ${where}; drift=${JSON.stringify(
      report.drift.map((row) => ({
        account: row.account,
        materialized: encodeAmount(row.materialized),
        derived: encodeAmount(row.derived),
      })),
    )}`,
  );
  // Pinning shortfall reports a gap in dollars, not only as a boolean.
  assert.equal(
    report.shortfall.minor,
    0n,
    `prove().shortfall must be zero — ${where}; shortfall=${encodeAmount(
      report.shortfall,
    )}`,
  );
}

// --- The property test ------------------------------------------------------------------

describe('property: ledger invariants hold over randomized operation sequences', () => {
  for (const seed of SEEDS) {
    test(`seed 0x${seed.toString(16)} keeps every invariant across ${OPS_PER_SEED} ops`, async () => {
      const operations = program(seed, OPS_PER_SEED);
      const economy = makeEconomy(seed);
      try {
        const stride = Math.ceil(OPS_PER_SEED / CHECKPOINTS);
        for (let i = 0; i < operations.length; i += 1) {
          await economy.submit(operations[i]!);
          const opsDone = i + 1;
          const lastOp = opsDone === operations.length;
          if (lastOp || opsDone % stride === 0) {
            await assertInvariants(economy, seed, opsDone, operations.length);
          }
        }
      } finally {
        await economy.close();
      }
    });
  }
});
