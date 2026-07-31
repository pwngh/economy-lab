/**
 * @pwngh/economy-client
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

import { createEconomy, memoryPorts } from '@pwngh/economy-lab';
import { serveNode } from '@pwngh/economy-lab/adapters';
import { createServer } from '@pwngh/economy-lab/server';
import type { Principal } from '@pwngh/economy-lab';
import type { NodeServer } from '@pwngh/economy-lab/adapters';
import type { ServerOptions } from '@pwngh/economy-lab/server';

import {
  createClient,
  createTransport,
  EconomyHttpError,
} from '../src/index.js';
import type { EconomyClient } from '../src/index.js';

// The bearers this economy answers to. Every request below carries one of these over a real
// socket, so a header the client fails to send is a 401 rather than a recorded absence.
const ADA = 'live_user_usr_ada';
const PAYMENTS = 'live_system_payments';

const principalOf = async (request: Request): Promise<Principal | null> => {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (bearer === ADA) return { kind: 'user', userId: 'usr_ada' };
  if (bearer === PAYMENTS) return { kind: 'system', service: 'payments' };
  return null;
};

/**
 * A real economy behind the lab's real router, listening on a real loopback port.
 *
 * Every `close()` below takes the lab's default drain of `0`, which cuts an in-flight connection
 * rather than giving it time. Nothing here is in flight — each request is awaited before its
 * server closes — so the cut is the shortest correct teardown, and it is also what keeps a request
 * a later edit forgets to await from holding the socket open past the test that opened it.
 */
function mount(options: Partial<ServerOptions> = {}): Promise<NodeServer> {
  const ports = memoryPorts({ signingKey: 'sig_live_client' });
  return serveNode(
    createServer({
      economy: createEconomy(ports),
      ports,
      authenticate: principalOf,
      ...options,
    }),
    { host: '127.0.0.1' },
  );
}

const asAda = (baseUrl: string): EconomyClient =>
  createClient({ baseUrl, token: ADA });
const asPayments = (baseUrl: string): EconomyClient =>
  createClient({ baseUrl, token: PAYMENTS });

// Every method on the published surface, driven once against a live economy. The count is the
// assertion: a door dropped from this list would otherwise leave the sweep quietly smaller.
test('every published client method answers over a real socket', async () => {
  const live = await mount();
  try {
    const ada = asAda(live.url);
    const payments = asPayments(live.url);

    const answered: string[] = [];
    const record = async (name: string, call: Promise<unknown>) => {
      const value = await call;
      assert.notEqual(value, undefined, `${name} answered with nothing`);
      answered.push(name);
      return value;
    };

    assert.equal(await record('healthy', ada.healthy()), true);
    const committed = (await record(
      'submit',
      payments.submit({
        kind: 'topUp',
        idempotencyKey: 'live_topup_1',
        userId: 'usr_ada',
        amount: 'CREDIT:400.00',
        source: 'card',
      }),
    )) as { status: string; transaction: { id: string } };
    assert.equal(committed.status, 'committed');

    const wallet = (await record('wallet', ada.wallet())) as Record<
      string,
      string
    >;
    await record('entitlements', ada.entitlements());
    await record('subscriptions', ada.subscriptions());
    await record('payouts', ada.payouts());
    await record('rates', ada.rates());
    await record('catalog', ada.catalog());
    const posting = (await record(
      'posting',
      ada.posting(committed.transaction.id),
    )) as Record<string, unknown>;

    // The money made the round trip: the top-up this test posted is the balance it reads back,
    // and the posting the wire hands back names the transaction that carried it.
    assert.equal(wallet.spendable, 'CREDIT:400.00');
    assert.equal(posting.txnId, committed.transaction.id);

    assert.deepEqual(answered, [
      'healthy',
      'submit',
      'wallet',
      'entitlements',
      'subscriptions',
      'payouts',
      'rates',
      'catalog',
      'posting',
    ]);
  } finally {
    await live.close();
  }
});

// The recorder tests pin the paths this client builds. Only a live server can say whether
// anything answers on them, and a page shape is the server's, not the client's.
test('each read answers its own live route, and a page carries items and a cursor', async () => {
  const live = await mount();
  try {
    const ada = asAda(live.url);

    // Each rate arrives as its own row carrying the id the conversion was quoted under, which
    // is the shape a recorder's canned body is free to get wrong.
    const rates = await ada.rates();
    for (const family of ['buy', 'par', 'payout'] as const) {
      const quote = rates[family] as { rateId?: unknown };
      assert.equal(
        typeof quote?.rateId,
        'string',
        `/v1/rates answered no rateId for ${family}`,
      );
    }

    const catalog = await ada.catalog();
    assert.ok(Array.isArray(catalog.bundles));
    assert.ok(Array.isArray(catalog.skus));

    for (const [name, page] of [
      ['entitlements', await ada.entitlements(undefined, 5)],
      ['subscriptions', await ada.subscriptions(undefined, { limit: 5 })],
      ['payouts', await ada.payouts(undefined, { limit: 5 })],
    ] as const) {
      assert.ok(Array.isArray(page.items), `${name} answered no items array`);
      assert.ok('cursor' in page, `${name} answered no cursor field`);
    }
  } finally {
    await live.close();
  }
});

