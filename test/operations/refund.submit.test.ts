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

import { economyWithStore } from '#test/support/economy.ts';
import {
  refund as buildRefund,
  spend as buildSpend,
  topUp as buildTopUp,
  principal,
  credit,
} from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';
import { hasCode } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';

// These tests drive the full `economy.submit` path, where the permission check (`authorize`) runs;
// the sibling refund.test.ts calls the handler directly and never reaches it. They pin refund as
// system/operator-only — a refund credits the buyer and debits others, so the ownership rule never
// fires for the caller.

const isUnauthorized = hasCode('AUTH.UNAUTHORIZED');

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

    // The refund builder defaults to a trusted system actor.
    const outcome = await economy.submit(buildRefund({ orderId: 'ord_legit' }));

    assert.equal(outcome.status, 'committed');
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
