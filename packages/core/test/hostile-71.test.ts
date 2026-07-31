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
import type { RouteHandler } from '../src/index.js';
import { OUTCOME_READS } from '../src/module.js';

// A route handler is in-process: amounts arrive typed. A wire string slipped into a draft
// must be refused by name at the boundary, not fault in the store as a 503.
test('routes: a draft carrying a wire-string amount answers a named 400, not STORE.FAILURE', async () => {
  const t = await openTestEconomy({
    routes: {
      'POST /checkout': (async ({ request }) => {
        const { sku } = (await request.json()) as { sku: string };
        return {
          kind: 'spend',
          orderId: `ord_${sku}`,
          sku,
          price: 'CREDIT:120.00' as unknown as ReturnType<typeof credits>,
          recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
        };
      }) satisfies RouteHandler,
    },
  });
  const ada = t.user('ada');
  await t.fund(ada, credits(400));
  try {
    const res = await ada.request('/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'wire-string-1',
      },
      body: JSON.stringify({ sku: 'kit' }),
    });
    const body = (await res.json()) as { code?: string; title?: string };
    assert.equal(
      res.status,
      400,
      `a wire-string draft is refused by name (got ${res.status} ${JSON.stringify(body)})`,
    );
    assert.equal(body.code, 'OP.MALFORMED');
  } finally {
    await t.close();
  }
});

// Subscribe grants the sku's entitlement in the same transaction as the charge
// (src/operations/subscribe.ts), so its mapped set must include the entitlements read.
test('OUTCOME_READS: subscribe includes entitlements — the grant rides the charge', () => {
  assert.deepEqual(
    [...OUTCOME_READS.subscribe],
    ['wallet', 'entitlements', 'subscriptions'],
    'subscribe grants an entitlement; a storefront that only refetches wallet+subscriptions shows stale ownership',
  );
});

// Reverse posts the exact negation of a prior posting's ledger legs and calls no other
// port (src/operations/reverse.ts), so no read but wallet can change.
test('OUTCOME_READS: reverse maps to wallet alone — it flips ledger legs only', () => {
  assert.deepEqual([...OUTCOME_READS.reverse], ['wallet']);
});

// The refusal is scoped: ordinary strings with colons (keys, ids, reasons) are not wire
// amounts and must still pass.
test('routes: colon-bearing non-amount strings in a draft still submit', async () => {
  const t = await openTestEconomy({
    routes: {
      'POST /checkout': (async () => ({
        kind: 'spend',
        orderId: 'ord:colon:1',
        sku: 'kit',
        price: credits(120),
        recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
      })) satisfies RouteHandler,
    },
  });
  const ada = t.user('ada');
  await t.fund(ada, credits(400));
  try {
    const res = await ada.request('/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'colon:key:1',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(
      ((await res.json()) as { status: string }).status,
      'committed',
    );
  } finally {
    await t.close();
  }
});
