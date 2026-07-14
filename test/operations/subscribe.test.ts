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
import { economyFromCapabilities } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable, promo, earned, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';
import { assessRisk, riskAttempt, attemptMinor } from '#src/trust.ts';
import {
  fixedClock,
  seededDigest,
  seededSigner,
  testConfig,
  makeCtx,
} from '#test/support/capabilities.ts';
import {
  topUp,
  grantPromo,
  subscribe as subscribeOp,
  credit,
  emptyVelocity,
} from '#test/support/builders.ts';

import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// The harness exposes two ways into one store: the public economy seeds the buyer's funds, and
// `run` calls the subscribe handler directly inside a transaction.
type Harness = {
  economy: Economy;
  store: Store;
  run: (operation: Operation) => Promise<Outcome>;
};

function makeHarness(seed = 1): Harness {
  const digest = seededDigest(seed);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  const ctx = makeCtx({ clock, digest, signer: seededSigner(seed) });
  const economy = economyFromCapabilities({
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

function subscribeOf(price: string, periodMs?: number): Operation {
  return subscribeOp({
    userId: 'usr_buyer',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: credit(price),
    periodMs,
  });
}

function rejectionOf(
  outcome: Outcome,
): Extract<Outcome, { status: 'rejected' }> {
  assert.equal(outcome.status, 'rejected');
  return outcome as Extract<Outcome, { status: 'rejected' }>;
}

function isMalformed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'OP.MALFORMED'
  );
}

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

  // 100.01 makes the fee fractional in minor units too (30.003 credits = 3000.3 minor): a path
  // that floored to minor units before rounding up would settle on 30.00 instead of 31.00.
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
  // claimDue returns the subscriptions due to bill by the given time.
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
  // The entitlement store is reachable only inside a transaction, so open one to read it back.
  const owned = await harness.store.transaction((unit) =>
    unit.entitlements.owns('usr_buyer', 'club_pass'),
  );
  assert.equal(owned, true);
}

// assessRisk is the pure decision function the live pipeline calls, so this tests the shared
// rule directly, without a store.
function deniesSubscribeOverTheVelocityLimit(): void {
  const config = testConfig();
  config.velocityLimitMinor = 1_500_000n;
  const velocity = emptyVelocity('usr_buyer');
  velocity.spent = toAmount('CREDIT', 600_000n);

  const operation = subscribeOf('10000.00'); // 1,000,000 minor; projected 1,600,000 > 1,500,000

  const decision = assessRisk(velocity, operation, config);
  assert.equal(decision.allow, false);
  assert.equal(
    decision.allow === false ? decision.reason : null,
    'RISK_DENIED',
  );
}

// The pipeline accrues velocity after the commit by building an attempt record and bumping the
// trust store; this replays that path by hand.
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

  const attempt = riskAttempt(operation, outcome, 0);
  assert.notEqual(attempt, null);
  await harness.store.trust.bump('usr_buyer', attempt!);

  const velocity = await harness.store.trust.read('usr_buyer');
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
  assert.equal(report.conserved, true);
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
