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

import { refund } from '#src/operations/refund.ts';
import { spend } from '#src/operations/spend.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import type { EntitlementAttrs } from '#src/contract.ts';
import { memoryStore } from '#src/adapters/memory.ts';
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
  refund as refundOf,
  spend as spendOf,
  credit as creditOf,
} from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Store, Unit } from '#src/ports.ts';

// Refund handler harness. The economy doesn't route refunds yet, so each test calls the handler
// directly inside a db transaction with the same transactional handle (`unit`) the real system uses.
//
// A refund reverses a sale, so each test first runs a real purchase through `spend`; that records
// money lines in the sale store under an order id, which the refund looks up and posts the opposites of.
//
// The fixture bundles helpers (issue funds, run a sale, run a refund, read a balance) so each test
// only spells out the thing it's testing.
type Fixture = {
  issue(userId: string, amount: Amount): Promise<void>;
  sell(operation: Operation): Promise<Outcome>;
  refund(operation: Operation): Promise<Outcome>;
  balanceOf(account: AccountRef): Promise<Amount>;
  // Move a seller's whole earned balance out, the way a settled payout would, so a later
  // refund has nothing left to claw back from that seller.
  drainEarned(userId: string, amount: Amount): Promise<void>;
  grant(userId: string, sku: string, attrs?: EntitlementAttrs): Promise<void>;
  owns(userId: string, sku: string): Promise<boolean>;
};

function setup(): Fixture {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  let ctx: Ctx = {
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
  let store: Store = memoryStore({ digest, clock });
  let post = (legs: Leg[], meta: Record<string, unknown>): Promise<unknown> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
    // Give a user spendable funds like a top-up would: post the two ledger lines a top-up posts,
    // leaving the amount in the user's spendable balance for a later sale to draw on.
    issue: async (userId, amount) => {
      await post(
        [debit(SYSTEM.STORED_VALUE, amount), credit(spendable(userId), amount)],
        { kind: 'topUp', source: 'card' },
      );
    },
    sell: (operation) =>
      store.transaction((unit: Unit) => spend(operation, unit, ctx)),
    refund: (operation) =>
      store.transaction((unit: Unit) => refund(operation, unit, ctx)),
    balanceOf: (account) => store.ledger.balance(account),
    // Move the seller's earned balance into PAYOUT_RESERVE. Debiting earned and crediting the reserve
    // by the same amount keeps the posting balanced and leaves earned at zero. This is the state of a
    // seller who has already been paid out when a refund of their sale arrives.
    drainEarned: async (userId, amount) => {
      await post(
        [debit(earned(userId), amount), credit(SYSTEM.PAYOUT_RESERVE, amount)],
        { kind: 'payout.settle' },
      );
    },
    grant: (userId, sku, attrs) =>
      store.transaction((unit: Unit) =>
        unit.entitlements.grant(userId, sku, attrs ?? {}),
      ),
    owns: (userId, sku) => store.entitlements.owns(userId, sku),
  };
}

function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

// --- The cases --------------------------------------------------------------------

async function returnsBuyerFullPriceReversingSale(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_refund_1',
    }),
  );

  let outcome = await fx.refund(refundOf({ orderId: 'ord_refund_1' }));

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
}

async function unwindsSellerEarnedAndPlatformFee(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_refund_2',
    }),
  );

  await fx.refund(refundOf({ orderId: 'ord_refund_2' }));

  // After the refund every account the sale paid into is back to zero: seller earned and platform
  // revenue. Revenue returning to zero means the platform's fee was given back, not kept; the refund
  // undoes every line the sale posted.
  assert.deepEqual(await fx.balanceOf(earned('usr_seller')), creditOf('0.00'));
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

async function postsBalancedReversingEntry(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('20.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_bundle',
      price: creditOf('12.00'),
      recipients: [
        { sellerId: 'usr_a', shareBps: 6_000 },
        { sellerId: 'usr_b', shareBps: 4_000 },
      ],
      orderId: 'ord_refund_3',
    }),
  );

  let outcome = await fx.refund(refundOf({ orderId: 'ord_refund_3' }));

  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  let signed = outcome.transaction.legs.reduce(
    (sum: bigint, leg: Leg) => sum + leg.amount.minor,
    0n,
  );
  assert.equal(signed, 0n);
}

async function rejectsUnknownOrderWhenNoSaleRecorded(): Promise<void> {
  let fx = setup();

  let outcome = await fx.refund(refundOf({ orderId: 'ord_missing' }));

  assert.equal(outcome.status, 'rejected');
  if (outcome.status !== 'rejected') return;
  assert.equal(outcome.reason, 'UNKNOWN_ORDER');
}

// R16: a refund must make the buyer whole even when the seller already paid out the cut the sale
// credited them. The seller is debited only by what's still in earned (here nothing); the
// uncollectable remainder goes to RECEIVABLE so the posting balances.
async function refundsBuyerEvenAfterSellerPaidOut(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_paidout',
    }),
  );

  // Seller withdraws their whole earned cut before the refund, so a naive sign-flip reversal would
  // overdraw earned and roll the whole refund back.
  let sellerCut = await fx.balanceOf(earned('usr_seller'));
  await fx.drainEarned('usr_seller', sellerCut);

  let outcome = await fx.refund(refundOf({ orderId: 'ord_paidout' }));

  // The refund still commits and the buyer is made whole for the full 4.00 price.
  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
  // Nothing was clawed back from the now-empty seller earned (it stays at zero, not negative).
  assert.deepEqual(await fx.balanceOf(earned('usr_seller')), creditOf('0.00'));
  // The slice the platform could not reclaim from the seller lands in RECEIVABLE as a debt owed.
  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), sellerCut);
}

