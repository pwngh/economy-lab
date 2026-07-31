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
import { resolveEconomyModule } from '../src/module.js';
import { openTestEconomy } from '@pwngh/economy-test';
import { credits } from '@pwngh/economy-money';
import { encodeAmount } from '@pwngh/economy-lab';

// The auth idioms moved to @pwngh/economy-auth and are proven in that package's suite.

test('catalog: shape refusals and the bundles/policy single-owner rule', () => {
  assert.throws(
    () => resolveEconomyModule({ catalog: [] }),
    /SEAM_SHAPE.*catalog/s,
  );
  assert.throws(
    () => resolveEconomyModule({ catalog: { skus: {} } }),
    /SEAM_SHAPE.*bundles and lookup/s,
  );
  assert.throws(
    () => resolveEconomyModule({ catalog: { bundles: ['600'] } }),
    /SEAM_SHAPE.*minor-unit/s,
  );
  assert.throws(
    () => resolveEconomyModule({ catalog: { lookup: {} } }),
    /NOT_A_FUNCTION.*catalog/s,
  );
  assert.throws(
    () =>
      resolveEconomyModule({
        catalog: { bundles: [60_000n] },
        policy: { topUpBundlesMinor: [60_000n] },
      }),
    /ROLE_CONFLICT.*one owner/s,
  );
});

test('catalog.lookup compiles to the lab catalog port: CATALOG_MISMATCH from submit', async () => {
  const t = await openTestEconomy({
    catalog: {
      bundles: [60_000n],
      lookup: (sku: string) =>
        sku === 'kit'
          ? {
              price: credits(120),
              recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
            }
          : null,
    },
  });
  const ada = t.user('ada');
  // With bundles compiled in, top-ups must match the purchase catalog — fund the 600 pack.
  await t.fund(ada, credits(600));
  const submit = (body: Record<string, unknown>) =>
    ada.request('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const spendWire = (sku: string, price: string, key: string) => ({
    kind: 'spend',
    idempotencyKey: key,
    orderId: `ord_${key}`,
    buyerId: 'usr_ada',
    sku,
    price,
    recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
  });

  const offPrice = await submit(
    spendWire('kit', encodeAmount(credits(90)), 'k1'),
  );
  const rejected = (await offPrice.json()) as {
    status: string;
    reason: string;
    detail: { field: string };
  };
  assert.equal(offPrice.status, 200);
  assert.equal(
    rejected.reason,
    'CATALOG_MISMATCH',
    'a price off the offer answers the rejection',
  );
  assert.equal(rejected.detail.field, 'price');

  const unlisted = await submit(
    spendWire('yacht', encodeAmount(credits(90)), 'k2'),
  );
  assert.equal(
    ((await unlisted.json()) as { detail: { field: string } }).detail.field,
    'sku',
  );

  const listed = await submit(
    spendWire('kit', encodeAmount(credits(120)), 'k3'),
  );
  assert.equal(
    ((await listed.json()) as { status: string }).status,
    'committed',
    'the exact offer passes the gate',
  );

  const bundles = await ada.request('/v1/catalog');
  assert.equal(bundles.status, 200);
  assert.match(
    JSON.stringify(await bundles.json()),
    /CREDIT:600\.00/,
    'catalog.bundles compiled to topUpBundlesMinor',
  );
  await t.close();
});

// The catalog desugar print is asserted in economy-cli's render suite.
