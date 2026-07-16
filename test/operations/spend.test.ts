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

import { makeEconomy } from '#test/support/economy.ts';
import {
  topUp as buildTopUp,
  grantPromo,
  spend as buildSpend,
  spend,
  topUp,
  credit,
} from '#test/support/builders.ts';
import { spend as runSpend } from '#src/operations/spend.ts';
import { topUp as runTopUp } from '#src/operations/topUp.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { spendable, promo, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  seededDigest,
  testConfig,
  makeCtx,
  hasCode as isCode,
} from '#test/support/capabilities.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store, Unit } from '#src/ports.ts';
import type { Config } from '#src/config.ts';

async function giftsToRecipientWhileChargingBuyer(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  const economy = makeEconomy(1, store);
  await economy.submit(topUp({ userId: 'usr_buyer', amount: credit('10.00') }));

  const outcome = await economy.submit(
    spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      giftTo: 'usr_friend',
    }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('6.00'),
  );
  assert.equal(await store.entitlements.owns('usr_friend', 'wrld_pass'), true);
  assert.equal(await store.entitlements.owns('usr_buyer', 'wrld_pass'), false);
  // The buyer's window accrued both the top-up (1000 minor) and the gift spend (400); the recipient
  // paid nothing.
  assert.equal((await store.trust.read('usr_buyer')).spent.minor, 1400n);
  assert.equal((await store.trust.read('usr_friend')).spent.minor, 0n);
}

describe('Spend', () => {
  test('spends promo before spendable', async () => {
    const economy = makeEconomy();
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    await economy.submit(
      grantPromo({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    const outcome = await economy.submit(
      spend({
        buyerId: 'usr_buyer',
        sku: 'wrld_pass',
        price: credit('4.00'),
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await economy.read.balance(promo('usr_buyer')),
      credit('1.00'),
    );
    assert.deepEqual(
      await economy.read.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
  });

  test('gifts the item to the recipient while charging the buyer, and the buyer velocity still accrues', () =>
    giftsToRecipientWhileChargingBuyer());

  test('rejects spend when spendable is insufficient', async () => {
    const economy = makeEconomy();
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('3.00') }),
    );

    const outcome = await economy.submit(
      spend({
        buyerId: 'usr_buyer',
        sku: 'wrld_pass',
        price: credit('4.00'),
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      }),
    );

    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.reason, 'INSUFFICIENT_FUNDS');
  });

  test('keeps debits equal to credits across an N-way split', async () => {
    const economy = makeEconomy();
    await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('20.00') }),
    );

    await economy.submit(
      spend({
        buyerId: 'usr_buyer',
        sku: 'wrld_bundle',
        price: credit('12.00'),
        recipients: [
          { sellerId: 'usr_a', shareBps: 6_000 },
          { sellerId: 'usr_b', shareBps: 4_000 },
        ],
      }),
    );

    const report = await economy.read.prove();
    assert.equal(report.conserved, true);

    // backed: TRUST_CASH covers every user's spendable balance at the CREDIT-to-USD rate.
    assert.equal(report.backed, true);
  });
});

// --- The maturity gate: an in-handler check; these tests drive `spend` directly inside one
// `store.transaction`.

// Store and Ctx share one fixed clock; spendable topped up at t=0 matures at t=horizonMs.
function maturityFixture(horizonMs: number): {
  store: Store;
  ctx: Ctx;
  clock: ReturnType<typeof fixedClock>;
} {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  const config: Config = {
    ...testConfig(),
    maturityHorizonMs: {
      card: horizonMs,
      crypto: horizonMs,
      default: horizonMs,
    },
  };
  const ctx = makeCtx({ clock, config });
  return { store, ctx, clock };
}

function runOp(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => {
    if (operation.kind === 'topUp') {
      return runTopUp(operation, unit, ctx);
    }
    return runSpend(operation, unit, ctx);
  });
}

