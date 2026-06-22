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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSubscribe } from '#src/operations/subscribe.ts';
import { createEconomy } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable, promo, earned, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { assessRisk, riskAttempt, attemptMinor } from '#src/trust.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';
import {
  topUp,
  grantPromo,
  subscribe,
  credit,
  emptyVelocity,
} from '#test/support/builders.ts';

import type { Economy, Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// The public `Economy` only routes a few operations (topUp, grantPromo, spend); subscribe
// isn't one of them, so a test can't reach `handleSubscribe` through `economy.submit`.
// This harness gives a test both halves it needs: the public `economy` to seed the buyer's
// funds, and a direct `run` that calls `handleSubscribe` inside a transaction on the SAME
// store, which is the only way to drive the handler.
type Harness = {
  economy: Economy;
  store: Store;
  run: (operation: Operation) => Promise<Outcome>;
};

function makeHarness(seed = 1): Harness {
  let digest = seededDigest(seed);
  let clock = fixedClock(0);
  let store = memoryStore({ digest, clock });
  let ctx: Ctx = {
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(seed),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
  let economy = createEconomy({
    store,
    clock,
    ids: ctx.ids,
    digest,
    signer: ctx.signer,
    processor: ctx.processor,
    rates: ctx.rates,
    logger: ctx.logger,
    meter: ctx.meter,
    pricing: ctx.pricing,
    config: ctx.config,
  });
  return {
    economy,
    store,
    run: (operation) =>
      store.transaction((unit) => handleSubscribe(operation, unit, ctx)),
  };
}

// Build a subscribe for the fixed buyer/seller/sku used across the suite, so each test only
// has to supply the price (and an optional billing period) it cares about.
function subscribeOf(price: string, periodMs?: number): Operation {
  return subscribe({
    userId: 'usr_buyer',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: credit(price),
    periodMs,
  });
}

// Assert the outcome was a rejection and narrow its type, so a caller can read the reason.
function rejectionOf(
  outcome: Outcome,
): Extract<Outcome, { status: 'rejected' }> {
  assert.equal(outcome.status, 'rejected');
  return outcome as Extract<Outcome, { status: 'rejected' }>;
}

// True when the thrown value is the handler's "malformed operation" error (an out-of-range
// or wrong-currency price), used as the predicate for `assert.rejects`.
function isMalformed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'OP.MALFORMED'
  );
}

// --- Test bodies (one helper per case, so the describe block below stays short) -----

async function chargesFirstMonthFromSpendable(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  let outcome = await harness.run(subscribeOf('100.50'));

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await harness.economy.read.balance(spendable('usr_buyer')),
    credit('99.50'),
  );
  assert.deepEqual(
    await harness.economy.read.balance(earned('usr_seller')),
    credit('69.50'),
  );
}

async function roundsTheFeeUpToAWholeCredit(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  await harness.run(subscribeOf('100.01'));

  // The 30% fee on 100.01 is 30.003 credits — a fee that lands BETWEEN whole credits. VRChat's
  // rule rounds the fee UP to the next whole credit, so 31.00 (not 30.00) lands in REVENUE. This
  // price is chosen because the fee is fractional in minor units (3000.3): a fee path that floored
  // to minor units before rounding up would drop the 0.3 and wrongly settle on 30.00, so this
  // pins that subscribe shares pricing.ts `feeForPrice` (round the exact fee up in one step).
  assert.deepEqual(
    await harness.economy.read.balance(SYSTEM.REVENUE),
    credit('31.00'),
  );
}

async function drawsPromoBeforeSpendable(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );
  await harness.economy.submit(
    grantPromo({ userId: 'usr_buyer', amount: credit('40.00') }),
  );

  await harness.run(subscribeOf('100.00'));

  // The charge spends the 40.00 promo grant first, leaving 0.00 promo; the remaining 60.00 of
  // the 100.00 price comes from spendable, so spendable drops from 200.00 to 140.00.
  assert.deepEqual(
    await harness.economy.read.balance(promo('usr_buyer')),
    credit('0.00'),
  );
  assert.deepEqual(
    await harness.economy.read.balance(spendable('usr_buyer')),
    credit('140.00'),
  );
}

