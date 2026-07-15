/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The tab engine: one seeded economy per tab (the getEngine singleton over buildEngine), and the
 * mutation mutex that serializes overlapping submits so the memory store never nests a transaction.
 */

import { expect, it } from 'vitest';

import { DAY_MS } from '~/demo.ts';
import { buildEngine } from '~/economy.ts';
import { getEngine } from '~/engine.ts';

it('two built engines hold two different economies with different clocks', async () => {
  const a = await buildEngine();
  const b = await buildEngine();
  a.advanceTime(DAY_MS);
  expect(a.now()).toBe(b.now() + DAY_MS);
});

it('getEngine returns the one tab engine', async () => {
  expect(await getEngine()).toBe(await getEngine());
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
