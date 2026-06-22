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
 * These tests call `economy.submit` (the public entry point for one money operation) and
 * then check the event it queued for delivery. Each operation, when it commits, saves one
 * event into the store's outbox (the table of events waiting to be sent to clients); these
 * tests confirm the right event type, audience, and payload fields for each operation kind.
 *
 * The store is built here in the test, rather than created internally by `makeEconomy`, so
 * the test holds a reference to it and can read `store.outbox` after a submit.
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

// Build a fresh store plus an economy that writes to it. Both share one fixed hash function
// (a digest seeded from a constant) and one clock stuck at time 0, so every run produces the
// same ledger hashes and the tests are repeatable. The store is returned too, so a test can
// read back the events a submit queued into it.
function makePair(): { economy: Economy; store: Store } {
  let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  let economy = makeEconomy(1, store);
  return { economy, store };
}

// Take every queued event out of the outbox and return just the events themselves. The
// limit of 100 is more than enough, since one submit queues at most one event. claimBatch
// only reads the still-unsent rows without removing them, so the events are then marked as
// sent ("relayed") to take them out of the queue; without that, a later call here would
// hand back the same events again.
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

// Give a seller a balance of earned credits by posting the entries directly, the way a real
// sale would. Earned credits normally have to age before they can be paid out; the test
// config sets that waiting period to zero, so this balance can be paid out right away.
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
    // The refund request named only an orderId. The buyer is worked out instead from the
    // debit/credit lines that reverse the original sale (those lines name the buyer's account).
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
    // The subscribe handler generates the subscription's id internally, so read it back from
    // the stored subscription record; that way the cancel below targets a real subscription.
    let subscriptionId = await onlySubscriptionId(store, 'usr_buyer');
    await eventsOf(store); // discard topUp + started events

    let outcome = await economy.submit(
      buildCancelSubscription({ subscriptionId }),
    );
    assert.equal(outcome.status, 'committed');
    // A cancel commits without moving any money, so it records no debit/credit lines. The
    // event still gets emitted, because emitting is triggered by the outcome being committed,
    // not by money actually moving. This is the behavior under test: an operation that commits
    // without posting any entries must still produce its event.
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

// Find the user's one active subscription and return its id. Lets the cancel test use the
// actual id the subscribe handler generated, rather than guessing it.
async function onlySubscriptionId(
  store: Store,
  userId: string,
): Promise<string> {
  let due = await store.subscriptions.claimDue(Number.MAX_SAFE_INTEGER, 100);
  let mine = due.filter((subscription) => subscription.userId === userId);
  assert.equal(mine.length, 1);
  return mine[0].id;
}
