/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The event pipeline: webhook idempotency (a duplicate applies once) and the relay delivering
 * pending outbox rows, through the facade and the pipeline action.
 */

import { expect, it } from 'vitest';

import type { ConsoleEngine } from '~/economy.ts';
import { getEngine } from '~/engine.ts';
import type { Flash } from '~/flash.ts';
import { takeFlash } from '~/flash.ts';
import { clientAction as pipeline } from '../app/routes/actions.pipeline';
import { formPost, fresh } from './support';

async function run(body: Record<string, string>): Promise<Flash | null> {
  await formPost(pipeline, body);
  return takeFlash();
}

it('a redelivered webhook applies once — the balance rises only the first time', async () => {
  const { eco } = await fresh();

  const before = await eco.wallet('usr_alice');
  if (before === null) {
    throw new Error('no alice wallet');
  }

  const first = await eco.postWebhook({
    eventId: 'evt_x',
    userId: 'usr_alice',
    credits: 100,
  });
  expect(first).toEqual({ status: 'accepted', applied: true });
  const mid = await eco.wallet('usr_alice');
  expect(mid?.purchased).toBeCloseTo(before.purchased + 100, 2);

  const second = await eco.postWebhook({
    eventId: 'evt_x',
    userId: 'usr_alice',
    credits: 100,
  });
  expect(second).toEqual({ status: 'duplicate', applied: false });
  const after = await eco.wallet('usr_alice');
  expect(after?.purchased).toBeCloseTo(before.purchased + 100, 2);
});

it('the relay delivers pending outbox rows, then nothing on a re-run', async () => {
  const { eco } = await fresh();

  const run1 = await eco.runRelay();
  expect(run1.relayed).toBeGreaterThan(0);
  expect(eco.pipeline().delivered.length).toBeGreaterThan(0);

  const run2 = await eco.runRelay();
  expect(run2.relayed).toBe(0);
});

it('the webhook action reports accepted then duplicate', async () => {
  await fresh();
  const body = {
    op: 'webhook',
    eventId: 'evt_y',
    userId: 'usr_bjorn',
    credits: '50',
    back: '/pipeline',
  };
  const f1 = await run(body);
  expect(f1?.kind).toBe('notice');
  if (f1?.kind === 'notice') {
    expect(f1.message).toContain('accepted');
  }
  const f2 = await run(body);
  if (f2?.kind === 'notice') {
    expect(f2.message).toContain('duplicate');
  }
});

it('a webhook with bad fields is rejected per field, with no posting', async () => {
  await fresh();
  const flash = await run({
    op: 'webhook',
    eventId: '',
    userId: '',
    credits: '0',
    back: '/pipeline',
  });
  expect(flash?.kind).toBe('invalid');
  if (flash?.kind !== 'invalid') {
    throw new Error('expected an invalid flash');
  }
  expect(flash.fields).toHaveProperty('eventId');
  expect(flash.fields).toHaveProperty('credits');
  expect(flash.form).toBe('pipeline-webhook');
});

it('a webhook accepted but not applied is reported as not posted, not a top-up', async () => {
  const { eco } = await fresh();
  const before = await eco.wallet('usr_alice');
  // Past the engine's max operation amount, so the enqueue is accepted but the posting is rejected.
  const flash = await run({
    op: 'webhook',
    eventId: 'evt_big',
    userId: 'usr_alice',
    credits: '20000000000000',
    back: '/pipeline',
  });
  expect(flash?.kind).toBe('notice');
  if (flash?.kind !== 'notice') {
    throw new Error('expected a notice');
  }
  expect(flash.tone).toBe('warn');
  expect(flash.message).toContain('did not post');

  const after = await eco.wallet('usr_alice');
  expect(after?.purchased).toBeCloseTo(before?.purchased ?? 0, 2);
});

it('an unknown pipeline op is a fault, not a silent success', async () => {
  await fresh();
  const flash = await run({ op: 'bogus', back: '/pipeline' });
  expect(flash?.kind).toBe('outcome');
});
