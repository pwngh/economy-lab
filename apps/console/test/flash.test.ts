/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The one-shot flash: a mutation leaves its message in the module slot, the redirect's next render
 * takes it exactly once, and an engine rejection rides back as a structured outcome.
 */

import { expect, it } from 'vitest';

import { DAY_MS } from '../app/demo';
import { getEngine } from '../app/engine';
import { takeFlash } from '../app/flash';
import { clientAction as simulate } from '../app/routes/actions.simulate';
import { formPost } from './support';

it('a mutation redirects back and leaves a one-shot flash', async () => {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();

  const before = eco.now();
  const response = await formPost(simulate, {
    op: 'advance',
    days: '1',
    back: '/payouts',
  });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/payouts');
  expect(takeFlash()).toMatchObject({
    kind: 'notice',
    message: 'Advanced time by 1 day.',
  });
  // One-shot: the second take is empty.
  expect(takeFlash()).toBeNull();
  expect(eco.now()).toBe(before + DAY_MS);
});

it('an engine rejection rides back as a structured outcome flash', async () => {
  await (await getEngine()).reset();
  takeFlash();

  const { clientAction: payout } = await import('../app/routes/actions.payout');
  const response = await formPost(payout, {
    user: 'usr_alice',
    credits: '999999',
    back: '/',
  });

  expect(response.status).toBe(302);
  expect(takeFlash()).toMatchObject({
    kind: 'outcome',
    code: 'INSUFFICIENT_FUNDS',
  });
});
