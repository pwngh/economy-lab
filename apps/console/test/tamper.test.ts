/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The integrity theater: an edited posting flips the chain check with the victim named, a planted
 * balance renders as a drift row with both figures, and heal rebuilds to green.
 */

import { expect, it } from 'vitest';

import { getEngine } from '~/engine.ts';
import { takeFlash } from '~/flash.ts';
import { clientAction as tamper } from '../app/routes/actions.tamper';
import { formPost } from './support';

async function op(name: string) {
  await formPost(tamper, { op: name, back: '/integrity' });
  return takeFlash();
}

it('tampering flips chainIntact with the victim named; heal restores green', async () => {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();
  expect((await eco.prove()).chainIntact).toBe(true);

  const flash = await op('tamper');
  if (flash?.kind !== 'notice') {
    throw new Error('expected a notice flash');
  }
  expect(flash.tone).toBe('warn');
  expect(flash.message).toContain('Edited txn_');
  expect(flash.message).toContain(' on ');

  expect((await eco.prove()).chainIntact).toBe(false);

  await op('heal');
  expect((await eco.prove()).allGreen).toBe(true);
});

it('a planted balance is a drift row carrying both figures', async () => {
  const eco = await getEngine();
  await eco.reset();
  takeFlash();

  await op('drift');
  const p = await eco.prove();
  expect(p.consistent).toBe(false);
  const row = p.drift.find((d) => d.account === 'usr_ghost:spendable');
  expect(row?.cachedCredits).toBe(123);
  expect(row?.derivedCredits).toBe(0);

  await op('heal');
  expect((await eco.prove()).consistent).toBe(true);
});