// R17: an order can be reversed at most once. A refund takes a one-time lock keyed by order id
// (`reversed:<orderId>`) before posting. The first refund takes the lock and posts the reversal; a
// second finds it held and gets the first reversal handed back as a duplicate, never crediting twice.
async function secondRefundOfSameOrderIsDuplicate(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_twice',
    }),
  );

  let first = await fx.refund(refundOf({ orderId: 'ord_twice' }));
  assert.equal(first.status, 'committed');

  // Even with a brand-new idempotency key (so the framework's retry dedup would let it through), the
  // second refund is blocked: the first already took the per-order claim, and only one refund per
  // order can win it.
  let second = await fx.refund(refundOf({ orderId: 'ord_twice' }));
  assert.equal(second.status, 'duplicate');
  if (first.status !== 'committed' || second.status !== 'duplicate') return;
  // The duplicate returns the very transaction the first refund posted, not a fresh reversal.
  assert.equal(second.transaction.id, first.transaction.id);
  // The buyer was credited exactly once: balance is the full 10.00, not 14.00.
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
}

// R14/R19: a refund revokes the buyer's entitlement to the SKU in the same transaction, so a
// refunded buyer no longer owns the item.
async function refundRevokesBuyerEntitlement(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_revoke',
    }),
  );
  // Grant the buyer the SKU like a real sale does, so the refund's revoke has a record to reclaim.
  await fx.grant('usr_buyer', 'wrld_pass', { source: 'sale:ord_revoke' });
  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), true);

  await fx.refund(refundOf({ orderId: 'ord_revoke' }));

  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), false);
}

// A gift refunds like any sale, but ownership is reclaimed from the recipient who received it (the
// sale's recorded `recipientId`), not the buyer who paid: the gift granted to the recipient, so the
// refund revokes from the recipient.
async function refundingAGiftTakesItBackFromTheRecipient(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      giftTo: 'usr_friend',
      orderId: 'ord_gift_refund',
    }),
  );
  // The gift granted ownership to the recipient, not the buyer who paid.
  assert.equal(await fx.owns('usr_friend', 'wrld_pass'), true);
  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), false);

  await fx.refund(refundOf({ orderId: 'ord_gift_refund' }));

  // The buyer (who paid) is made whole, and ownership is revoked from the recipient (who held it).
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
  assert.equal(await fx.owns('usr_friend', 'wrld_pass'), false);
}

// R14/R19: revoke is idempotent. Refunding a sale whose buyer was never granted the SKU still
// commits and leaves ownership false, rather than throwing on the absent row.
async function refundRevokeIsIdempotentWhenNeverGranted(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.sell(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: creditOf('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_nogrant',
    }),
  );

  let outcome = await fx.refund(refundOf({ orderId: 'ord_nogrant' }));

  assert.equal(outcome.status, 'committed');
  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), false);
}

// A blank or whitespace-only orderId names no order to reverse. Throw MALFORMED up front rather than
// degrade to an UNKNOWN_ORDER rejected outcome, which would hide the malformed request behind an
// ordinary "no".
async function throwsMalformedForBlankOrderId(): Promise<void> {
  let fx = setup();

  await assert.rejects(
    fx.refund(refundOf({ orderId: '   ' })),
    isCode('OP.MALFORMED'),
  );
}

async function throwsMalformedForWrongOperationKind(): Promise<void> {
  let fx = setup();

  await assert.rejects(
    fx.refund({
      kind: 'topUp',
      idempotencyKey: 'idem_wrong',
      actor: { kind: 'system', service: 'test' },
      userId: 'usr_buyer',
      amount: creditOf('1.00'),
      source: 'card',
    }),
    isCode('OP.MALFORMED'),
  );
}

describe('Refund', () => {
  test('returns the buyer the full price, reversing the recorded sale exactly', () =>
    returnsBuyerFullPriceReversingSale());
  test('unwinds the seller earned and the platform fee, returning the fee too', () =>
    unwindsSellerEarnedAndPlatformFee());
  test('posts a balanced reversing entry, summing every debit and credit line to zero', () =>
    postsBalancedReversingEntry());
  test('rejects with UNKNOWN_ORDER when no sale was recorded for the order', () =>
    rejectsUnknownOrderWhenNoSaleRecorded());
  test('makes the buyer whole and books the remainder to RECEIVABLE when the seller already paid out', () =>
    refundsBuyerEvenAfterSellerPaidOut());
  test('returns the prior reversal as a duplicate on a second refund of the same order', () =>
    secondRefundOfSameOrderIsDuplicate());
  test('revokes the buyer entitlement in the same transaction', () =>
    refundRevokesBuyerEntitlement());
  test('refunding a gift takes the item back from the recipient, not the buyer', () =>
    refundingAGiftTakesItBackFromTheRecipient());
  test('revoke is an idempotent no-op when the buyer was never granted the sku', () =>
    refundRevokeIsIdempotentWhenNeverGranted());
  test('throws a malformed fault when the orderId is blank', () =>
    throwsMalformedForBlankOrderId());
  test('throws a malformed fault when handed the wrong operation kind', () =>
    throwsMalformedForWrongOperationKind());
});
