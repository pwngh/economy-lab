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

import { expect, it } from 'vitest';

import { buildEngine } from '../app/economy';
import { getEngine } from '../app/engine';
import { takeFlash } from '../app/flash';
import { clientAction as simulate } from '../app/routes/actions.simulate';

const DAY = 86_400_000;

it('two built engines hold two different economies with different clocks', async () => {
  const a = await buildEngine();
  const b = await buildEngine();
  a.advanceTime(DAY);
  expect(a.now()).toBe(b.now() + DAY);
});

it('getEngine returns the one tab engine', async () => {
  expect(await getEngine()).toBe(await getEngine());
});

it('a mutation redirects back and leaves a one-shot flash', async () => {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();

  const before = eco.now();
  const request = new Request('http://console.test/actions/simulate', {
    method: 'POST',
    body: new URLSearchParams({ op: 'advance', days: '1', back: '/payouts' }),
  });
  const response = (await simulate({
    request,
    params: {},
  } as never)) as Response;

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/payouts');
  expect(takeFlash()).toMatchObject({
    kind: 'notice',
    message: 'Advanced time by 1 day.',
  });
  // One-shot: the second take is empty.
  expect(takeFlash()).toBeNull();
  expect(eco.now()).toBe(before + DAY);
});

it('a hostile back path is redirected to the root instead', async () => {
  await (await getEngine()).reset();
  takeFlash();

  // Both the protocol-relative `//host` and the backslash `/\host` form, which the browser
  // normalizes to `//host` and would follow off-site.
  for (const back of ['//evil.example/phish', '/\\evil.example/phish']) {
    const request = new Request('http://console.test/actions/simulate', {
      method: 'POST',
      body: new URLSearchParams({ op: 'advance', days: '1', back }),
    });
    const response = (await simulate({
      request,
      params: {},
    } as never)) as Response;

    expect(response.headers.get('location')).toBe('/');
    takeFlash();
  }
});

it('an engine rejection rides back as a structured outcome flash', async () => {
  await (await getEngine()).reset();
  takeFlash();

  const { clientAction: record } = await import('../app/routes/actions.record');
  const request = new Request('http://console.test/actions/record', {
    method: 'POST',
    body: new URLSearchParams({
      type: 'payout',
      user: 'usr_alice',
      credits: '999999',
      back: '/',
    }),
  });
  const response = (await record({ request, params: {} } as never)) as Response;

  expect(response.status).toBe(302);
  expect(takeFlash()).toMatchObject({
    kind: 'outcome',
    code: 'INSUFFICIENT_FUNDS',
  });
});

it('concurrent mutations serialize instead of nesting a memory transaction', async () => {
  const eco = await buildEngine();
  // Without the mutex these overlapping submits crash the memory adapter ("do not nest").
  const results = await Promise.allSettled([
    eco.deposit({ userId: 'usr_a', credits: 100 }),
    eco.deposit({ userId: 'usr_b', credits: 100 }),
    eco.runJobs(),
    eco.deposit({ userId: 'usr_c', credits: 100 }),
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
});

it('a failed mutation does not break the queue for the next', async () => {
  const eco = await buildEngine();
  const bad = eco.deposit({ userId: 'usr_a', credits: Number.NaN }).then(
    () => 'ok',
    () => 'threw',
  );
  const good = eco.deposit({ userId: 'usr_b', credits: 250 });
  const [b, g] = await Promise.all([bad, good]);
  expect(b).toBe('threw');
  expect(g.status).toBe('committed');
});
