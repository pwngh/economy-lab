/**
 * The arc this app promises, on deterministic ports: nothing listens, no clock runs, and
 * the personas carry their own credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestEconomy } from '@pwngh/economy/test';
import { credits } from '@pwngh/economy/money';
import * as definition from '../economy.app.ts';

test('a funded buyer completes a checkout', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');

  await eco.fund(ada, credits(600));

  const sale = await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ord-1' },
    body: JSON.stringify({ sku: 'starter-pack', orderId: 'ord-1' }),
  });

  assert.equal(sale.status, 200);
  assert.equal(((await sale.json()) as { status: string }).status, 'committed');
  assert.deepEqual((await ada.wallet()).spendable, credits(480));

  await eco.close();
});

test('an unknown sku answers the route own 404', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');

  const missing = await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ord-2' },
    body: JSON.stringify({ sku: 'yacht', orderId: 'ord-2' }),
  });

  assert.equal(missing.status, 404);

  await eco.close();
});

test('a client that names its own price is refused by name', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');

  await eco.fund(ada, credits(600));

  const lying = await ada.request('/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'spend',
      idempotencyKey: 'ord-3',
      orderId: 'ord-3',
      sku: 'starter-pack',
      buyerId: 'usr_ada',
      price: 'CREDIT:1.00',
      recipients: [{ sellerId: 'usr_studio', shareBps: 10_000 }],
    }),
  });

  const answer = (await lying.json()) as { status: string; reason?: string };
  assert.equal(answer.status, 'rejected');
  assert.equal(answer.reason, 'CATALOG_MISMATCH');

  await eco.close();
});
