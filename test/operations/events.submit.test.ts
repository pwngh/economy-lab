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
 * Call `economy.submit` and check the event it queues. A committed operation writes one event
 * to the store's outbox; these tests assert the event type, audience, and payload fields per
 * operation kind. The store is built here (not inside `makeEconomy`) so the test can read
 * `store.outbox` after a submit.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { seededDigest, fixedClock } from '#test/support/capabilities.ts';
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

// Fresh store plus an economy writing to it, sharing a seeded digest and a clock fixed at 0 so
// ledger hashes are deterministic. The store is returned so tests can read back queued events.
function makePair(): { economy: Economy; store: Store } {
  let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  let economy = makeEconomy(1, store);
  return { economy, store };
}

// Drain the outbox and return the events. Limit 100 is plenty (one submit queues at most one
// event). claimBatch reads unsent rows without removing them, so mark them relayed afterward;
// otherwise a later call hands back the same events.
async function eventsOf(store: Store): Promise<EconomyEvent[]> {
  let batch = await store.outbox.claimBatch(100);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  return batch.map((message) => message.event);
}

// Fund a user's spendable balance through the public top-up path, then assert it committed.
async function fund(
  economy: Economy,
  userId: string,
  amount: string,
): Promise<void> {
  let outcome = await economy.submit(
    buildTopUp({ userId, amount: credit(amount) }),
  );
  assert.equal(outcome.status, 'committed');
}

// Seed a seller's earned-credit balance by posting the entries directly, as a real sale would.
// Earned credits normally age before payout; the test config sets that period to zero, so this
// balance is immediately payable.
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

// The single event a submit enqueued, asserting exactly one was emitted.
async function onlyEvent(store: Store): Promise<EconomyEvent> {
  let events = await eventsOf(store);
  assert.equal(events.length, 1);
  return events[0];
}

describe('Submit-Path Domain Events', () => {
  test('a refund emits economy.sale.refunded whose subject is the buyer derived from the debit/credit lines', async () => {
    let { economy, store } = makePair();
    await fund(economy, 'usr_buyer', '10.00');

    let spend = buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      orderId: 'ord_refund_1',
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    });
    let bought = await economy.submit(spend);
    assert.equal(bought.status, 'committed');
    await eventsOf(store); // discard topUp + spend events

    let refunded = await economy.submit(
      buildRefund({ orderId: 'ord_refund_1' }),
    );
    assert.equal(refunded.status, 'committed');

    let event = await onlyEvent(store);
    assert.equal(event.type, 'economy.sale.refunded');
    assert.equal(event.audience, 'client');
    // The refund request named only an orderId; the buyer is derived from the reversing
    // debit/credit lines, which name the buyer's account.
    assert.equal(event.subject, 'usr_buyer');
    assert.equal(event.data.buyerId, 'usr_buyer');
    assert.equal(event.data.orderId, 'ord_refund_1');
  });

  test('a clawback emits an internal economy.credits.clawed_back for the affected user', async () => {
    let { economy, store } = makePair();
    await fund(economy, 'usr_disputer', '10.00');
    await eventsOf(store);

    let outcome = await economy.submit(
      buildClawback({
        userId: 'usr_disputer',
        amount: credit('4.00'),
        orderId: 'ord_cb_1',
      }),
    );
    assert.equal(outcome.status, 'committed');

    let event = await onlyEvent(store);
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
    let { economy, store } = makePair();
    await fundEarned(store, 'usr_seller', credit('20.00'));

    let outcome = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('20.00') }),
    );
    assert.equal(outcome.status, 'committed');

    let event = await onlyEvent(store);
    assert.equal(event.type, 'economy.payout.requested');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, 'usr_seller');
    assert.equal(event.data.userId, 'usr_seller');
    assert.equal(event.data.amount, 'CREDIT:20.00');
  });

  test('subscribe emits economy.subscription.started with {userId,sku,period}', async () => {
    let { economy, store } = makePair();
    await fund(economy, 'usr_buyer', '100.00');
    await eventsOf(store);

    let outcome = await economy.submit(
      buildSubscribe({
        userId: 'usr_buyer',
        sellerId: 'usr_seller',
        sku: 'sub_pro',
        price: credit('100.00'),
      }),
    );
    assert.equal(outcome.status, 'committed');

    let event = await onlyEvent(store);
    assert.equal(event.type, 'economy.subscription.started');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, 'usr_buyer');
    assert.equal(event.data.userId, 'usr_buyer');
    assert.equal(event.data.sku, 'sub_pro');
    assert.equal(event.data.period, 1);
  });

  test('cancelSubscription emits economy.subscription.canceled even though it records no debit/credit lines', async () => {
    let { economy, store } = makePair();
    await fund(economy, 'usr_buyer', '100.00');

    let started = await economy.submit(
      buildSubscribe({
        userId: 'usr_buyer',
        sellerId: 'usr_seller',
        sku: 'sub_pro',
        price: credit('100.00'),
      }),
    );
    assert.equal(started.status, 'committed');
    // The subscribe handler generates the subscription id internally; read it back from the
    // stored record so the cancel below targets a real subscription.
    let subscriptionId = await onlySubscriptionId(store, 'usr_buyer');
    await eventsOf(store); // discard topUp + started events

    let outcome = await economy.submit(
      buildCancelSubscription({ subscriptionId }),
    );
    assert.equal(outcome.status, 'committed');
    // A cancel commits without moving money, so it records no debit/credit lines. Emission is
    // triggered by the committed outcome, not by money moving, so the event still fires. That's
    // the behavior under test: a commit with no entries must still produce its event.
    assert.deepEqual(
      (outcome as Extract<typeof outcome, { status: 'committed' }>).transaction
        .legs,
      [],
    );

    let event = await onlyEvent(store);
    assert.equal(event.type, 'economy.subscription.canceled');
    assert.equal(event.audience, 'client');
    assert.equal(event.subject, subscriptionId);
    assert.equal(event.data.subscriptionId, subscriptionId);
  });
});

// Return the user's one active subscription id, so the cancel test uses the id the subscribe
// handler actually generated.
async function onlySubscriptionId(
  store: Store,
  userId: string,
): Promise<string> {
  let due = await store.subscriptions.claimDue(Number.MAX_SAFE_INTEGER, 100);
  let mine = due.filter((subscription) => subscription.userId === userId);
  assert.equal(mine.length, 1);
  return mine[0].id;
}
