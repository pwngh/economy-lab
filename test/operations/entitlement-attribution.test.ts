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

import { sweepDueSubscriptions } from '#src/worker/subscriptions.ts';
import { spendable } from '#src/accounts.ts';
import { economyWithStore } from '#test/support/economy.ts';
import {
  credit,
  refund as buildRefund,
  revokeEntitlement as buildRevokeEntitlement,
  spend as buildSpend,
  subscribe as buildSubscribe,
  topUp as buildTopUp,
} from '#test/support/builders.ts';
import { makeWorkerCtx } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// One row per (userId, sku) made every revoker a confiscation: a second unrefunded order, or a
// second seller's subscription, kept paying for an item the first revoke had already taken away.
// Each case below buys the same sku twice and ends exactly one of the two.

const PERIOD_MS = 30 * 24 * 60 * 60_000;

async function buy(
  economy: Economy,
  orderId: string,
  price: string,
): Promise<void> {
  const sold = await economy.submit(
    buildSpend({
      buyerId: 'usr_bob',
      sku: 'gold_trim',
      price: credit(price),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId,
    }),
  );
  assert.equal(sold.status, 'committed');
}

async function sourcesOf(store: Store, userId: string): Promise<string[]> {
  for await (const grant of store.entitlements.list(userId)) {
    if (grant.sku === 'gold_trim' || grant.sku === 'club_pass') {
      return [...grant.sources].sort();
    }
  }
  return [];
}

describe('Entitlement revocation is attributed to the grant it undoes', () => {
  test('refunding one order leaves the other order’s ownership standing', async () => {
    const { economy, store } = economyWithStore();
    await economy.submit(
      buildTopUp({ userId: 'usr_bob', amount: credit('100.00') }),
    );
    await buy(economy, 'ord_one', '5.00');
    await buy(economy, 'ord_two', '6.00');
    assert.equal(await store.entitlements.owns('usr_bob', 'gold_trim'), true);

    const first = await economy.submit(buildRefund({ orderId: 'ord_one' }));
    assert.equal(first.status, 'committed');

    // The money side was always exact: only ord_one's 5.00 came back.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_bob')),
      credit('94.00'),
    );
    // The ownership side used to go false here, while ord_two stood unrefunded.
    assert.equal(await store.entitlements.owns('usr_bob', 'gold_trim'), true);
    assert.deepEqual(await sourcesOf(store, 'usr_bob'), ['sale:ord_two']);

    const second = await economy.submit(buildRefund({ orderId: 'ord_two' }));
    assert.equal(second.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_bob', 'gold_trim'), false);
    assert.deepEqual(await sourcesOf(store, 'usr_bob'), []);
  });

  test('a lapsed subscription leaves the other seller’s subscription owning the sku', async () => {
    const { economy, store } = economyWithStore();
    // Two first charges at the price-band floor, and nothing left for either renewal.
    await economy.submit(
      buildTopUp({ userId: 'usr_bob', amount: credit('200.00') }),
    );
    const first = await economy.submit(
      buildSubscribe({
        userId: 'usr_bob',
        sellerId: 'usr_seller_a',
        sku: 'club_pass',
        price: credit('100.00'),
        periodMs: PERIOD_MS,
      }),
    );
    assert.equal(first.status, 'committed');
    // subscribe refuses a duplicate only on (userId, sku, sellerId), so a second seller lands on
    // the same sku for the same user.
    const second = await economy.submit(
      buildSubscribe({
        userId: 'usr_bob',
        sellerId: 'usr_seller_b',
        sku: 'club_pass',
        price: credit('100.00'),
        periodMs: PERIOD_MS,
      }),
    );
    assert.equal(second.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_bob', 'club_pass'), true);

    // Lapse exactly one of them: claim a single due row, unaffordable at a zero balance.
    const swept = await sweepDueSubscriptions(store, makeWorkerCtx(), {
      now: PERIOD_MS,
      limit: 1,
    });
    assert.equal(swept.lapsed.length, 1);
    const lapsedId = swept.lapsed[0]!;

    // The surviving subscription is still being billed, so its perk must survive.
    assert.equal(await store.entitlements.owns('usr_bob', 'club_pass'), true);
    const survivors = await sourcesOf(store, 'usr_bob');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0]!.includes(lapsedId), false);
  });

  test('an operator revoke names no source and drops every grant on the sku', async () => {
    const { economy, store } = economyWithStore();
    await economy.submit(
      buildTopUp({ userId: 'usr_bob', amount: credit('100.00') }),
    );
    await buy(economy, 'ord_one', '5.00');
    await buy(economy, 'ord_two', '6.00');

    const revoked = await economy.submit(
      buildRevokeEntitlement({ userId: 'usr_bob', sku: 'gold_trim' }),
    );
    assert.equal(revoked.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_bob', 'gold_trim'), false);
    assert.deepEqual(await sourcesOf(store, 'usr_bob'), []);
  });
});
