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

// H2: the seven `/v1` read responses, pinned field by field. The tables mirror the typed
// client (@pwngh/economy-lab/client); a served response that drifts fails here, not on a
// reader. Key sets are exact — a new field is a deliberate edit to this pin, never a
// silent addition.

const AMOUNT = (v: unknown) =>
  typeof v === 'string' && /^(CREDIT|USD):-?\d+\.\d{2}$/.test(v);
const STRING = (v: unknown) => typeof v === 'string' && v.length > 0;
const INT = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const NULLABLE_STRING = (v: unknown) => v === null || typeof v === 'string';
const NULLABLE_INT = (v: unknown) => v === null || INT(v);

type Schema = Record<string, (v: unknown) => boolean>;

// One row shape per read; the page envelope ({ items, cursor }) is asserted apart.
const WALLET: Schema = {
  spendable: AMOUNT,
  earned: AMOUNT,
  promo: AMOUNT,
  payableNow: AMOUNT,
};
const SOURCE_LIST = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');
const ENTITLEMENT: Schema = {
  sku: STRING,
  expiresAt: NULLABLE_INT,
  sources: SOURCE_LIST,
};
const SUBSCRIPTION: Schema = {
  id: STRING,
  userId: STRING,
  sellerId: STRING,
  sku: STRING,
  price: AMOUNT,
  txnId: STRING,
  periodMs: INT,
  state: STRING,
  period: INT,
  attempts: INT,
  nextDueAt: INT,
  updatedAt: INT,
};
const PAYOUT: Schema = {
  id: STRING,
  userId: STRING,
  reserve: AMOUNT,
  rateId: STRING,
  txnId: STRING,
  state: STRING,
  providerRef: NULLABLE_STRING,
  reason: NULLABLE_STRING,
  payoutUsd: AMOUNT,
  attempts: INT,
  dueAt: INT,
  updatedAt: INT,
};
const RATE: Schema = { rate: STRING, scale: INT, rateId: STRING };
const POSTING_LEG: Schema = { account: STRING, amount: AMOUNT };

function conforms(row: unknown, schema: Schema, what: string): void {
  assert.ok(typeof row === 'object' && row !== null, `${what} is an object`);
  const r = row as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(r).sort(),
    Object.keys(schema).sort(),
    `${what}: the field set is exact`,
  );
  for (const [field, check] of Object.entries(schema)) {
    assert.ok(
      check(r[field]),
      `${what}.${field} fails its schema (got ${JSON.stringify(r[field])})`,
    );
  }
}

function page(body: unknown, what: string): unknown[] {
  const b = body as { items?: unknown[]; cursor?: unknown };
  assert.deepEqual(
    Object.keys(b as object).sort(),
    ['cursor', 'items'],
    `${what}: page envelope`,
  );
  assert.equal(
    b.cursor,
    null,
    `${what}: a list this short ends inside one page`,
  );
  assert.ok(
    Array.isArray(b.items) && b.items.length > 0,
    `${what}: seeded items present`,
  );
  return b.items!;
}

test('every /v1 read answers exactly its pinned schema', async () => {
  const t = await openTestEconomy({
    policy: { velocityLimitMinor: 10_000_000n },
  });
  const ada = t.user('ada');
  const ben = t.user('ben');
  await t.fund(ada, credits(30_000));
  await t.fund(ben, credits(1_000));
  const sale = await ada.submit({
    kind: 'spend',
    orderId: 'o1',
    sku: 'kit',
    price: credits(25_000),
    recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
  });
  await ben.submit({
    kind: 'subscribe',
    sellerId: 'usr_cal',
    sku: 'club',
    price: credits(100),
    periodMs: 2_592_000_000,
  });
  await t
    .system('cs')
    .submit({ kind: 'grantEntitlement', userId: 'usr_ben', sku: 'beta' });
  await ben.submit({ kind: 'requestPayout', amount: credits(20_000) });
  const json = async (who: typeof ada, path: string) => {
    const res = await who.request(path);
    assert.equal(res.status, 200, `${path} answers 200`);
    return res.json();
  };

  conforms(await json(ben, '/v1/wallet'), WALLET, 'wallet');
  for (const row of page(await json(ben, '/v1/entitlements'), 'entitlements')) {
    conforms(row, ENTITLEMENT, 'entitlements item');
  }
  for (const row of page(
    await json(ben, '/v1/subscriptions'),
    'subscriptions',
  )) {
    conforms(row, SUBSCRIPTION, 'subscriptions item');
  }
  for (const row of page(await json(ben, '/v1/payouts'), 'payouts')) {
    conforms(row, PAYOUT, 'payouts item');
  }

  const rates = (await json(ben, '/v1/rates')) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(rates).sort(),
    ['buy', 'par', 'payout'],
    'rates: the three rates',
  );
  for (const [name, rate] of Object.entries(rates))
    conforms(rate, RATE, `rates.${name}`);

  const catalog = (await json(ben, '/v1/catalog')) as {
    bundles: unknown[];
    skus: unknown[];
  };
  assert.deepEqual(
    Object.keys(catalog).sort(),
    ['bundles', 'skus'],
    'catalog: the two halves',
  );
  assert.ok(
    Array.isArray(catalog.bundles) && catalog.bundles.every(AMOUNT),
    'catalog.bundles are wire amounts',
  );
  assert.ok(Array.isArray(catalog.skus), 'catalog.skus is a list');

  const txnId = (sale.outcome as { transaction: { id: string } }).transaction
    .id;
  const posting = (await json(ada, `/v1/posting/${txnId}`)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    Object.keys(posting).sort(),
    ['legs', 'meta', 'txnId'],
    'posting: exact fields',
  );
  assert.equal(posting.txnId, txnId);
  assert.ok(
    typeof posting.meta === 'object' && posting.meta !== null,
    'posting.meta is an object',
  );
  assert.ok(
    Array.isArray(posting.legs) && posting.legs.length >= 2,
    'posting.legs: double entry',
  );
  for (const leg of posting.legs as unknown[])
    conforms(leg, POSTING_LEG, 'posting leg');

  await t.close();
});
