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

// These go through `economy.submit`, the full public entry point, where the permission check runs;
// sibling subscribe.test.ts calls the handler directly.

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

async function rejectsAForeignAccount(): Promise<void> {
  const economy = makeEconomy();
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

async function rejectsInsufficientFundsCleanly(): Promise<void> {
  const economy = makeEconomy();
  const outcome = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(outcome.status, 'rejected');
  assert.deepEqual(
    (outcome as Extract<Outcome, { status: 'rejected' }>).detail,
    {
      reason: 'INSUFFICIENT_FUNDS',
      account: spendable('usr_buyer'),
      need: credit('100.00'),
      have: credit('0.00'),
    },
  );
}

async function rejectsSelfSubscription(): Promise<void> {
  const economy = makeEconomy();
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

  // The throw stops the operation before posting, so the buyer's funded balance is untouched
  // and nothing accrued.
  assert.deepEqual(
    await economy.read.balance(spendable('usr_self')),
    credit('100.00'),
  );
  assert.deepEqual(
    await economy.read.balance(earned('usr_self')),
    credit('0.00'),
  );
}

// The test config's platform fee is 30%, so the seller nets 70.00 of the 100.00 price.
async function chargesBuyerAndAccruesSellerMonthOne(): Promise<void> {
  const economy = makeEconomy();
  await fund(economy, 'usr_buyer', '100.00');

  const outcome = await economy.submit(
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

async function rejectsSecondActiveSubscription(): Promise<void> {
  const economy = makeEconomy();
  await fund(economy, 'usr_buyer', '200.00');

  const first = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(first.status, 'committed');

  const second = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(second.status, 'rejected');
  assert.deepEqual(
    (second as Extract<Outcome, { status: 'rejected' }>).detail,
    { reason: 'ALREADY_SUBSCRIBED', userId: 'usr_buyer', sku: 'sub_pro' },
  );

  assert.deepEqual(
    await economy.read.balance(spendable('usr_buyer')),
    credit('100.00'),
  );
  assert.deepEqual(
    await economy.read.balance(earned('usr_seller')),
    credit('70.00'),
  );
}

async function allowsDifferentSkuOrSeller(): Promise<void> {
  const economy = makeEconomy();
  await fund(economy, 'usr_buyer', '300.00');

  const first = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(first.status, 'committed');

  const otherSku = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_elite',
      price: credit('100.00'),
    }),
  );
  assert.equal(otherSku.status, 'committed');

  const otherSeller = await economy.submit(
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

async function allowsResubscribeAfterCancel(): Promise<void> {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store: Store = memoryStore({ digest, clock });
  const economy = makeEconomy(1, store);
  await fund(economy, 'usr_buyer', '200.00');

  const first = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(first.status, 'committed');

  const active = await store.subscriptions.activeFor(
    'usr_buyer',
    'sub_pro',
    'usr_seller',
  );
  assert.notEqual(active, null);
  const canceled = await economy.submit(
    buildCancelSubscription({
      subscriptionId: active!.id,
      actor: principal('usr_buyer'),
    }),
  );
  assert.equal(canceled.status, 'committed');

  const second = await economy.submit(
    buildSubscribe({
      userId: 'usr_buyer',
      sellerId: 'usr_seller',
      sku: 'sub_pro',
      price: credit('100.00'),
    }),
  );
  assert.equal(second.status, 'committed');

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
