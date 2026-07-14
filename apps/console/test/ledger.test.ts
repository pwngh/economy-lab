/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 */

import { expect, it } from 'vitest';

import { buildEngine } from '../app/economy';

it('a sale names the seller, not the buyer on both sides of the arrow', async () => {
  const eco = await buildEngine();
  const page = await eco.ledger({ offset: 0, limit: 200 });
  const sales = page.rows.filter((r) => r.kind === 'spend');

  expect(sales.length).toBeGreaterThan(0);
  for (const sale of sales) {
    expect(sale.seller).not.toBe(sale.buyer);
  }
  // The seed's first purchase is Alice buying from Nova.
  expect(
    sales.some((s) => s.buyer === 'usr_alice' && s.seller === 'usr_nova'),
  ).toBe(true);
});
