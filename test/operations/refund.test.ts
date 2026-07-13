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

// The economy does not route refunds yet, so each test calls the handler directly inside a real
// `store.transaction`.
type Fixture = {
  issue(userId: string, amount: Amount): Promise<void>;
  sell(operation: Operation): Promise<Outcome>;
  refund(operation: Operation): Promise<Outcome>;
  balanceOf(account: AccountRef): Promise<Amount>;
  drainEarned(userId: string, amount: Amount): Promise<void>;
  grant(userId: string, sku: string, attrs?: EntitlementAttrs): Promise<void>;
  owns(userId: string, sku: string): Promise<boolean>;
};

function setup(): Fixture {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const ctx: Ctx = {
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
  const store: Store = memoryStore({ digest, clock });
  const post = (legs: Leg[], meta: Record<string, unknown>): Promise<unknown> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
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
    // Stands in for a settled payout: drains earned into PAYOUT_RESERVE, the state a refund meets
    // when the seller has already cashed out.
    drainEarned: async (userId, amount) => {
      await post(
        [debit(earned(userId), amount), credit(SYSTEM.PAYOUT_RESERVE, amount)],
        { kind: 'settlePayout' },
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

async function returnsBuyerFullPriceReversingSale(): Promise<void> {
  const fx = setup();
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

  const outcome = await fx.refund(refundOf({ orderId: 'ord_refund_1' }));

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
}

async function unwindsSellerEarnedAndPlatformFee(): Promise<void> {
  const fx = setup();
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

  assert.deepEqual(await fx.balanceOf(earned('usr_seller')), creditOf('0.00'));
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

async function postsBalancedReversingEntry(): Promise<void> {
  const fx = setup();
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

  const outcome = await fx.refund(refundOf({ orderId: 'ord_refund_3' }));

  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  const signed = outcome.transaction.legs.reduce(
    (sum: bigint, leg: Leg) => sum + leg.amount.minor,
    0n,
  );
  assert.equal(signed, 0n);
}

async function rejectsUnknownOrderWhenNoSaleRecorded(): Promise<void> {
  const fx = setup();

  const outcome = await fx.refund(refundOf({ orderId: 'ord_missing' }));

  assert.equal(outcome.status, 'rejected');
  if (outcome.status !== 'rejected') return;
  assert.equal(outcome.reason, 'UNKNOWN_ORDER');
}

async function refundsBuyerEvenAfterSellerPaidOut(): Promise<void> {
  const fx = setup();
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

  const sellerCut = await fx.balanceOf(earned('usr_seller'));
  await fx.drainEarned('usr_seller', sellerCut);

  const outcome = await fx.refund(refundOf({ orderId: 'ord_paidout' }));

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
  assert.deepEqual(await fx.balanceOf(earned('usr_seller')), creditOf('0.00'));
  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), sellerCut);
}

async function secondRefundOfSameOrderIsDuplicate(): Promise<void> {
  const fx = setup();
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

  const first = await fx.refund(refundOf({ orderId: 'ord_twice' }));
  assert.equal(first.status, 'committed');

  // The builder mints a fresh idempotency key per call, so retry dedup is not what blocks the
  // second refund — the per-order claim is.
  const second = await fx.refund(refundOf({ orderId: 'ord_twice' }));
  assert.equal(second.status, 'duplicate');
  if (first.status !== 'committed' || second.status !== 'duplicate') return;
  assert.equal(second.transaction.id, first.transaction.id);
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
}

async function refundRevokesBuyerEntitlement(): Promise<void> {
  const fx = setup();
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
  await fx.grant('usr_buyer', 'wrld_pass', { source: 'sale:ord_revoke' });
  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), true);

  await fx.refund(refundOf({ orderId: 'ord_revoke' }));

  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), false);
}

async function refundingAGiftTakesItBackFromTheRecipient(): Promise<void> {
  const fx = setup();
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
  assert.equal(await fx.owns('usr_friend', 'wrld_pass'), true);
  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), false);

  await fx.refund(refundOf({ orderId: 'ord_gift_refund' }));

  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('10.00'),
  );
  assert.equal(await fx.owns('usr_friend', 'wrld_pass'), false);
}

async function refundRevokeIsIdempotentWhenNeverGranted(): Promise<void> {
  const fx = setup();
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

  const outcome = await fx.refund(refundOf({ orderId: 'ord_nogrant' }));

  assert.equal(outcome.status, 'committed');
  assert.equal(await fx.owns('usr_buyer', 'wrld_pass'), false);
}

async function throwsMalformedForBlankOrderId(): Promise<void> {
  const fx = setup();

  await assert.rejects(
    fx.refund(refundOf({ orderId: '   ' })),
    isCode('OP.MALFORMED'),
  );
}

async function throwsMalformedForWrongOperationKind(): Promise<void> {
  const fx = setup();

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
