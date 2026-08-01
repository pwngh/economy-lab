/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 */

import { refund } from '@pwngh/economy/ops';
import { expect, it } from 'vitest';

import { DAY_MS } from '~/demo.ts';
import { buildEngine } from '~/economy.ts';

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

// A promo surplus burn is money leaving a user's promo balance; the row must say why, not
// render as background housekeeping. The rendered strings are pinned as literals, with the
// neighbouring expiry row pinned too so "explains itself" cannot be satisfied by giving every
// promo row the same sentence.
it('a promo surplus burn explains itself in the feed; the expiry row keeps its own words', async () => {
  const eco = await buildEngine();
  await eco.clear();

  // Zed spends his whole grant, so its expiry reverses nothing; the refund then restores the
  // promo credit after the grant has closed — pooled credit no live grant claims.
  expect(
    (await eco.grantPromo({ userId: 'usr_zed', credits: 500 })).status,
  ).toBe('committed');
  expect(
    (
      await eco.purchase({
        buyerId: 'usr_zed',
        sellerId: 'usr_nova',
        listing: 'Comet Trail',
        credits: 500,
        orderId: 'ord_surplus',
      })
    ).status,
  ).toBe('committed');
  // Pixel's grant stays unspent: the ordinary expiry row, kept as the positive control.
  expect(
    (await eco.grantPromo({ userId: 'usr_pixel', credits: 600 })).status,
  ).toBe('committed');

  eco.advanceTime(31 * DAY_MS);
  await eco.runJobs();
  // The console has no refund door; submit the Operation through the engine's live economy.
  const refunded = await eco.economy.submit(
    refund({
      idempotencyKey: 'idem_refund_surplus',
      actor: { kind: 'operator', operatorId: 'ops_console' },
      orderId: 'ord_surplus',
      reason: 'buyer request',
    }),
  );
  expect(refunded.status).toBe('committed');
  await eco.runJobs();

  const rows = (await eco.ledger({ offset: 0, limit: 200 })).rows;

  const surplus = rows.filter((r) => r.kind === 'promoSurplus');
  expect(surplus).toHaveLength(1);
  expect(surplus[0]).toMatchObject({
    label: 'Promo surplus',
    listing: 'Surplus promo reclaimed',
    paymentType: 'Promotion',
    buyer: 'usr_zed',
    seller: 'Platform',
    priceCredits: 500,
    note: "500.00 Cr of promotional credits sat pooled on usr_zed's promo balance with no live grant to claim it (a refund can restore promo credit after its grant has expired), so it was returned to the platform's promotional float.",
  });

  // The control: the expiry row keeps its own text, so the two events stay distinguishable.
  const expiry = rows.filter((r) => r.kind === 'promoExpiry');
  expect(expiry).toHaveLength(1);
  expect(expiry[0]).toMatchObject({
    label: 'Promo expired',
    listing: 'Unspent promo reclaimed',
    priceCredits: 600,
    note: '600.00 Cr of expired promotional credits was reclaimed from usr_pixel.',
  });
});