// Three outcomes the wire carries differently, and no recorder can prove the server agrees
// with the client about any of them.
test('committed, duplicate and rejected all come back as data from the live economy', async () => {
  const live = await mount();
  try {
    const payments = asPayments(live.url);
    const ada = asAda(live.url);

    const first = (await payments.submit({
      kind: 'topUp',
      idempotencyKey: 'live_dup_1',
      userId: 'usr_ada',
      amount: 'CREDIT:100.00',
      source: 'card',
    })) as { status: string; transaction: { id: string } };
    const again = (await payments.submit({
      kind: 'topUp',
      idempotencyKey: 'live_dup_1',
      userId: 'usr_ada',
      amount: 'CREDIT:100.00',
      source: 'card',
    })) as { status: string; transaction: { id: string } };

    assert.equal(first.status, 'committed');
    assert.equal(again.status, 'duplicate');
    assert.equal(
      again.transaction.id,
      first.transaction.id,
      'the replay named a different posting',
    );

    const declined = (await ada.submit({
      kind: 'spend',
      idempotencyKey: 'live_overdraft_1',
      orderId: 'ord_live_1',
      buyerId: 'usr_ada',
      sku: 'yacht',
      price: 'CREDIT:200.00',
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    })) as { status: string; reason: string };
    assert.equal(declined.status, 'rejected');
    assert.equal(declined.reason, 'INSUFFICIENT_FUNDS');

    // A balance still standing after the decline is what makes it a decline and not a debit.
    const wallet = await ada.wallet();
    assert.equal(wallet.spendable, 'CREDIT:100.00');
  } finally {
    await live.close();
  }
});

// The bearer is not decoration: the live server derives the subject from it, so a user token
// reads itself with no userId at all, and the wrong token reads someone else's nothing.
test('the live server scopes every read by the bearer the client sent', async () => {
  const live = await mount();
  try {
    await asPayments(live.url).submit({
      kind: 'topUp',
      idempotencyKey: 'live_scope_1',
      userId: 'usr_ada',
      amount: 'CREDIT:250.00',
      source: 'card',
    });

    const mine = await asAda(live.url).wallet();
    assert.equal(mine.spendable, 'CREDIT:250.00');

    // A user token naming somebody else is refused rather than answered.
    await assert.rejects(
      () => asAda(live.url).wallet('usr_ben'),
      (error: unknown) => {
        assert.ok(error instanceof EconomyHttpError);
        assert.equal(error.status, 401);
        assert.match(error.body, /A user token reads only itself/);
        return true;
      },
    );
  } finally {
    await live.close();
  }
});

// The breaks this file catches, each against the same live economy. A composition test that
// cannot fail is worse than none, so the broken compositions are assertions of their own.
test('a broken composition is refused: no bearer, wrong base URL, reads unmounted', async () => {
  const live = await mount();
  const unmounted = await mount({ reads: false });
  try {
    const anonymous = createClient({ baseUrl: live.url });
    await assert.rejects(
      () => anonymous.wallet('usr_ada'),
      (error: unknown) => {
        assert.ok(error instanceof EconomyHttpError);
        assert.equal(error.status, 401, 'an unauthenticated read was served');
        return true;
      },
    );

    const misaimed = createClient({
      baseUrl: `${live.url}/api`,
      token: ADA,
    });
    await assert.rejects(
      () => misaimed.rates(),
      (error: unknown) => {
        assert.ok(error instanceof EconomyHttpError);
        assert.equal(error.status, 404, 'a wrong base URL still resolved');
        return true;
      },
    );

    const readless = createClient({ baseUrl: unmounted.url, token: ADA });
    await assert.rejects(
      () => readless.wallet(),
      (error: unknown) => {
        assert.ok(error instanceof EconomyHttpError);
        assert.equal(error.status, 404);
        return true;
      },
    );
    assert.equal(
      await readless.healthy(),
      true,
      'the unmounted economy is live; only the read family is gone',
    );

    const dead = createClient({ baseUrl: 'http://127.0.0.1:1', token: ADA });
    await assert.rejects(
      () => dead.rates(),
      (error: unknown) => {
        assert.equal(error instanceof EconomyHttpError, false);
        return true;
      },
    );
  } finally {
    await live.close();
    await unmounted.close();
  }
});

// createTransport is the other published door, for the host routes a client method cannot
// carry. Over a live server it has to reach the same places with the same bearer.
test('createTransport carries a per-request bearer to the same live routes', async () => {
  const live = await mount();
  try {
    let reads = 0;
    const post = createTransport({
      token: () => {
        reads += 1;
        return ADA;
      },
      headers: { 'x-request-id': 'req_live_1' },
    });

    const ok = await post(`${live.url}/v1/rates`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-request-id'), 'req_live_1');

    const wallet = await post(`${live.url}/v1/wallet`);
    assert.equal(wallet.status, 200);

    const refused = await post(`${live.url}/v1/wallet?userId=usr_ben`);
    assert.equal(refused.status, 401);

    assert.equal(reads, 3, 'the token was not read once per request');
  } finally {
    await live.close();
  }
});
