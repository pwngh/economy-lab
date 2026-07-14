/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The subscriptions card's lifecycle: the seeded subscription renews under the worker's sweep,
 * lapses once the wallet runs dry, a duplicate active subscription is refused, and cancel stops
 * renewals.
 */

import { expect, it } from 'vitest';

import { getEngine } from '../app/engine';
import { takeFlash } from '../app/flash';

const DAY = 86_400_000;

async function fresh() {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();
  return eco;
}

it('the seeded subscription renews under the sweep, then lapses when the wallet runs dry', async () => {
  const eco = await fresh();
  const [sub] = await eco.subscriptions();
  if (!sub) {
    throw new Error('seed opened no subscription');
  }
  expect(sub.state).toBe('ACTIVE');

  const before = await eco.wallet(sub.userId);
  eco.advanceTime(sub.periodDays * DAY);
  await eco.runJobs();
  const [renewed] = await eco.subscriptions();
  expect(renewed.period).toBeGreaterThan(sub.period);
  const after = await eco.wallet(sub.userId);
  expect(after?.total).toBeCloseTo((before?.total ?? 0) - sub.priceCredits, 2);

  // Drain the subscriber to under one period, then sweep until the retry cap lapses it.
  const wallet = await eco.wallet(sub.userId);
  const spendable = wallet?.purchased ?? 0;
  if (spendable > sub.priceCredits / 2) {
    await eco.purchase({
      buyerId: sub.userId,
      sellerId: sub.sellerId,
      listing: 'Drain for lapse',
      credits: Math.floor(spendable - 10),
    });
  }
  let state = 'ACTIVE';
  for (let i = 0; i < 15 && state === 'ACTIVE'; i++) {
    eco.advanceTime(sub.periodDays * DAY);
    await eco.runJobs();
    state = (await eco.subscriptions())[0]?.state ?? 'ACTIVE';
  }
  expect(state).toBe('LAPSED');
});

it('a second active subscription for the same user, sku, and seller is refused', async () => {
  const eco = await fresh();
  const [sub] = await eco.subscriptions();
  const again = await eco.subscribe({
    userId: sub.userId,
    sellerId: sub.sellerId,
    sku: sub.sku,
    credits: sub.priceCredits,
    periodDays: sub.periodDays,
  });
  expect(again.status).toBe('rejected');
});

it('cancel stops renewals: the state is terminal and time no longer charges', async () => {
  const eco = await fresh();
  const [sub] = await eco.subscriptions();
  const outcome = await eco.cancelSubscription({ subscriptionId: sub.id });
  expect(outcome.status).toBe('committed');
  expect((await eco.subscriptions())[0]?.state).toBe('CANCELED');

  const before = await eco.wallet(sub.userId);
  eco.advanceTime(sub.periodDays * 2 * DAY);
  await eco.runJobs();
  const after = await eco.wallet(sub.userId);
  expect(after?.total).toBeCloseTo(before?.total ?? 0, 2);
});