async function rejectsSpendDrawingOnImmatureCredit(): Promise<void> {
  const { store, ctx } = maturityFixture(60_000);
  await runOp(
    store,
    ctx,
    buildTopUp({
      userId: 'usr_buyer',
      amount: credit('10.00'),
      source: 'card',
    }),
  );

  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );

  assert.equal(outcome.status, 'rejected');
  const rejection = outcome as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.reason, 'FUNDS_IMMATURE');
  assert.equal(rejection.detail?.account, spendable('usr_buyer'));
  assert.equal(typeof rejection.detail?.availableAt, 'number');
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('10.00'),
  );
}

async function allowsSpendOnceCreditHasMatured(): Promise<void> {
  const { store, ctx, clock } = maturityFixture(60_000);
  await runOp(
    store,
    ctx,
    buildTopUp({
      userId: 'usr_buyer',
      amount: credit('10.00'),
      source: 'card',
    }),
  );

  // The boundary is inclusive: credit matures at the exact instant its wait ends.
  clock.advance(60_000);
  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('6.00'),
  );
}

async function doesNotGateThePromoFundedPart(): Promise<void> {
  const { store, ctx } = maturityFixture(60_000);
  // Seeds promo by hand with the same balanced pair grantPromo posts. Promo funds the whole price,
  // so the spendable part the maturity gate checks is zero.
  await store.transaction(async (unit) => {
    await unit.ledger.append({
      txnId: 'txn_seed_promo',
      legs: [
        debitLeg(SYSTEM.PROMO_FLOAT, credit('5.00')),
        creditLeg(promo('usr_buyer'), credit('5.00')),
      ],
      meta: { kind: 'seed' },
    });
  });

  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(promo('usr_buyer')),
    credit('1.00'),
  );
}

describe('Spend Maturity Gate', () => {
  test('rejects a spend whose spendable part draws on immature credit (FUNDS_IMMATURE)', () =>
    rejectsSpendDrawingOnImmatureCredit());
  test('allows a spend once the spendable credit has matured', () =>
    allowsSpendOnceCreditHasMatured());
  test('does not gate the promo-funded part on maturity', () =>
    doesNotGateThePromoFundedPart());
});

// --- Side effects of a committed spend, driven directly on the handler.

// Shares one fixed clock, with maturity off so a topUp matures at t=0; the platform fee is `feeBps`.
function spendFixture(feeBps = 3000): { store: Store; ctx: Ctx } {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  const config: Config = { ...testConfig(), platformFeeBps: feeBps };
  const ctx = makeCtx({ clock, config });
  return { store, ctx };
}

async function grantsEntitlementOnSpend(): Promise<void> {
  const { store, ctx } = spendFixture();
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
  );

  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );

  assert.equal(outcome.status, 'committed');
  const owned = await store.transaction((unit) =>
    unit.entitlements.owns('usr_buyer', 'wrld_pass'),
  );
  assert.equal(owned, true);
}

async function rejectsDuplicateOrderId(): Promise<void> {
  const { store, ctx } = spendFixture();
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
  );

  const first = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_dup',
    }),
  );
  assert.equal(first.status, 'committed');

  // A second request reusing the same orderId (a fresh idempotencyKey is irrelevant; the handler
  // does not see it) is refused as a returned rejection, not a fault.
  const second = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_dup',
    }),
  );
  const rejection = second as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.status, 'rejected');
  assert.equal(rejection.reason, 'DUPLICATE_ORDER');
  assert.equal(rejection.detail?.orderId, 'ord_dup');

  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('6.00'),
  );
}

async function recordsFeeEqualToRevenuePosted(): Promise<void> {
  // 1530 bps of 400.00 is 61.20, not a whole credit, so the fee charged rounds up to 62.00;
  // Sale.fee must equal what actually moved into REVENUE.
  const { store, ctx } = spendFixture(1530);
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('500.00') }),
  );

  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('400.00'),
      orderId: 'ord_fee',
      // The seller takes the whole net, so REVENUE keeps only the fee.
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );
  assert.equal(outcome.status, 'committed');

  const sale = await store.transaction((unit) => unit.sales.get('ord_fee'));
  assert.notEqual(sale, null);
  const committed = outcome as Extract<Outcome, { status: 'committed' }>;
  // No promo part, so REVENUE has exactly one leg: the fee. Credit legs store as negatives, so
  // negate to compare.
  const revenueLeg = committed.transaction.legs.find(
    (leg) => leg.account === SYSTEM.REVENUE,
  );
  assert.notEqual(revenueLeg, undefined);
  assert.equal(sale!.fee.minor, -revenueLeg!.amount.minor);
}