async function keepsPromoFloatSummingToZero(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );
  await harness.economy.submit(
    grantPromo({ userId: 'usr_buyer', amount: credit('40.00') }),
  );

  await harness.run(subscribeOf('100.00'));

  // PROMO_FLOAT is the platform account that offsets outstanding promo grants: every credit in a
  // user's promo balance is matched by an opposite entry there, so the two always cancel to zero.
  let promoBalance = await harness.economy.read.balance(promo('usr_buyer'));
  let promoFloat = await harness.economy.read.balance(SYSTEM.PROMO_FLOAT);
  assert.equal(promoBalance.minor + promoFloat.minor, 0n);
}

async function rejectsWhenSpendableIsInsufficient(
  harness: Harness,
): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('50.00') }),
  );

  let outcome = await harness.run(subscribeOf('100.00'));

  assert.equal(rejectionOf(outcome).reason, 'INSUFFICIENT_FUNDS');
}

async function opensAnActiveSubscription(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );
  let periodMs = 2_592_000_000;

  let outcome = await harness.run(subscribeOf('100.00', periodMs));

  assert.equal(outcome.status, 'committed');
  // After billing month one, the subscription should be saved as ACTIVE on period 1, with its
  // next charge due one period out. `claimDue` returns subscriptions due to bill by that time.
  let due = await harness.store.subscriptions.claimDue(periodMs, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.state, 'ACTIVE');
  assert.equal(due[0]!.period, 1);
}

async function rejectsAPriceBelowTheBand(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  await assert.rejects(harness.run(subscribeOf('99.99')), isMalformed);
}

async function rejectsAPriceAboveTheBand(harness: Harness): Promise<void> {
  await assert.rejects(harness.run(subscribeOf('10000.01')), isMalformed);
}

async function grantsTheSkuEntitlement(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  let outcome = await harness.run(subscribeOf('100.00'));

  assert.equal(outcome.status, 'committed');
  // The purchased item (the SKU) is granted inside the same database transaction that takes the
  // first-month charge, so any subscriber who paid owns it. Ownership lives in the entitlement
  // store, which is only reachable inside a transaction, so we open one to read it back.
  let owned = await harness.store.transaction((unit) =>
    unit.entitlements.owns('usr_buyer', 'club_pass'),
  );
  assert.equal(owned, true);
}

// A subscribe charge counts toward the same recent-spending limit (the "velocity window" — the
// running total of how much a user has spent in the current time window) as an ordinary spend.
// If a subscribe's price would push that total over the configured limit, it is denied.
// `assessRisk` is the pure function that makes this decision; the live request pipeline calls it
// the same way, so testing `assessRisk` directly checks the rule everything else relies on.
function deniesSubscribeOverTheVelocityLimit(): void {
  let config = testConfig();
  // A limit low enough that one max-band subscribe (10,000 credits = 1,000,000 minor) trips it
  // once the window already holds a little spend.
  config.velocityLimitMinor = 1_500_000n;
  let velocity = emptyVelocity('usr_buyer');
  velocity.spent = toAmount('CREDIT', 600_000n); // 6,000 credits already this window

  let operation = subscribeOf('10000.00'); // 1,000,000 minor; projected 1,600,000 > 1,500,000

  let decision = assessRisk(velocity, operation, config);
  assert.equal(decision.allow, false);
  assert.equal(
    decision.allow === false ? decision.reason : null,
    'RISK_DENIED',
  );
}

// Once a subscribe commits, its price is added to the user's running spending total for the
// current window (the figure the recent-spending limit checks against). The live pipeline does
// this after the charge commits by building a record of the attempt and writing it to the trust
// store. This test runs that same path against the real trust store, then reads the total back.
async function committedSubscribeAccruesPriceMinor(
  harness: Harness,
): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  let operation = subscribeOf('100.00');
  let outcome = await harness.run(operation);
  assert.equal(outcome.status, 'committed');

  // The funding top-up above also counts toward the spending window and already added its own
  // amount, so measure how much the subscribe adds on top rather than the absolute total.
  let before = (await harness.store.trust.read('usr_buyer')).spent.minor;

  // Build the attempt exactly as the pipeline does and write it through the trust store.
  let attempt = riskAttempt(operation, outcome, 0);
  assert.notEqual(attempt, null);
  await harness.store.trust.bump('usr_buyer', attempt!);

  let velocity = await harness.store.trust.read('usr_buyer');
  // The amount added equals the subscribe's price in minor units (the smallest unit; here the
  // 100.00-credit price is 10,000 minor, since one credit is 100 minor).
  assert.equal(velocity.spent.minor - before, attemptMinor(operation));
  assert.equal(velocity.spent.minor - before, credit('100.00').minor);
}

