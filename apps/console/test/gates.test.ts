/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Every engine gate, provoked through a plain form submit against a freshly reset tab engine, its
 * reason code and detail figures asserted from the flash the action leaves — the acceptance
 * criteria as executable tests, not prose.
 */

import { expect, it } from 'vitest';

import type { ConsoleEngine } from '../app/economy';
import { getEngine } from '../app/engine';
import type { Flash } from '../app/flash';
import { takeFlash } from '../app/flash';
import { clientAction as market } from '../app/routes/actions.market';
import { clientAction as record } from '../app/routes/actions.record';
import { clientAction as simulate } from '../app/routes/actions.simulate';

async function fresh(): Promise<{ eco: ConsoleEngine }> {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();
  return { eco };
}

type Handler = (a: never) => unknown;

async function submit(
  handler: Handler,
  body: Record<string, string>,
): Promise<Flash | null> {
  const request = new Request('http://console.test/actions', {
    method: 'POST',
    body: new URLSearchParams(body),
  });
  await handler({ request, params: {} } as never);
  return takeFlash();
}

function figureLabels(flash: Flash | null): string[] {
  return flash && flash.kind === 'outcome' && flash.figures
    ? flash.figures.map((f) => f.label)
    : [];
}

const BUY = {
  type: 'purchase',
  seller: 'usr_nova',
  listing: 'Aurora Avatar',
  form: 'market-purchase',
  back: '/market',
};
const PAY = { type: 'payout', form: 'market-payout', back: '/market' };

it('INSUFFICIENT_FUNDS carries required and available', async () => {
  await fresh();
  const flash = await submit(record, {
    ...BUY,
    user: 'usr_broke',
    credits: '500',
  });
  expect(flash).toMatchObject({
    kind: 'outcome',
    code: 'INSUFFICIENT_FUNDS',
    form: 'market-purchase',
  });
  expect(figureLabels(flash)).toEqual(['Required', 'Available']);
});

it('RISK_DENIED fires once the velocity limit is armed', async () => {
  await fresh();
  await submit(simulate, { op: 'setVelocity', credits: '100', back: '/' });
  const flash = await submit(record, {
    ...BUY,
    user: 'usr_alice',
    credits: '500',
  });
  expect(flash).toMatchObject({ kind: 'outcome', code: 'RISK_DENIED' });
});

it('DUPLICATE_ORDER rejects a reused order id', async () => {
  await fresh();
  const first = await submit(record, {
    ...BUY,
    user: 'usr_alice',
    credits: '100',
    orderId: 'ord_demo',
  });
  expect(first?.kind).toBe('notice');
  const again = await submit(record, {
    ...BUY,
    user: 'usr_alice',
    credits: '100',
    orderId: 'ord_demo',
  });
  expect(again).toMatchObject({ kind: 'outcome', code: 'DUPLICATE_ORDER' });
});

it('ECONOMY_PAUSED refuses a user write during a maintenance window', async () => {
  await fresh();
  await submit(simulate, { op: 'maintenanceOn', back: '/' });
  // No actor override — the natural buyer is a user, so the default market buy is paused. This is
  // the fix that makes the default experience hit the gate rather than silently bypass it.
  const flash = await submit(record, {
    ...BUY,
    user: 'usr_alice',
    credits: '100',
  });
  expect(flash).toMatchObject({ kind: 'outcome', code: 'ECONOMY_PAUSED' });
});

it('BELOW_MINIMUM carries the minimum and the requested amount', async () => {
  await fresh();
  await submit(simulate, {
    op: 'setPayoutMin',
    credits: '5000',
    back: '/',
  });
  const flash = await submit(record, {
    ...PAY,
    user: 'usr_nova',
    credits: '100',
  });
  expect(flash).toMatchObject({ kind: 'outcome', code: 'BELOW_MINIMUM' });
  expect(figureLabels(flash)).toEqual(['Minimum', 'Requested']);
});

it('PAYOUT_TOO_SOON fires inside the cash-out interval', async () => {
  await fresh();
  await submit(simulate, {
    op: 'setPayoutInterval',
    days: '7',
    back: '/',
  });
  const flash = await submit(record, {
    ...PAY,
    user: 'usr_nova',
    credits: '50',
  });
  expect(flash).toMatchObject({ kind: 'outcome', code: 'PAYOUT_TOO_SOON' });
});

it('FUNDS_IMMATURE fires while earned credits are still maturing', async () => {
  await fresh();
  await submit(simulate, { op: 'setMaturity', days: '30', back: '/' });
  const flash = await submit(record, {
    ...PAY,
    user: 'usr_nova',
    credits: '50',
  });
  expect(flash).toMatchObject({ kind: 'outcome', code: 'FUNDS_IMMATURE' });
});

it('the authorization gate refuses a user acting on another wallet', async () => {
  await fresh();
  const flash = await submit(record, {
    ...BUY,
    user: 'usr_bjorn',
    credits: '100',
    actor: 'usr_alice',
  });
  expect(flash).toMatchObject({
    kind: 'outcome',
    code: 'AUTH.UNAUTHORIZED',
    form: 'market-purchase',
  });
});

it('the gift flow lands the entitlement on the recipient, not the buyer', async () => {
  const { eco } = await fresh();
  const sku = 'Gift Test Pass';
  const flash = await submit(record, {
    ...BUY,
    listing: sku,
    user: 'usr_alice',
    credits: '200',
    giftTo: 'usr_bjorn',
  });
  expect(flash?.kind).toBe('notice');
  expect(await eco.entitled('usr_bjorn', sku)).toBe(true);
  expect(await eco.entitled('usr_alice', sku)).toBe(false);
});

it('malformed input redirects with per-field errors, no submit', async () => {
  await fresh();
  const flash = await submit(record, {
    ...BUY,
    user: '',
    seller: '',
    credits: '0',
  });
  expect(flash?.kind).toBe('invalid');
  if (flash?.kind === 'invalid') {
    expect(Object.keys(flash.fields).sort()).toEqual([
      'credits',
      'seller',
      'user',
    ]);
    expect(flash.form).toBe('market-purchase');
  }
});

it('try-to-break-it: one order id, many buyers, the balance moves once', async () => {
  await fresh();
  const flash = await submit(market, {
    op: 'race',
    buyer: 'usr_alice',
    seller: 'usr_nova',
    listing: 'Race listing',
    credits: '200',
    count: '6',
    back: '/market',
  });
  expect(flash?.kind).toBe('race');
  if (flash?.kind === 'race') {
    expect(flash.attempts).toBe(6);
    expect(flash.committed).toBe(1);
    expect(flash.duplicates).toBe(5);
    expect(flash.other).toBe(0);
    expect(flash.movedCredits).toBe(200);
  }
});

it('try-to-break-it: parallel spends cannot drain past the balance', async () => {
  const { eco } = await fresh();
  await eco.deposit({ userId: 'usr_thin', credits: 500 });
  const flash = await submit(market, {
    op: 'drain',
    buyer: 'usr_thin',
    seller: 'usr_nova',
    listing: 'Drain listing',
    credits: '200',
    count: '6',
    back: '/market',
  });
  expect(flash?.kind).toBe('race');
  if (flash?.kind === 'race') {
    expect(flash.attempts).toBe(6);
    expect(flash.committed).toBe(2);
    expect(flash.insufficient).toBe(4);
    expect(flash.other).toBe(0);
    // Every attempt is accounted for — the tally never silently drops an outcome.
    expect(
      flash.committed + flash.duplicates + flash.insufficient + flash.other,
    ).toBe(flash.attempts);
    expect(flash.movedCredits).toBe(400);
  }
});
