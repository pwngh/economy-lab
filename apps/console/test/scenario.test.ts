/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Each one-click scenario stages real state through the facade and lands on the page where its
 * consequence is visible — asserted here as the end state plus the redirect target.
 */

import { expect, it } from 'vitest';

import { getEngine } from '~/engine.ts';
import { takeFlash } from '~/flash.ts';
import { takeRaceTally } from '~/race.ts';
import { clientAction as scenario } from '../app/routes/actions.scenario';
import { formPost } from './support';

async function stage(op: string): Promise<{ location: string | null }> {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();
  const response = await formPost(scenario, { op });
  return { location: response.headers.get('location') };
}

it('outage: the provider is down and a payout is mid-retry on the board', async () => {
  const { location } = await stage('outage');
  expect(location).toBe('/payouts');
  const eco = await getEngine();
  expect(eco.settings().faultMode).toBe(true);
  const rows = (await eco.payouts({ offset: 0, limit: 50 })).rows;
  expect(rows.some((p) => p.attempts > 0 && p.state !== 'SETTLED')).toBe(true);
});

it('maintenance: user writes decline as ECONOMY_PAUSED on the market', async () => {
  const { location } = await stage('maintenance');
  expect(location).toBe('/market');
  const eco = await getEngine();
  expect((await eco.status()).maintenanceActive).toBe(true);
});

it('race: one order id, eight buyers, the tally lands on the market', async () => {
  const { location } = await stage('race');
  expect(location).toBe('/market#race');
  expect(takeRaceTally()).toMatchObject({
    attempts: 8,
    committed: 1,
    duplicates: 7,
  });
});

it('immature: fresh earnings refuse to cash out under the horizon', async () => {
  const { location } = await stage('immature');
  expect(location).toBe('/market');
  expect(takeFlash()).toMatchObject({
    kind: 'outcome',
    code: 'FUNDS_IMMATURE',
    form: 'market-payout',
  });
});

it('tamper: the full audit catches the edited posting', async () => {
  const { location } = await stage('tamper');
  expect(location).toBe('/integrity');
  const eco = await getEngine();
  expect((await eco.prove()).chainIntact).toBe(false);
  await eco.reset();
});
