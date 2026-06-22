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

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store, Unit } from '#src/ports.ts';
import type { Config } from '#src/config.ts';

// A gift is an ordinary purchase carrying a `giftTo` recipient (VRChat's isGift), NOT a
// wallet-to-wallet move: the buyer pays and is screened, the recipient receives the item.
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
  // The BUYER pays: their spendable balance drops from 10.00 to 6.00.
  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('6.00'),
  );
  // The RECIPIENT owns the purchased item; the buyer does not.
  assert.equal(await store.entitlements.owns('usr_friend', 'wrld_pass'), true);
  assert.equal(await store.entitlements.owns('usr_buyer', 'wrld_pass'), false);
  // The spend still counts against the BUYER's velocity window, not the recipient's — the buyer is
  // who paid, and the risk limit tracks the payer. The window accrued the top-up (1000) plus the
  // gift spend (400) = 1400; the recipient's window stays empty (they paid nothing).
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
    // An Amount is a small object (currency plus an integer count of the smallest unit),
    // not a primitive, so two equal amounts are different objects. Compare their contents
    // with deepEqual, never with == on object identity.
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
      spend({ buyerId: 'usr_buyer', sku: 'wrld_pass', price: credit('4.00') }),
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
    // The books balance: in each currency, all debits add up to all credits.
    assert.equal(report.conserved, true);

    // The credits owed to users are fully backed by real cash. The platform's trust_cash
    // account holds at least the USD needed to cover every user's spendable balance plus
    // the money escrowed for pending purchases (the HELD account), converted at the
    // credit-to-USD rate.
    assert.equal(report.backed, true);
  });
});

// --- The maturity gate, exercised directly on the handler -------------------------
//
// The maturity gate is an in-handler check that runs after the pipeline's up-front
// affordability screen. These tests drive the `spend` handler directly inside one
// `store.transaction` — the way the entry point runs it as its final step — so the gate is
// exercised on its own, the same shape the requestPayout and grantPromo tests use.

// A Ctx and matching store sharing one fixed clock, with the `card` settlement horizon set
// so spendable credit topped up at t=0 only clears at t=horizonMs.
function maturityFixture(horizonMs: number): {
  store: Store;
  ctx: Ctx;
  clock: ReturnType<typeof fixedClock>;
} {
  let clock = fixedClock(0);
  let store = memoryStore({ digest: seededDigest(1), clock });
  let config: Config = {
    ...testConfig(),
    maturityHorizonMs: {
      card: horizonMs,
      crypto: horizonMs,
      default: horizonMs,
    },
  };
  let ctx: Ctx = {
    clock,
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config,
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
  return { store, ctx, clock };
}

// Run a topUp or spend handler directly inside one transaction, the way the entry point
// runs the handler as its final step.
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
  // Buy spendable credit from a card at t=0; it clears at t=60_000.
  await runOp(
    store,
    ctx,
    buildTopUp({
      userId: 'usr_buyer',
      amount: credit('10.00'),
      source: 'card',
    }),
  );

  // Clock still at 0, so none of the spendable credit has matured yet.
  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
    }),
  );

  assert.equal(outcome.status, 'rejected');
  const rejection = outcome as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.reason, 'FUNDS_IMMATURE');
  assert.equal(rejection.detail?.account, spendable('usr_buyer'));
  // The declined spend posted nothing: the spendable balance is untouched.
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

  // Advance the clock to exactly the maturity time. The credit clears at that instant (not
  // only after it), so it is now spendable.
  clock.advance(60_000);
  const outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
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
  // Give the buyer a promo balance large enough to cover the whole price. We do it by hand with
  // the same balanced debit/credit pair grantPromo would post: take 5.00 out of the house
  // PROMO_FLOAT account (a platform account that is allowed to run negative as it funds promos)
  // and put 5.00 into the buyer's promo balance. Promo credit is spent before spendable credit
  // and never has to wait to clear, so this purchase needs zero spendable credit. The maturity
  // check then compares the matured spendable credit available (0) against the spendable credit
  // this spend needs (0), so it passes — the purchase goes through even though the clock has not
  // yet reached the time any topped-up spendable credit would clear.
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
    }),
  );

  assert.equal(outcome.status, 'committed');
  // The whole price came from promo; spendable was never touched.
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

// --- A committed spend's four side effects: grant the bought item, refuse a reused order id,
// --- record the fee, and tag the purchase's age ------------------------------------------
//
// These drive the `spend` handler directly inside one `store.transaction` — the same shape
// as the maturity tests above — so each effect is exercised on its own. Running the handler
// directly (rather than through the full request pipeline) means the pipeline's idempotency
// key — the value that makes a retried request run at most once — is not in play. That is
// exactly the case the handler's own duplicate-order guard must still catch: two genuinely
// different requests that happen to reuse one order id.

