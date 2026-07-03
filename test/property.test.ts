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
 * Property-based invariant test: the core-ledger invariants must hold over many randomized
 * operation sequences, deterministically, inside `npm test`.
 *
 * scripts/fuzz.ts and scripts/prove.ts already generate randomized operation sequences against a
 * fresh economy and check the integrity report, but only as CLI tools outside the suite. This file
 * wires that same rigor into the runner: it reuses the identical mulberry32 PRNG, the same
 * wallet-tally driver, the same `op()` builder, and the same `makeEconomy()` + `read.prove()` check
 * those scripts use, so a seed produces a byte-identical sequence here and there.
 *
 * For each of {@link SEEDS} pinned seeds, it builds one fixed sequence of {@link OPS_PER_SEED} real
 * operations. That sequence is a representative mix of topUp, grantPromo, spend, and requestPayout,
 * which is every kind the submit-only fuzz driver can generate while keeping money conservation
 * provable. It then replays the sequence against a FRESH in-memory economy and asserts that every
 * ProveReport flag holds at several mid-stream checkpoints and once at the end: conserved, backed,
 * noOverdraft, chainIntact, and consistent, with an empty `drift` and a zero `shortfall`.
 *
 * Determinism: the only randomness is the seeded PRNG. There is no Math.random, no wall-clock, and
 * no network. makeEconomy() wires a fixed clock, sequential ids, and a seeded digest and signer. The
 * seed alone reproduces any failure, and the assertion message prints the seed, the failing flag,
 * the checkpoint, and the operation index.
 *
 * A failing seed is a real bug, not a flaky test: it means a randomized but valid sequence of
 * operations drove the ledger into a state where one of its five guarantees no longer held.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { decodeAmount, encodeAmount } from '#src/money.ts';

import type { Economy, Operation, ProveReport } from '#src/contract.ts';

// 24 pinned seeds (at least the 20 required), each deterministic. A fixed base offsets them so they
// do not collide with the seeds scripts/fuzz.ts (0xf00..) or scripts/prove.ts (0x1000..) use, which
// keeps the three workloads distinct. A seed is the whole reproduction key: re-running this file
// replays the exact same sequence for each one.
const SEEDS = Array.from({ length: 24 }, (_, i) => 0x9e00 + i);

// Operations per seed. This count is long enough to interleave top-ups, promos, spends, and payout
// requests across three users and a seller, so accounts carry many postings and real chains. It is
// short enough that 24 seeds, each re-proven at several checkpoints, still finish in a couple of
// seconds.
const OPS_PER_SEED = 64;

// Re-prove the full invariant report this many times mid-stream (plus once at the very end), so a
// violation is caught close to the operation that introduced it rather than only after the last op.
const CHECKPOINTS = 4;

// --- Seeded operation generator (mulberry32 + wallet tally) -----------------------------
//
// Lifted unchanged from scripts/fuzz.ts and scripts/prove.ts. It uses the same PRNG, the same
// affordable-spend tally, and the same per-step ids, so a seed yields the byte-identical sequence in
// all three. This generator adds one operation kind those scripts do not produce: requestPayout. A
// payout is still a plain submit that keeps every invariant provable. It moves a seller's earned
// credits into the payout reserve, or it returns a `rejected` result that moves no money. Under
// testConfig() there is no minimum, no interval throttle, and immediate maturity, so an affordable
// request commits.

// Returns a mulberry32 PRNG: a function that yields the next number in [0, 1) on each call. It uses
// fixed integer math, so a seed produces the identical stream on every JS runtime. That is what lets
// a seed reproduce a failure exactly. Identical to the generator in scripts/fuzz.ts and
// scripts/prove.ts.
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

// One user's running balances, in minor units (cents). `spendable` is topped-up money. `promo` is a
// marketing grant. `earned` is credit a seller accrued from spends routed to it, and it is the only
// source a payout can draw down. The generator tracks these locally so it emits only affordable
// spends and plausible payout amounts, which keeps the run on the money-moves path.
type Wallet = { spendable: bigint; promo: bigint; earned: bigint };

// Formats minor units (cents) as a two-decimal string like "12.34", the text form decodeAmount
// expects. Same helper as the scripts.
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

