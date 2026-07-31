/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestEconomy } from '@pwngh/economy-test';
import { credits } from '@pwngh/economy-money';
import * as example from '../example/economy.app.ts';

// The shipped example is a working app, not prose: every seam it exports resolves, the
// checkout arc commits through its own route, the catalog gates a lying price, and the
// instance lane answers. Broken example, broken suite.
test('the example module runs its whole storefront arc', async () => {
  const eco = await openTestEconomy(example);
  const ada = eco.user('ada');

  await eco.fund(ada, credits(600));
  const sale = await ada.request('/checkout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'ex-ord-1',
    },
    body: JSON.stringify({ sku: 'starter-pack', orderId: 'ex-ord-1' }),
  });
  assert.equal(sale.status, 200);
  assert.equal(((await sale.json()) as { status: string }).status, 'committed');
  assert.deepEqual((await ada.wallet()).spendable, credits(480));

  const missing = await ada.request('/checkout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'ex-ord-2',
    },
    body: JSON.stringify({ sku: 'yacht', orderId: 'ex-ord-2' }),
  });
  assert.equal(
    missing.status,
    404,
    "an unknown sku answers the route's own 404",
  );

  // The catalog edge guards the wire door: a client that lies about the price is
  // refused by name before the ledger ever sees the spend.
  const lying = await ada.request('/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'spend',
      idempotencyKey: 'ex-ord-3',
      orderId: 'ex-ord-3',
      sku: 'starter-pack',
      buyerId: 'usr_ada',
      price: 'CREDIT:1.00',
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    }),
  });
  const no = (await lying.json()) as { status: string; reason?: string };
  assert.equal(no.status, 'rejected');
  assert.equal(
    no.reason,
    'CATALOG_MISMATCH',
    'a lying price is refused by name',
  );

  await eco.close();
});

test('the example resolves every seam it exports', async () => {
  const { resolveEconomyModule } = await import('../src/module.js');
  const mod = resolveEconomyModule({ ...example });
  assert.deepEqual([...mod.exports].sort(), [
    'after',
    'authenticate',
    'catalog',
    'instances',
    'policy',
    'providers',
    'routes',
    'worker',
  ]);
});
