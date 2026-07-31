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
import { systemActor } from '@pwngh/economy-auth';
import type { RouteHandler } from '../src/index.js';

// The persona draft grammar: no buyerId — the framework infers the caller's own subject.
const checkout: RouteHandler = async ({ request }) => {
  const body = (await request.json()) as { sku: string; price: number };
  return {
    kind: 'spend',
    orderId: `ord_${body.sku}`,
    sku: body.sku,
    price: credits(body.price),
    recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
  };
};

test('routes: refusals — key form, framework collisions, non-function handlers', () => {
  const ok = resolveEconomyModule({
    authenticate: false,
    routes: { 'POST /checkout': checkout },
  });
  assert.deepEqual(ok.exports, ['authenticate', 'routes']);
  assert.throws(
    () => resolveEconomyModule({ routes: [] }),
    /SEAM_SHAPE.*routes/s,
  );
  assert.throws(
    () => resolveEconomyModule({ routes: { 'FETCH /x': checkout } }),
    /SEAM_SHAPE.*METHOD \/path/s,
  );
  assert.throws(
    () => resolveEconomyModule({ routes: { 'get /x': checkout } }),
    /SEAM_SHAPE.*METHOD \/path/s,
  );
  assert.throws(
    () => resolveEconomyModule({ routes: { 'GET wallet': checkout } }),
    /SEAM_SHAPE.*METHOD \/path/s,
  );
  assert.throws(
    () => resolveEconomyModule({ routes: { 'POST /x': 7 } }),
    /SEAM_SHAPE.*handler function/s,
  );
  for (const path of [
    '/submit',
    '/v1/wallet',
    '/healthz',
    '/readyz',
    '/webhooks/steam',
    '/instances/s1/purchase',
  ]) {
    assert.throws(
      () => resolveEconomyModule({ routes: { [`POST ${path}`]: checkout } }),
      /ROLE_CONFLICT.*collides/s,
      path,
    );
  }
});

test('routes: authenticate gates, a returned Response passes untouched, an Operation answers in the /v1/submit envelope', async () => {
  const t = await openTestEconomy({
    routes: {
      'GET /whoami': (({ principal }) =>
        new Response(JSON.stringify(principal), {
          status: 418,
        })) satisfies RouteHandler,
      'POST /checkout': checkout,
    },
  });
  const ada = t.user('ada');
  await t.fund(ada, credits(400));

  const anon = await t.app.handler(new Request('http://t/whoami'));
  assert.equal(
    anon.status,
    401,
    'null principal is a 401 before the handler runs',
  );

  const direct = await ada.request('/whoami');
  assert.equal(
    direct.status,
    418,
    'a returned Response passes through untouched',
  );
  assert.deepEqual(await direct.json(), { kind: 'user', userId: 'usr_ada' });

  const buy = (key?: string) =>
    ada.request('/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify({ sku: 'kit', price: 120 }),
    });
  const keyless = await buy();
  assert.equal(
    keyless.status,
    400,
    'the key originates with the caller, always',
  );

  const first = await buy('ord-1');
  assert.equal(first.status, 200);
  const envelope = (await first.json()) as {
    status: string;
    transaction: { id: string; legs: unknown[] };
  };
  assert.equal(envelope.status, 'committed');
  assert.ok(
    envelope.transaction.id.startsWith('txn_'),
    'the exact /v1/submit envelope',
  );

  const replay = await buy('ord-1');
  const dup = (await replay.json()) as {
    status: string;
    transaction: { id: string };
  };
  assert.equal(
    dup.transaction.id,
    envelope.transaction.id,
    'duplicate-as-success, same transaction',
  );

  const broke = await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ord-2' },
    body: JSON.stringify({ sku: 'yacht', price: 9_000 }),
  });
  const rejected = (await broke.json()) as {
    status: string;
    reason: string;
    detail: { reason: string };
  };
  assert.equal(broke.status, 200);
  assert.equal(rejected.status, 'rejected');
  assert.equal(
    rejected.reason,
    rejected.detail.reason,
    'same rejection union as the door',
  );

  const viaRequestId = await ada.request('/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-42' },
    body: JSON.stringify({ sku: 'hat', price: 10 }),
  });
  assert.equal(viaRequestId.status, 200, 'x-request-id is the fallback key');
  assert.equal(
    viaRequestId.headers.get('x-request-id'),
    'req-42',
    'the id echoes like the door',
  );

  assert.ok(
    t.app
      .capabilities()
      .routes.some((r) => r.method === 'POST' && r.path === '/checkout'),
    'capabilities lists the module route',
  );
  assert.equal(
    (await ada.request('/healthz')).status,
    200,
    'non-route paths still reach the lab',
  );
  await t.close();
});

test('routes: the draft grammar is the persona grammar — own subject inferred from the caller', async () => {
  const t = await openTestEconomy({
    routes: {
      'POST /buy': (() => ({
        kind: 'spend',
        orderId: 'ord_t5',
        sku: 'kit',
        price: credits(50),
        recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
      })) satisfies RouteHandler,
    },
  });
  const cal = t.user('cal');
  await t.fund(cal, credits(100));
  const res = await cal.request('/buy', {
    method: 'POST',
    headers: { 'idempotency-key': 't5-1' },
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { status: string }).status, 'committed');
  assert.deepEqual(
    (await cal.wallet()).spendable,
    credits(50),
    'the handler named no buyer; the authenticated caller was inferred',
  );
  await t.close();
});

test("routes: the door's actor law holds on both postures", async () => {
  const stamped = await openTestEconomy({
    routes: {
      'POST /rogue': (() => ({
        kind: 'topUp',
        userId: 'usr_x',
        amount: credits(10),
        source: 'test',
        actor: systemActor('rogue'),
      })) satisfies RouteHandler,
    },
  });
  const res = await stamped.user('ada').request('/rogue', {
    method: 'POST',
    headers: { 'idempotency-key': 'k1' },
  });
  assert.equal(
    res.status,
    400,
    'an authenticated route may not set its own actor',
  );
  await stamped.close();

  const trusted = await openTestEconomy({
    authenticate: false,
    routes: {
      'POST /grant': (() => ({
        kind: 'topUp',
        userId: 'usr_x',
        amount: credits(10),
        source: 'test',
        actor: systemActor('granter'),
      })) satisfies RouteHandler,
      'POST /actorless': (() => ({
        kind: 'topUp',
        userId: 'usr_x',
        amount: credits(10),
        source: 'test',
      })) satisfies RouteHandler,
    },
  });
  const grant = await trusted.app.handler(
    new Request('http://t/grant', {
      method: 'POST',
      headers: { 'idempotency-key': 'k2' },
    }),
  );
  assert.equal(
    grant.status,
    200,
    'authenticate: false trusts the handler actor',
  );
  assert.equal(
    ((await grant.json()) as { status: string }).status,
    'committed',
  );
  const bare = await trusted.app.handler(
    new Request('http://t/actorless', {
      method: 'POST',
      headers: { 'idempotency-key': 'k3' },
    }),
  );
  assert.equal(bare.status, 400, 'no principal and no handler actor refuses');
  await trusted.close();
});

// The routes desugar print is asserted in economy-cli's render suite.
