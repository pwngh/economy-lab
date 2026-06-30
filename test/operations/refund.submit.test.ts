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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import {
  refund as buildRefund,
  spend as buildSpend,
  topUp as buildTopUp,
  principal,
  credit,
} from '#test/support/builders.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable } from '#src/accounts.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// These tests drive the full public `economy.submit` path, where the permission check (`authorize`)
// lives. The sibling refund.test.ts calls the handler directly and never reaches that check.
//
// These are regression tests for an authorization bypass of the same shape as the revokeEntitlement
// and clawback ones. A refund undoes a sale: it returns the buyer's money and revokes the granted
// SKU. refund was missing from the privileged-only list. The ownership rule only blocks debiting an
// account the caller owns, and a refund credits the buyer while debiting other accounts (the seller
// and REVENUE), so the rule never fires for the caller. A kind:'user' actor could therefore refund
// any order. It could reverse a sale it does not own, hand the buyer the money back, revoke the
// buyer's item, and burn the shared `reversed:${orderId}` claim so the real refund or clawback path
// can never run. refund is now system/operator-only, which is what these tests pin. Each test builds
// the economy over a store it also holds, so it can confirm the order is untouched after a rejected
// attempt.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// Builds a store wired with the same seeded digest and fixed clock the economy uses, and returns it
// alongside an economy built over it. Holding the store lets a test both submit operations and read
// balances and ownership directly.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

// Seeds a real prior sale the way the live system does. It funds the buyer with a top-up as a
// trusted system actor, then runs a purchase through `economy.submit`. The spend records a Sale
// under `orderId` and grants the buyer the SKU. This leaves a genuine order, with money moved and
// the entitlement held, for a refund to reverse.
async function seedSale(economy: Economy, orderId: string): Promise<void> {
  const funded = await economy.submit(
    buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
  );
  assert.equal(funded.status, 'committed');

  const sold = await economy.submit(
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId,
    }),
  );
  assert.equal(sold.status, 'committed');
}

describe('Refund authorization through economy.submit', () => {
  test('rejects a user refunding an order with AUTH.UNAUTHORIZED, leaving the order untouched', async () => {
    const { economy, store } = economyWithStore();
    await seedSale(economy, 'ord_attacked');

    // After the purchase the buyer has spent 4.00 of their 10.00 top-up and holds the SKU.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
    assert.equal(await store.entitlements.owns('usr_buyer', 'wrld_pass'), true);

    await assert.rejects(
      economy.submit(
        buildRefund({
          orderId: 'ord_attacked',
          actor: principal('usr_attacker'),
        }),
      ),
      isUnauthorized,
    );

    // The refund was stopped before it ran. The balance was not credited back, the SKU was not
    // revoked, and the sale is still on file.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
    assert.equal(await store.entitlements.owns('usr_buyer', 'wrld_pass'), true);
    assert.notEqual(await store.sales.get('ord_attacked'), null);
  });

  test('rejects even the buyer refunding their own order (refund is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await seedSale(economy, 'ord_self');

    // Refund is system/operator-only regardless of whose order it names, so even the buyer who paid
    // cannot refund their own purchase.
    await assert.rejects(
      economy.submit(
        buildRefund({ orderId: 'ord_self', actor: principal('usr_buyer') }),
      ),
      isUnauthorized,
    );
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
    assert.equal(await store.entitlements.owns('usr_buyer', 'wrld_pass'), true);
  });

  test('still lets a privileged system actor refund a real prior order (the fix does not over-restrict)', async () => {
    const { economy, store } = economyWithStore();
    await seedSale(economy, 'ord_legit');

    // The refund builder defaults to a trusted system actor; the legitimate support path must still
    // go through and reverse the sale in full.
    const outcome = await economy.submit(buildRefund({ orderId: 'ord_legit' }));

    assert.equal(outcome.status, 'committed');
    // The reversal ran. The buyer is made whole, with the full 10.00 top-up back, and the granted
    // SKU is revoked.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
    assert.equal(
      await store.entitlements.owns('usr_buyer', 'wrld_pass'),
      false,
    );
  });
});
