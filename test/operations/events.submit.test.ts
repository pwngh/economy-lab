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
 * Call `economy.submit` and check the event it queues: a committed operation writes one event to
 * the store's outbox.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { economyWithStore, eventsOf } from '#test/support/economy.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import {
  topUp as buildTopUp,
  spend as buildSpend,
  refund as buildRefund,
  clawback as buildClawback,
  requestPayout as buildRequestPayout,
  subscribe as buildSubscribe,
  cancelSubscription as buildCancelSubscription,
  credit,
} from '#test/support/builders.ts';

import type { Economy } from '#src/contract.ts';
import type { Store, EconomyEvent } from '#src/ports.ts';
import type { Amount } from '#src/money.ts';

async function fund(
  economy: Economy,
  userId: string,
  amount: string,
): Promise<void> {
  const outcome = await economy.submit(
    buildTopUp({ userId, amount: credit(amount) }),
  );
  assert.equal(outcome.status, 'committed');
}

// Seeds earned directly. The test config zeroes the maturity period, so the balance is immediately
// payable.
async function fundEarned(
  store: Store,
  userId: string,
  amount: Amount,
): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.ledger.append({
      txnId: `txn_seed_${userId}`,
      legs: [
        debitLeg(SYSTEM.REVENUE, amount),
        creditLeg(earned(userId), amount),
      ],
      meta: { kind: 'seed' },
    });
  });
}

async function onlyEvent(store: Store): Promise<EconomyEvent> {
  const events = await eventsOf(store);
  assert.equal(events.length, 1);
  return events[0];
}

describe('Submit-Path Domain Events', () => {
  test('a refund emits economy.sale.refunded whose subject is the buyer derived from the debit/credit lines', async () => {
    const { economy, store } = economyWithStore(1);
    await fund(economy, 'usr_buyer', '10.00');

    const spend = buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      orderId: 'ord_refund_1',
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    });
    const bought = await economy.submit(spend);
    assert.equal(bought.status, 'committed');
    await eventsOf(store); // discard topUp + spend events

    const refunded = await economy.submit(
      buildRefund({ orderId: 'ord_refund_1' }),
    );
    assert.equal(refunded.status, 'committed');

    const event = await onlyEvent(store);
    assert.equal(event.type, 'economy.sale.refunded');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, 'usr_buyer');
    assert.equal(event.data.buyerId, 'usr_buyer');
    assert.equal(event.data.orderId, 'ord_refund_1');
  });

  test('a clawback emits an internal economy.credits.clawed_back for the affected user', async () => {
    const { economy, store } = economyWithStore(1);
    await fund(economy, 'usr_disputer', '10.00');
    await eventsOf(store);

    const outcome = await economy.submit(
      buildClawback({
        userId: 'usr_disputer',
        amount: credit('4.00'),
        orderId: 'ord_cb_1',
      }),
    );
    assert.equal(outcome.status, 'committed');

    const event = await onlyEvent(store);
    assert.equal(event.type, 'economy.credits.clawed_back');
    assert.equal(event.audience, 'internal');
    assert.equal(event.subject, 'usr_disputer');
    assert.equal(event.data.userId, 'usr_disputer');
    assert.equal(event.data.amount, 'CREDIT:4.00');
    assert.equal(event.data.orderId, 'ord_cb_1');
  });
});

describe('Submit-Path Domain Events (Payouts & Subscriptions)', () => {
  test('a committed requestPayout emits economy.payout.requested for the seller', async () => {
    const { economy, store } = economyWithStore(1);
    await fundEarned(store, 'usr_seller', credit('20.00'));

    const outcome = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('20.00') }),
    );
    assert.equal(outcome.status, 'committed');

    const event = await onlyEvent(store);
    assert.equal(event.type, 'economy.payout.requested');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, 'usr_seller');
    assert.equal(event.data.userId, 'usr_seller');
    assert.equal(event.data.amount, 'CREDIT:20.00');
  });

  test('subscribe emits economy.subscription.started with {userId,sku,period}', async () => {
    const { economy, store } = economyWithStore(1);
    await fund(economy, 'usr_buyer', '100.00');
    await eventsOf(store);

    const outcome = await economy.submit(
      buildSubscribe({
        userId: 'usr_buyer',
        sellerId: 'usr_seller',
        sku: 'sub_pro',
        price: credit('100.00'),
      }),
    );
    assert.equal(outcome.status, 'committed');

    const event = await onlyEvent(store);
    assert.equal(event.type, 'economy.subscription.started');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, 'usr_buyer');
    assert.equal(event.data.userId, 'usr_buyer');
    assert.equal(event.data.sku, 'sub_pro');
    assert.equal(event.data.period, 1);
  });

  test('cancelSubscription emits economy.subscription.canceled even though it records no debit/credit lines', async () => {
    const { economy, store } = economyWithStore(1);
    await fund(economy, 'usr_buyer', '100.00');

    const started = await economy.submit(
      buildSubscribe({
        userId: 'usr_buyer',
        sellerId: 'usr_seller',
        sku: 'sub_pro',
        price: credit('100.00'),
      }),
    );
    assert.equal(started.status, 'committed');
    const subscriptionId = await onlySubscriptionId(store, 'usr_buyer');
    await eventsOf(store); // discard topUp + started events

    const outcome = await economy.submit(
      buildCancelSubscription({ subscriptionId }),
    );
    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      (outcome as Extract<typeof outcome, { status: 'committed' }>).transaction
        .legs,
      [],
    );

    const event = await onlyEvent(store);
    assert.equal(event.type, 'economy.subscription.canceled');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, subscriptionId);
    assert.equal(event.data.subscriptionId, subscriptionId);
  });
});

// Subscribe generates the subscription id internally, so read it back from the store.
async function onlySubscriptionId(
  store: Store,
  userId: string,
): Promise<string> {
  const due = await store.subscriptions.claimDue(Number.MAX_SAFE_INTEGER, 100);
  const mine = due.filter((subscription) => subscription.userId === userId);
  assert.equal(mine.length, 1);
  return mine[0].id;
}
