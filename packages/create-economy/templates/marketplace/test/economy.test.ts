/**
 * The arc this app promises, on deterministic ports: nothing listens, the clock only moves
 * when the test moves it, and the payout rail settles on command.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestEconomy } from '@pwngh/economy/test';
import { credits } from '@pwngh/economy/money';
import { requireSuccess } from '@pwngh/economy/ops';
import * as definition from '../economy.app.ts';

test('a sale pays the seller their share', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');
  const ben = eco.user('ben');

  await eco.fund(ada, credits(30_000));

  const sale = await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ord-1' },
    body: JSON.stringify({ sku: 'world-kit', orderId: 'ord-1' }),
  });

  assert.equal(sale.status, 200);
  assert.equal(((await sale.json()) as { status: string }).status, 'committed');
  assert.deepEqual((await ada.wallet()).spendable, credits(5_000));
  // The platform fee comes off the top; the seller earns the rest.
  assert.deepEqual((await ben.wallet()).earned, credits(21_175));

  await eco.close();
});

test('a seller cashes out and the rail settles the saga', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');
  const ben = eco.user('ben');

  await eco.fund(ada, credits(30_000));
  await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ord-1' },
    body: JSON.stringify({ sku: 'world-kit', orderId: 'ord-1' }),
  });

  const asked = await ben.submit({
    kind: 'requestPayout',
    amount: credits(20_000),
  });
  assert.ok(asked.saga, 'an accepted payout carries its saga handle');

  await eco.until(async () => (await asked.saga!.state()) === 'SUBMITTED');
  requireSuccess((await eco.rail.settle(asked)).outcome);

  assert.equal(await asked.saga!.state(), 'SETTLED');

  await eco.close();
});

test('a split sale divides the net between two sellers', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');

  await eco.fund(ada, credits(30_000));

  const sale = await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ord-2' },
    body: JSON.stringify({ sku: 'collab-kit', orderId: 'ord-2' }),
  });

  assert.equal(sale.status, 200);

  const ben = await eco.user('ben').wallet();
  const cal = await eco.user('cal').wallet();
  // 70/30 of the net, and neither share is zero.
  assert.equal(ben.earned.minor > cal.earned.minor, true);
  assert.equal(cal.earned.minor > 0n, true);

  await eco.close();
});

test('a client that names its own price is refused by name', async () => {
  const eco = await openTestEconomy(definition);
  const ada = eco.user('ada');

  await eco.fund(ada, credits(30_000));

  const lying = await ada.request('/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'spend',
      idempotencyKey: 'ord-3',
      orderId: 'ord-3',
      sku: 'world-kit',
      buyerId: 'usr_ada',
      price: 'CREDIT:1.00',
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    }),
  });

  const answer = (await lying.json()) as { status: string; reason?: string };
  assert.equal(answer.status, 'rejected');
  assert.equal(answer.reason, 'CATALOG_MISMATCH');

  await eco.close();
});
