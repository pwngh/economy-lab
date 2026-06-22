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
// lives; the sibling refund.test.ts calls the handler directly and so never reaches it.
//
// Regression tests for an authorization bypass of the same shape as the revokeEntitlement and
// clawback ones: refund — undoing a sale, returning the buyer's money and revoking the SKU it
// granted — was missing from the privileged-only list. The ownership rule only blocks DEBITING an
// account the caller owns, and a refund only ever CREDITS the buyer (returning their money) while
// debiting other people's accounts (the seller, REVENUE), so the ownership rule never fires for the
// caller — meaning a `kind:'user'` actor could refund ANY order, reversing a sale they don't own,
// handing the buyer their money back, revoking the buyer's item, and burning the shared
// `reversed:${orderId}` claim so the real refund/clawback path can never run. refund is now
// system/operator-only, which is what these tests pin. Each test builds the economy over a store it
// also holds, so it can confirm the order's state is untouched after a rejected attempt — proof the
// request was stopped before it could reverse anything.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// A store wired with the same seeded digest + fixed clock the economy uses, returned alongside an
// economy built over it so a test can both submit operations and read balances / ownership.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

// Seed a real prior sale the way the live system does: fund the buyer with a top-up (as a trusted
// system actor), then run a purchase through `economy.submit`. The spend records a Sale under
// `orderId` and grants the buyer the SKU, so there is a genuine order — with money moved and an
// entitlement held — for a refund to reverse. Returns the buyer's spendable balance left after the
// purchase, so a test can prove a rejected refund did not credit it back.
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

    // Stopped before it ran: the buyer's balance was not credited back, the SKU was not revoked,
    // and the sale is still on file — so the order is exactly as the purchase left it.
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
    // cannot refund their own purchase — the same rule that protects a foreign order.
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
    // The buyer is made whole — their full 10.00 top-up is back — and the SKU the sale granted is
    // revoked, the proof the reversal actually ran end to end.
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
