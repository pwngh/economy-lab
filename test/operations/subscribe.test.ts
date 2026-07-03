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

import { subscribe } from '#src/operations/subscribe.ts';
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
  subscribe as subscribeOp,
  credit,
  emptyVelocity,
} from '#test/support/builders.ts';

import type { Economy, Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// The public `Economy` routes only topUp, grantPromo, and spend, not subscribe. That means
// `economy.submit` cannot reach `subscribe`. This harness exposes two ways into the same
// store: the public `economy` seeds the buyer's funds, and a direct `run` calls `subscribe`
// inside a transaction.
type Harness = {
  economy: Economy;
  store: Store;
  run: (operation: Operation) => Promise<Outcome>;
};

function makeHarness(seed = 1): Harness {
  const digest = seededDigest(seed);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  const ctx: Ctx = {
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
  const economy = createEconomy({
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
      store.transaction((unit) => subscribe(operation, unit, ctx)),
  };
}

// Builds a subscribe for the fixed buyer, seller, and sku used across the suite. Each test then
// supplies only the price, and an optional billing period, it cares about.
function subscribeOf(price: string, periodMs?: number): Operation {
  return subscribeOp({
    userId: 'usr_buyer',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: credit(price),
    periodMs,
  });
}

// Asserts the outcome was a rejection and narrows its type so a caller can read the reason.
function rejectionOf(
  outcome: Outcome,
): Extract<Outcome, { status: 'rejected' }> {
  assert.equal(outcome.status, 'rejected');
  return outcome as Extract<Outcome, { status: 'rejected' }>;
}

// Predicate for `assert.rejects`. Matches the handler's "malformed operation" error, which it
// throws for an out-of-range or wrong-currency price.
function isMalformed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'OP.MALFORMED'
  );
}

// --- Test bodies. One helper per case keeps the describe block short. -------

async function chargesFirstMonthFromSpendable(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  const outcome = await harness.run(subscribeOf('100.50'));

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

  // The 30% fee on 100.01 is 30.003 credits, which falls between whole credits. The rule rounds up,
  // so 31.00 lands in REVENUE rather than 30.00. This price is chosen because the fee is also
  // fractional in minor units (3000.3 minor). A path that floored to minor units before rounding up
  // would drop the 0.3 and settle on 30.00 instead. The test pins that subscribe uses the same
  // `feeForPrice` rule as pricing.ts, which rounds the exact fee up in a single step.
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

  // The charge spends the 40.00 promo grant first, leaving 0.00 promo. The remaining 60.00 of the
  // 100.00 price comes from spendable, so spendable drops from 200.00 to 140.00.
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

  // PROMO_FLOAT offsets outstanding promo grants. Every credit in a user's promo balance has an
  // opposite entry in PROMO_FLOAT, so the two cancel to zero.
  const promoBalance = await harness.economy.read.balance(promo('usr_buyer'));
  const promoFloat = await harness.economy.read.balance(SYSTEM.PROMO_FLOAT);
  assert.equal(promoBalance.minor + promoFloat.minor, 0n);
}

async function rejectsWhenSpendableIsInsufficient(
  harness: Harness,
): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('50.00') }),
  );

  const outcome = await harness.run(subscribeOf('100.00'));

  assert.equal(rejectionOf(outcome).reason, 'INSUFFICIENT_FUNDS');
}

async function opensAnActiveSubscription(harness: Harness): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );
  const periodMs = 2_592_000_000;

  const outcome = await harness.run(subscribeOf('100.00', periodMs));

  assert.equal(outcome.status, 'committed');
  // After billing month one, the subscription should be saved as ACTIVE on period 1, with its next
  // charge due one period out. `claimDue` returns the subscriptions due to bill by the given time.
  const due = await harness.store.subscriptions.claimDue(periodMs, 10);
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

  const outcome = await harness.run(subscribeOf('100.00'));

  assert.equal(outcome.status, 'committed');
  // The SKU is granted in the same transaction as the first-month charge. Ownership lives in the
  // entitlement store, which is reachable only inside a transaction, so open one to read it back.
  const owned = await harness.store.transaction((unit) =>
    unit.entitlements.owns('usr_buyer', 'club_pass'),
  );
  assert.equal(owned, true);
}

// A subscribe charge counts toward the same recent-spending limit as an ordinary spend. The
// velocity window is the running total spent in the current time window. The charge is denied if
// its price would push that total over the configured limit. `assessRisk` is the pure decision
// function the live pipeline calls, so testing it directly checks the shared rule.
function deniesSubscribeOverTheVelocityLimit(): void {
  const config = testConfig();
  // A limit low enough that one max-band subscribe (10,000 credits = 1,000,000 minor) trips it
  // once the window already holds a little spend.
  config.velocityLimitMinor = 1_500_000n;
  const velocity = emptyVelocity('usr_buyer');
  velocity.spent = toAmount('CREDIT', 600_000n); // 6,000 credits already this window

  const operation = subscribeOf('10000.00'); // 1,000,000 minor; projected 1,600,000 > 1,500,000

  const decision = assessRisk(velocity, operation, config);
  assert.equal(decision.allow, false);
  assert.equal(
    decision.allow === false ? decision.reason : null,
    'RISK_DENIED',
  );
}

// Once a subscribe commits, its price is added to the user's running spending total for the window,
// which is the total the recent-spending limit checks against. The pipeline does this after the
// commit by building an attempt record and writing it to the trust store. This test runs that path
// against the real trust store and reads the total back.
async function committedSubscribeAccruesPriceMinor(
  harness: Harness,
): Promise<void> {
  await harness.economy.submit(
    topUp({ userId: 'usr_buyer', amount: credit('200.00') }),
  );

  const operation = subscribeOf('100.00');
  const outcome = await harness.run(operation);
  assert.equal(outcome.status, 'committed');

  // The funding top-up above also counts toward the spending window and already added its own
  // amount, so measure how much the subscribe adds on top rather than the absolute total.
  const before = (await harness.store.trust.read('usr_buyer')).spent.minor;

  // Build the attempt exactly as the pipeline does and write it through the trust store.
  const attempt = riskAttempt(operation, outcome, 0);
  assert.notEqual(attempt, null);
  await harness.store.trust.bump('usr_buyer', attempt!);

  const velocity = await harness.store.trust.read('usr_buyer');
  // Amount added equals the price in minor units (100.00 credits = 10,000 minor; 1 credit = 100 minor).
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
  const operation = subscribeOp({
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

  const outcome = await harness.run(subscribeOf('100.00'));

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

  const report = await harness.economy.read.prove();
  // `conserved` is true when, in every currency, the debits and credits across the whole ledger
  // cancel to zero.
  assert.equal(report.conserved, true);
  // `backed` is true when the cash the platform holds covers the dollar value of every spendable
  // balance and every balance reserved for a pending purchase, with each credit converted at the
  // fixed par rate.
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