// The single seller every spend's revenue is routed to, with recipients sending 100% to it. Its
// earned balance is what requestPayout draws on. One fixed id keeps earnings accumulating so payouts
// have something to claim, matching the scripts' `usr_seller`.
const SELLER = 'usr_seller';

// Builds an affordable spend and subtracts it from the local tally. It charges promo first, matching
// the real spend handler, which charges promo credit before spendable. It then credits the seller's
// earned tally by the full price, because recipients route 100% to the seller. The charge order
// matters: if the tally fell out of step with the handler, the generator would start producing
// spends the user cannot afford.
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
    // A deterministic per-step order id keeps the sequence byte-identical on replay. The contract
    // requires a non-null orderId, and deriving it from the step makes it both stable and unique.
    orderId: `ord_prop_${step}`,
    buyerId: userId,
    sku: 'wrld_pass',
    price: creditMinor(priceMinor),
    recipients: [{ sellerId: SELLER, shareBps: 10_000 }],
  });
}

// Builds a payout request for the seller against an affordable slice of its earned credit, and
// drains the local earned tally by what it asks for. requestPayout moves earned into PAYOUT_RESERVE,
// a platform account exempt from the backing and overdraft rules, so it conserves money and stays
// fully backed. When nothing is earned yet, it asks for a token amount that the handler returns as a
// plain `rejected`, which moves no money and leaves the invariants intact. The saga it opens needs
// no worker to keep the ledger sound, because the credits are already reserved by this committed
// posting.
function payoutOperation(step: number, seller: Wallet): Operation {
  const askMinor =
    seller.earned >= 100n
      ? // Claims a whole-credit slice of what the seller has earned so far.
        (seller.earned / 100n / 2n + 1n) * 100n < seller.earned
        ? (seller.earned / 100n / 2n + 1n) * 100n
        : seller.earned
      : 100n; // Nothing earned yet, so this token ask is one the handler rejects, moving no money.
  if (askMinor <= seller.earned) {
    seller.earned -= askMinor;
  }
  return op('requestPayout', step, {
    userId: SELLER,
    amount: creditMinor(askMinor),
  });
}

// Picks one valid operation for the next step and updates the local tally so the next step stays
// valid too. The distribution mirrors the scripts (topUp about 45%, grantPromo about 15%, spend
// otherwise), with a payout slice carved out of the spend band so every kind appears. The
// idempotency key and all ids come only from the step number, so the sequence is byte-identical on
// every replay of the seed.
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

// Assembles an Operation, stamping in the per-step idempotency key and a fixed system actor. This
// test checks whether the accounting invariants hold, not authorization, so every request runs as
// the system service and bypasses permission checks. Same shape as the scripts' `op()`.
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

// Builds the full fixed operation sequence for one seed.
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

// The five ProveReport flags every healthy book must satisfy, in the order scripts/prove.ts checks
// them. Asserting them by name lets the failure message say exactly which guarantee broke.
const FLAGS = [
  'conserved',
  'backed',
  'noOverdraft',
  'chainIntact',
  'consistent',
] as const;

// Re-derives the integrity report and asserts that every guarantee holds. On any failure the message
// carries the seed (the sole reproduction key), the point in the sequence, and the specific flag or
// quantity that broke, so the failing case can be replayed deterministically from the seed alone.
async function assertInvariants(
  economy: Economy,
  seed: number,
  at: number,
  total: number,
): Promise<void> {
  const report: ProveReport = await economy.read.prove();
  const where =
    `seed 0x${seed.toString(16)} after ${at}/${total} ops ` +
    `(reproduce: program(0x${seed.toString(16)}, ${OPS_PER_SEED}))`;

  for (const flag of FLAGS) {
    assert.equal(report[flag], true, `invariant "${flag}" violated — ${where}`);
  }
  // An empty `drift` is the detail behind `consistent`. Pinning it directly guards against a
  // regression that leaves a drifted row yet still flips `consistent` to true, and it lets the
  // message name the offending account.
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
  // A zero `shortfall` is the detail behind `backed`. Pinning the amount reports a non-zero gap in
  // dollars rather than only as a boolean.
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
        // Checkpoints spread evenly through the stream, so a violation is caught near the op that
        // introduced it. The set always includes the final op, so the end state is proven too.
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