async function rejectsAZeroPeriod(harness: Harness): Promise<void> {
  await assert.rejects(harness.run(subscribeOf('100.00', 0)), isMalformed);
}

async function rejectsANaNPeriod(harness: Harness): Promise<void> {
  await assert.rejects(harness.run(subscribeOf('100.00', NaN)), isMalformed);
}

async function rejectsABlankSku(harness: Harness): Promise<void> {
  let operation = subscribe({
    userId: 'usr_buyer',
    sellerId: 'usr_seller',
    sku: '   ',
    price: credit('100.00'),
  });
  await assert.rejects(harness.run(operation), isMalformed);
}

async function commitsANormalSubscribe(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  let outcome = await harness.run(subscribeOf('100.00'));

  assert.equal(outcome.status, 'committed');
}

async function preservesConservation(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('300.00') }),
  );
  await harness.economy.submit(
    grantPromo({ userId: 'usr_buyer', amount: credit('30.00') }),
  );

  await harness.run(subscribeOf('120.00'));

  let report = await harness.economy.read.prove();
  // `conserved`: in every currency, the debits and credits across the whole ledger cancel to zero.
  assert.equal(report.conserved, true);
  // `backed`: the real cash the platform holds for users covers the dollar value of every
  // spendable balance and every balance set aside for a pending purchase. Each credit is
  // converted to dollars at par, the fixed credits-to-dollars rate.
  assert.equal(report.backed, true);
}

describe('Subscribe', () => {
  test('charges the first month from spendable and accrues the net to the seller', () =>
    chargesFirstMonthFromSpendable(makeHarness()));
  test('rounds the transaction fee up to a whole credit', () =>
    roundsTheFeeUpToAWholeCredit(makeHarness()));
  test('draws promo before spendable and funds the seller from house revenue', () =>
    drawsPromoBeforeSpendable(makeHarness()));
  test('keeps the promo float and promo balance summing to zero after a promo charge', () =>
    keepsPromoFloatSummingToZero(makeHarness()));
  test('rejects the charge when spendable cannot cover its portion', () =>
    rejectsWhenSpendableIsInsufficient(makeHarness()));
  test('opens an active subscription due one period out', () =>
    opensAnActiveSubscription(makeHarness()));
  test('rejects a price below the 100-credit band as a malformed operation', () =>
    rejectsAPriceBelowTheBand(makeHarness()));
  test('rejects a price above the 10000-credit band as a malformed operation', () =>
    rejectsAPriceAboveTheBand(makeHarness()));
  test('rejects a zero billing period as a malformed operation', () =>
    rejectsAZeroPeriod(makeHarness()));
  test('rejects a NaN billing period as a malformed operation', () =>
    rejectsANaNPeriod(makeHarness()));
  test('rejects a blank sku as a malformed operation', () =>
    rejectsABlankSku(makeHarness()));
  test('commits a well-formed subscribe with a valid period and sku', () =>
    commitsANormalSubscribe(makeHarness()));
  test('keeps debits and credits balanced and credits fully USD-backed across the first-month charge', () =>
    preservesConservation(makeHarness()));
  test('grants the buyer the SKU entitlement in the same transaction as the charge', () =>
    grantsTheSkuEntitlement(makeHarness()));
  test('denies a subscribe that would push recent spending over the limit', () =>
    deniesSubscribeOverTheVelocityLimit());
  test('adds the subscribe price to the recent-spending total after a committed charge', () =>
    committedSubscribeAccruesPriceMinor(makeHarness()));
});
