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
import type { CatalogOffer } from '@pwngh/economy-lab/server';
import type { RouteHandler } from '../src/index.js';

const SELLER = [{ sellerId: 'usr_ben', shareBps: 10_000 }] as const;

// The listing the host sells `kit` at. Any other price a caller names is a mispricing.
const catalog = {
  lookup: (sku: string): CatalogOffer | null =>
    sku === 'kit' ? { price: credits(120), recipients: [...SELLER] } : null,
};

// The handler shape the README teaches and `routes.test.ts` already uses: the price arrives in
// the request body. It is safe only if something downstream checks it.
const checkout: RouteHandler = async ({ request }) => {
  const body = (await request.json()) as { sku: string; price: number };
  return {
    kind: 'spend',
    orderId: `ord_${body.sku}_${body.price}`,
    sku: body.sku,
    price: credits(body.price),
    recipients: [...SELLER],
  };
};

type Harness = Awaited<ReturnType<typeof openTestEconomy>>;

const spendable = async (t: Harness, userId: string) =>
  (await t.economy.read.wallet(userId)).spendable.minor;

// 400 credits is the most the harness inflow limit admits in one window; a seed that starts
// failing must say so here rather than leave every assertion below reading an empty wallet.
const seed = async (t: Harness) => {
  const ada = t.user('ada');
  const funded = await t.fund(ada, credits(400));
  assert.equal(funded.outcome.status, 'committed', 'the seed topUp committed');
  assert.equal(await spendable(t, 'usr_ada'), 40_000n, 'seeded 400 credits');
  return ada;
};

const post = (
  ada: ReturnType<Harness['user']>,
  path: string,
  key: string,
  body: unknown,
) =>
  ada.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });

type Rejection = {
  status: string;
  detail?: { reason: string; field: string };
};

test('a catalog gates every door, not only /submit', async () => {
  const t = await openTestEconomy({
    catalog,
    routes: { 'POST /checkout': checkout },
  });
  const ada = await seed(t);

  // Control: the raw door refuses. Without it, a green run below would not tell "the module
  // route was checked" from "the catalog was never consulted at all".
  // The raw door carries the key in the operation; a module route takes it from the header.
  const door = await post(ada, '/submit', 'sub-1', {
    kind: 'spend',
    idempotencyKey: 'idem_door',
    orderId: 'ord_door',
    sku: 'kit',
    buyerId: 'usr_ada',
    price: 'CREDIT:1.00',
    recipients: [...SELLER],
  });
  const doorBody = (await door.json()) as Rejection;
  assert.equal(doorBody.status, 'rejected', '/submit refuses the named price');
  assert.equal(doorBody.detail?.reason, 'CATALOG_MISMATCH');
  assert.equal(doorBody.detail?.field, 'price');

  // The module route reaches the same economy with the same operation.
  const route = await post(ada, '/checkout', 'rt-1', { sku: 'kit', price: 1 });
  const routeBody = (await route.json()) as Rejection;
  assert.equal(
    routeBody.status,
    'rejected',
    'a module route cannot name its own price',
  );
  assert.equal(routeBody.detail?.reason, 'CATALOG_MISMATCH');
  assert.equal(routeBody.detail?.field, 'price');

  // In-process is a door too: the persona grammar calls economy.submit with no HTTP at all.
  const inProcess = await ada.submit({
    kind: 'spend',
    orderId: 'ord_persona',
    sku: 'kit',
    price: credits(1),
    recipients: [...SELLER],
  });
  assert.equal(
    inProcess.outcome.status,
    'rejected',
    'an in-process spend cannot name its own price either',
  );

  assert.equal(
    await spendable(t, 'usr_ada'),
    40_000n,
    'no path moved money at the named price',
  );
  await t.close();
});

test('the catalog names the unlisted sku and still sells at the offer price', async () => {
  const t = await openTestEconomy({
    catalog,
    routes: { 'POST /checkout': checkout },
  });
  const ada = await seed(t);

  const unlisted = await post(ada, '/checkout', 'rt-2', {
    sku: 'yacht',
    price: 120,
  });
  const unlistedBody = (await unlisted.json()) as Rejection;
  assert.equal(unlistedBody.status, 'rejected');
  assert.equal(unlistedBody.detail?.reason, 'CATALOG_MISMATCH');
  assert.equal(unlistedBody.detail?.field, 'sku', 'the unlisted sku is named');

  // The gate is a price check, not a route ban: the listed price still commits.
  const honest = await post(ada, '/checkout', 'rt-3', {
    sku: 'kit',
    price: 120,
  });
  assert.equal(
    ((await honest.json()) as Rejection).status,
    'committed',
    'the offer price still buys',
  );
  assert.equal(
    await spendable(t, 'usr_ada'),
    40_000n - 12_000n,
    'exactly the offer price left the wallet',
  );
  await t.close();
});

test('with no catalog exported, a route prices itself and nothing checks it', async () => {
  const t = await openTestEconomy({ routes: { 'POST /checkout': checkout } });
  const ada = await seed(t);

  const res = await post(ada, '/checkout', 'rt-4', { sku: 'kit', price: 1 });
  assert.equal(((await res.json()) as Rejection).status, 'committed');
  assert.equal(
    await spendable(t, 'usr_ada'),
    40_000n - 100n,
    'pricing stays the host own concern when no catalog is declared',
  );
  await t.close();
});