// A Ctx + store sharing one fixed clock, with maturity off (topUp clears at t=0) and the
// platform fee set to `feeBps` so the spendable-funded fee posted to REVENUE is predictable.
function spendFixture(feeBps = 3000): { store: Store; ctx: Ctx } {
  let clock = fixedClock(0);
  let store = memoryStore({ digest: seededDigest(1), clock });
  let config: Config = { ...testConfig(), platformFeeBps: feeBps };
  let ctx: Ctx = {
    clock,
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config,
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
  return { store, ctx };
}

async function grantsEntitlementOnSpend(): Promise<void> {
  let { store, ctx } = spendFixture();
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
  );

  let outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
    }),
  );

  assert.equal(outcome.status, 'committed');
  // The buyer owns the SKU after a committed spend — the grant rode in the same transaction.
  let owned = await store.transaction((unit) =>
    unit.entitlements.owns('usr_buyer', 'wrld_pass'),
  );
  assert.equal(owned, true);
}

async function rejectsDuplicateOrderId(): Promise<void> {
  let { store, ctx } = spendFixture();
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
  );

  let first = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      orderId: 'ord_dup',
    }),
  );
  assert.equal(first.status, 'committed');

  // A second request reusing the same orderId (a fresh idempotencyKey is irrelevant — the
  // handler does not see it) is refused as a returned rejection, not a fault.
  let second = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      orderId: 'ord_dup',
    }),
  );
  let rejection = second as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.status, 'rejected');
  assert.equal(rejection.reason, 'DUPLICATE_ORDER');
  assert.equal(rejection.detail?.orderId, 'ord_dup');

  // The buyer was debited exactly once: 10.00 funded minus the single 4.00 charge.
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('6.00'),
  );
}

async function recordsFeeEqualToRevenuePosted(): Promise<void> {
  // The platform fee here is 1530 basis points — 15.30% — of the 400.00 price, which is 61.20.
  // That is not a whole credit, so the fee actually charged rounds UP to 62.00 (an earlier
  // version rounded down to 61.20). The fee written into the Sale record must equal the fee
  // actually moved into the platform's REVENUE account, not the un-rounded figure.
  let { store, ctx } = spendFixture(1530);
  await runOp(
    store,
    ctx,
    buildTopUp({ userId: 'usr_buyer', amount: credit('500.00') }),
  );

  let outcome = await runOp(
    store,
    ctx,
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('400.00'),
      orderId: 'ord_fee',
      // A seller takes the whole net so REVENUE keeps only the fee; without a recipient
      // REVENUE would keep the entire price and there would be nothing to compare the fee to.
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );
  assert.equal(outcome.status, 'committed');

  let sale = await store.transaction((unit) => unit.sales.get('ord_fee'));
  assert.notEqual(sale, null);
  let committed = outcome as Extract<Outcome, { status: 'committed' }>;
  // The whole price came from spendable credit (no promo), so the posting touches the REVENUE
  // account in exactly one debit/credit line: the credit line that records the fee. Credit
  // lines are stored as negative numbers, so we negate it to compare against the positive fee.
  let revenueLeg = committed.transaction.legs.find(
    (leg) => leg.account === SYSTEM.REVENUE,
  );
  assert.notEqual(revenueLeg, undefined);
  assert.equal(sale!.fee.minor, -revenueLeg!.amount.minor);
}

describe('Spend Entitlement, Order, Fee, Age', () => {
  test('grants the buyer the SKU entitlement on a committed spend', () =>
    grantsEntitlementOnSpend());
  test('rejects a second spend reusing the same orderId with DUPLICATE_ORDER', () =>
    rejectsDuplicateOrderId());
  test('records Sale.fee equal to the fee posted to REVENUE on a non-whole-credit fee', () =>
    recordsFeeEqualToRevenuePosted());
});

// --- Op-specific field-shape guards -------------------------------------------------------
//
// These are malformed structured inputs the central validateOperation() guard cannot know
// about, so the handler throws them as MALFORMED faults (a programming/client error), not as
// returned rejections. Driven directly on the handler inside one `store.transaction`, the same
// shape as the maturity and order/fee tests above.

// True when the thrown value is an Error carrying the given fault `code`.
function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

describe('Spend Field Shape', () => {
  test('throws MALFORMED for a blank sku', async () => {
    let { store, ctx } = spendFixture();
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
          orderId: 'ord_blank_sku',
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED for a blank orderId', async () => {
    let { store, ctx } = spendFixture();
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
          orderId: '',
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED when two recipients name the same sellerId', async () => {
    let { store, ctx } = spendFixture();
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
    let { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    // `vrchat:revenue` is a house account, not a user wallet owner — routing a sale's earnings
    // there would credit a platform account as if it were a seller.
    await assert.rejects(
      runOp(
        store,
        ctx,
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          orderId: 'ord_house_seller',
          recipients: [{ sellerId: 'vrchat:revenue', shareBps: 10_000 }],
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('commits a normal spend with a well-shaped recipient', async () => {
    let { store, ctx } = spendFixture();
    await runOp(
      store,
      ctx,
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    let outcome = await runOp(
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
