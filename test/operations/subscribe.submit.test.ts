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
import { memoryStore } from '#src/adapters/memory.ts';
import { seededDigest, fixedClock } from '#test/support/capabilities.ts';
import {
  topUp as buildTopUp,
  subscribe as buildSubscribe,
  cancelSubscription as buildCancelSubscription,
  credit,
  principal,
} from '#test/support/builders.ts';
import { spendable, earned } from '#src/accounts.ts';

import type { Economy, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// These tests call economy.submit, the full public entry point, so a subscribe request runs
// through every wrapping layer: the permission check that decides who is allowed to act, and
// the subscribe handler's own balance check. The sibling subscribe.test.ts skips those layers
// and calls the handler directly, so this file is what covers the end-to-end path.

// Seed a user's spendable balance by topping it up through the public economy, then assert
// the top-up committed. Other tests use this to give a buyer money before they subscribe.
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

// One user may not start a subscription that charges someone else's account. Here the actor
// is usr_attacker but the account being charged belongs to usr_victim, so the permission check
// rejects the request with an AUTH.UNAUTHORIZED error before any money moves.
async function rejectsAForeignAccount(): Promise<void> {
  let economy = makeEconomy();
  await assert.rejects(
    economy.submit(
      buildSubscribe({
        userId: 'usr_victim',
        sellerId: 'usr_seller',
        sku: 'sub_pro',
        price: credit('100.00'),
        actor: principal('usr_attacker'),
      }),
    ),
    (error: unknown) =>
      (error as { code?: string }).code === 'AUTH.UNAUTHORIZED',
  );
}

// A subscribe attempt by a buyer with no money is an expected "no", not a crash. The handler
// checks the balance itself and returns an outcome whose status is 'rejected' with reason
// INSUFFICIENT_FUNDS; it does not throw an error.
async function rejectsInsufficientFundsCleanly(): Promise<void> {
  let economy = makeEconomy();
  let outcome = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(outcome.status, 'rejected');
  assert.equal(
    (outcome as Extract<Outcome, { status: 'rejected' }>).reason,
    'INSUFFICIENT_FUNDS',
  );
}

// A buyer may not subscribe to themselves. When userId === sellerId the charge would draw the
// buyer's own non-cashable promo/spendable and credit it straight back as cash-outable EARNED,
// funded by the platform's REVENUE — a treasury drain. The handler throws OP.MALFORMED, which
// surfaces as a thrown error (not a rejected outcome) through economy.submit, and no money moves.
async function rejectsSelfSubscription(): Promise<void> {
  let economy = makeEconomy();
  await fund(economy, 'usr_self', '100.00');

  await assert.rejects(
    economy.submit(
      buildSubscribe({
        userId: 'usr_self',
        sellerId: 'usr_self',
        sku: 'sub_pro',
        price: credit('100.00'),
      }),
    ),
    (error: unknown) => (error as { code?: string }).code === 'OP.MALFORMED',
  );

  // Stopped before any posting: the buyer's funded balance is untouched, and nothing accrued.
  assert.deepEqual(
    await economy.read.balance(spendable('usr_self')),
    credit('100.00'),
  );
  assert.deepEqual(
    await economy.read.balance(earned('usr_self')),
    credit('0.00'),
  );
}

// Subscribing bills the first month right away. The buyer's spendable balance (the money they
// topped up) is charged the full price, dropping from 100.00 to 0.00. The seller's earned
// balance (revenue owed to them) goes up by the price minus the platform's fee. The fee is 30%
// in the test config, so 30% of 100.00 = 30.00, leaving the seller 70.00. (The fee is rounded
// up to a whole credit, but 30.00 is already whole, so nothing changes here.)
async function chargesBuyerAndAccruesSellerMonthOne(): Promise<void> {
  let economy = makeEconomy();
  await fund(economy, 'usr_buyer', '100.00');

  let outcome = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('0.00'),
  );
  assert.deepEqual(
    await economy.read.balance(earned('usr_seller')),
    credit('70.00'),
  );
}