async function recordsFeeIncludingResidualOnUnevenSplit(): Promise<void> {
  // Each seller's share floors, so the uneven three-way split of the 338.00 net leaves a 2-minor
  // residual that REVENUE keeps on top of the 62.00 fee; Sale.fee must record the full 62.02.
  const { store, ctx } = spendFixture(1530);
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('500.00') }),
  );

  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('400.00'),
      orderId: 'ord_fee_uneven',
      recipients: [
        { sellerId: 'usr_a', shareBps: 3_333 },
        { sellerId: 'usr_b', shareBps: 3_333 },
        { sellerId: 'usr_c', shareBps: 3_334 },
      ],
    }),
  );
  assert.equal(outcome.status, 'committed');

  const sale = await store.transaction((unit) =>
    unit.sales.get('ord_fee_uneven'),
  );
  assert.notEqual(sale, null);
  const committed = outcome as Extract<Outcome, { status: 'committed' }>;
  const revenueLeg = committed.transaction.legs.find(
    (leg) => leg.account === SYSTEM.REVENUE,
  );
  assert.notEqual(revenueLeg, undefined);
  assert.equal(sale!.fee.minor, -revenueLeg!.amount.minor);
  assert.equal(sale!.fee.minor, 6202n);
}

describe('Spend Entitlement, Order, Fee, Age', () => {
  test('grants the buyer the SKU entitlement on a committed spend', () =>
    grantsEntitlementOnSpend());
  test('rejects a second spend reusing the same orderId with DUPLICATE_ORDER', () =>
    rejectsDuplicateOrderId());
  test('records Sale.fee equal to the fee posted to REVENUE on a non-whole-credit fee', () =>
    recordsFeeEqualToRevenuePosted());
  test('records Sale.fee including the rounding residual on an uneven multi-seller split', () =>
    recordsFeeIncludingResidualOnUnevenSplit());
});

// --- Op-specific field-shape guards: malformed shapes the central validateOperation() cannot
// know about.

describe('Spend Field Shape', () => {
  test('throws MALFORMED for an empty recipients list', async () => {
    const { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    await assert.rejects(
      runOp(
        store,
        ctx,
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [],
          orderId: 'ord_no_recipients',
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED for a blank sku', async () => {
    const { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    await assert.rejects(
      runOp(
        store,
        ctx,
        buildSpend({
          buyerId: 'usr_buyer',
          sku: '   ',
          price: credit('4.00'),
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
          orderId: 'ord_blank_sku',
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED for a blank orderId', async () => {
    const { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    await assert.rejects(
      runOp(
        store,
        ctx,
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
          orderId: '',
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED when two recipients name the same sellerId', async () => {
    const { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    await assert.rejects(
      runOp(
        store,
        ctx,
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          orderId: 'ord_dup_seller',
          recipients: [
            { sellerId: 'usr_seller', shareBps: 5_000 },
            { sellerId: 'usr_seller', shareBps: 5_000 },
          ],
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED when a recipient sellerId is a house account', async () => {
    const { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    await assert.rejects(
      runOp(
        store,
        ctx,
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          orderId: 'ord_house_seller',
          recipients: [{ sellerId: 'platform:revenue', shareBps: 10_000 }],
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('commits a normal spend with a well-shaped recipient', async () => {
    const { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    const outcome = await runOp(
      store,
      ctx,
      buildSpend({
        buyerId: 'usr_buyer',
        sku: 'wrld_pass',
        price: credit('4.00'),
        orderId: 'ord_ok',
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
  });
});