// A buyer who already holds an ACTIVE subscription to a given (userId, sku, sellerId) may not
// open a second one to the same triple: that would bill them twice each period. The first
// subscribe commits and charges the buyer once (200.00 funded, 100.00 charged, 100.00 left);
// the second is a clean ALREADY_SUBSCRIBED rejection that moves no money, so the buyer's
// spendable balance still shows exactly one charge and the seller accrued only one month.
async function rejectsSecondActiveSubscription(): Promise<void> {
  let economy = makeEconomy();
  await fund(economy, 'usr_buyer', '200.00');

  let first = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(first.status, 'committed');

  let second = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(second.status, 'rejected');
  assert.equal(
    (second as Extract<Outcome, { status: 'rejected' }>).reason,
    'ALREADY_SUBSCRIBED',
  );

  // Charged exactly once: 200.00 funded minus one 100.00 charge leaves 100.00, and the seller
  // accrued only the single month's net (100.00 less the 30% fee = 70.00).
  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('100.00'),
  );
  assert.deepEqual(
    await economy.read.balance(earned('usr_seller')),
    credit('70.00'),
  );
}

// The guard is scoped to the exact (userId, sku, sellerId) triple, so holding one active
// subscription does not block a different sku or a different seller. Both follow-up subscribes
// commit and bill, draining the buyer's funded 300.00 by three 100.00 charges down to 0.00.
async function allowsDifferentSkuOrSeller(): Promise<void> {
  let economy = makeEconomy();
  await fund(economy, 'usr_buyer', '300.00');

  let first = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(first.status, 'committed');

  // Same buyer + seller, a DIFFERENT sku: a separate product, so it commits.
  let otherSku = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_elite',
      price: credit('100.00'),
    }),
  );
  assert.equal(otherSku.status, 'committed');

  // Same buyer + sku, a DIFFERENT seller: a separate seller's offering, so it commits too.
  let otherSeller = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_other_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(otherSeller.status, 'committed');

  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('0.00'),
  );
}

// Once the first subscription is canceled it is no longer ACTIVE, so the guard lets the buyer
// re-subscribe to the very same triple. This drives a real cancelSubscription through
// economy.submit (as the owning user), looking up the live subscription id from the store the
// economy is built over. The buyer funds 200.00 and is charged twice across the two committed
// subscribes, ending at 0.00.
async function allowsResubscribeAfterCancel(): Promise<void> {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  let store: Store = memoryStore({ digest, clock });
  let economy = makeEconomy(1, store);
  await fund(economy, 'usr_buyer', '200.00');

  let first = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(first.status, 'committed');

  // Find the active subscription's id from the backing store, then cancel it as its owner.
  let active = await store.subscriptions.activeFor(
    'usr_buyer',
    'sub_pro',
    'usr_seller',
  );
  assert.notEqual(active, null);
  let canceled = await economy.submit(
    buildCancelSubscription({
      subscriptionId: active!.id,
      actor: principal('usr_buyer'),
    }),
  );
  assert.equal(canceled.status, 'committed');

  // With no ACTIVE subscription left for the triple, re-subscribing to it commits again.
  let second = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(second.status, 'committed');

  // Two committed subscribes charged the buyer two 100.00 months out of the 200.00 funded.
  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('0.00'),
  );
}

describe('Subscribe Through economy.submit', () => {
  test('rejects a user subscribing on a foreign account', () =>
    rejectsAForeignAccount());
  test('rejects insufficient funds as a clean INSUFFICIENT_FUNDS, not a thrown error', () =>
    rejectsInsufficientFundsCleanly());
  test('rejects a self-subscription (userId === sellerId) with OP.MALFORMED', () =>
    rejectsSelfSubscription());
  test('charges the buyer and accrues month one to the seller', () =>
    chargesBuyerAndAccruesSellerMonthOne());
  test('rejects a second ACTIVE subscription to the same triple as ALREADY_SUBSCRIBED, charging only once', () =>
    rejectsSecondActiveSubscription());
  test('allows a second subscription to a different sku or seller', () =>
    allowsDifferentSkuOrSeller());
  test('allows re-subscribing to the same triple after the first is canceled', () =>
    allowsResubscribeAfterCancel());
});
