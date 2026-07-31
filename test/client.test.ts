/// <reference types="node" />
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

/**
 * The demo flow through the typed client — top up, a split sale, a payout request, then
 * every read — with fetch injected straight into the reference handler. The client is the
 * contract's consumer: nothing here reaches past the wire.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient, EconomyHttpError } from '#src/client.ts';
import { createServer } from '#src/server.ts';
import { makeEconomy } from '#test/support/economy.ts';
import {
  fixedClock,
  fixedRates,
  silentMeter,
  testConfig,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';
import type { Principal } from '#src/contract.ts';

const tokens: Record<string, Principal> = {
  payments: { kind: 'system', service: 'payments' },
  ada: { kind: 'user', userId: 'usr_ada' },
  ben: { kind: 'user', userId: 'usr_ben' },
};

function harness(token?: string) {
  const handler = createServer({
    economy: makeEconomy(11),
    ports: {
      config: testConfig(),
      secrets: testSecrets(),
      clock: fixedClock(90_000_000),
      meter: silentMeter(),
      logger: testLogger(),
      rates: fixedRates(),
    },
    authenticate: async (request) =>
      tokens[
        request.headers.get('authorization')?.replace('Bearer ', '') ?? ''
      ] ?? null,
  });
  const asFetch: typeof fetch = (input, init) =>
    handler(new Request(input as string, init));
  return Object.assign(
    (who?: string) =>
      createClient({
        baseUrl: 'http://client.test',
        token: who ?? token,
        fetch: asFetch,
      }),
    { asFetch },
  );
}

describe('The Typed Client Walks The Demo Over The Wire', () => {
  test('top up, split sale, payout request, then every read', async () => {
    const client = harness();
    const payments = client('payments');
    const ada = client('ada');
    const ben = client('ben');

    assert.ok(await payments.healthy());

    const top = await payments.submit({
      kind: 'topUp',
      idempotencyKey: 'cl_1',
      userId: 'usr_ada',
      amount: 'CREDIT:500.00',
      source: 'card',
    });
    assert.equal(top.status, 'committed');

    const sale = await ada.submit({
      kind: 'spend',
      idempotencyKey: 'cl_2',
      orderId: 'ord_cl',
      buyerId: 'usr_ada',
      sku: 'print',
      price: 'CREDIT:100.00',
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    });
    assert.equal(sale.status, 'committed');
    const txnId = (sale as unknown as { transaction: { id: string } })
      .transaction.id;

    const no = await ada.submit({
      kind: 'spend',
      idempotencyKey: 'cl_3',
      orderId: 'ord_cl2',
      buyerId: 'usr_ada',
      sku: 'yacht',
      price: 'CREDIT:900.00',
      recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
    });
    assert.equal(no.status, 'rejected');
    assert.equal((no as { reason: string }).reason, 'INSUFFICIENT_FUNDS');

    const wallet = await ada.wallet();
    assert.equal(wallet.spendable, 'CREDIT:400.00');
    assert.ok('payableNow' in wallet);

    const payout = await ben.submit({
      kind: 'requestPayout',
      idempotencyKey: 'cl_4',
      userId: 'usr_ben',
      amount: 'CREDIT:50.00',
    });
    void payout; // BELOW_MINIMUM under real policy is fine — the read below is the point
    const board = await ben.payouts();
    assert.equal(board.cursor, null);

    assert.ok(
      (await ada.posting(txnId)) !== null,
      'a participant reads the posting',
    );
    assert.equal(
      await ben.posting('txn_nope'),
      null,
      'an unknown txn reads as null',
    );
    assert.ok(Array.isArray((await ada.catalog()).bundles));
    assert.ok((await ada.rates()).payout);
    assert.equal((await ada.entitlements()).cursor, null);
    assert.equal((await ada.subscriptions()).cursor, null);

    await assert.rejects(
      client('nobody').wallet(),
      (e: EconomyHttpError) => e.status === 401,
      'a bad token is a transport error, not a rejection',
    );
  });

  test('a GET 404 throws everywhere but posting(); healthy() folds HTTP errors to false', async () => {
    const client = harness();
    const misrouted = createClient({
      baseUrl: 'http://client.test/misrouted',
      token: 'ada',
      fetch: client.asFetch,
    });
    await assert.rejects(
      misrouted.wallet(),
      (e: EconomyHttpError) => e.status === 404,
      'a wrong baseUrl surfaces as the transport error it is, never a silent null',
    );
    assert.equal(await misrouted.healthy(), false);
    assert.equal(await client('ben').posting('txn_nope'), null);
  });
});

describe('The Default Transport', () => {
  test('the built-in fetch stays attached to the global, as a browser demands', async () => {
    // A browser's fetch is a method of the window, and any other receiver is an "Illegal
    // invocation". This stand-in holds the client to the rule Node's own fetch does not.
    const seen: string[] = [];
    function branded(this: unknown, input: string): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      seen.push(input);
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    const original = globalThis.fetch;
    globalThis.fetch = branded as unknown as typeof fetch;
    try {
      const client = createClient({ baseUrl: 'http://client.test' });
      assert.equal(await client.healthy(), true);
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(seen, ['http://client.test/healthz']);
  });

  test('a 2xx that is not JSON is a transport error, and healthy() reports unhealthy', async () => {
    // A proxy or captive portal answers 200 with an HTML page. The parse must not escape as a
    // raw SyntaxError, and the body has to stay readable for whoever debugs it.
    const html = '<html><body>Gateway sign-in required</body></html>';
    const portal: typeof fetch = async () =>
      new Response(html, { headers: { 'content-type': 'text/html' } });
    const client = createClient({
      baseUrl: 'http://client.test',
      fetch: portal,
    });

    await assert.rejects(
      client.wallet('usr_ada'),
      (error: unknown) =>
        error instanceof EconomyHttpError &&
        error.status === 200 &&
        error.body.includes('Gateway sign-in required'),
      'the same error type every other transport failure raises, body intact',
    );
    assert.equal(
      await client.healthy(),
      false,
      'a health check against a portal is unhealthy, not a thrown parse error',
    );
  });
});

describe('The List Reads Carry A Cursor', () => {
  test('the cursor rides the query string on all three lists', async () => {
    const seen: string[] = [];
    const recorder: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ items: [], cursor: null }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createClient({
      baseUrl: 'http://client.test',
      fetch: recorder,
    });

    await client.entitlements(undefined, 25, 'cur_ent');
    await client.subscriptions(undefined, {
      state: 'ACTIVE',
      limit: 25,
      cursor: 'cur_sub',
    });
    await client.payouts(undefined, { limit: 25, cursor: 'cur_pay' });

    assert.deepEqual(seen, [
      'http://client.test/v1/entitlements?limit=25&cursor=cur_ent',
      'http://client.test/v1/subscriptions?state=ACTIVE&limit=25&cursor=cur_sub',
      'http://client.test/v1/payouts?limit=25&cursor=cur_pay',
    ]);
  });

  test('an omitted cursor sends no cursor at all', async () => {
    const seen: string[] = [];
    const recorder: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ items: [], cursor: null }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createClient({
      baseUrl: 'http://client.test',
      fetch: recorder,
    });

    await client.entitlements();
    await client.payouts(undefined, { limit: 10 });

    assert.deepEqual(seen, [
      'http://client.test/v1/entitlements',
      'http://client.test/v1/payouts?limit=10',
    ]);
  });
});

describe('The Bearer Is A String Or The Client Refuses To Build', () => {
  // Records the authorization header of every call, and answers an empty wallet.
  function recorder(): { seen: string[]; fetch: typeof fetch } {
    const seen: string[] = [];
    return {
      seen,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
  }

  test('a token-returning function is refused, never interpolated', () => {
    const { seen, fetch: stub } = recorder();

    assert.throws(
      () =>
        createClient({
          baseUrl: 'http://client.test',
          token: (() => 'tok') as unknown as string,
          fetch: stub,
        }),
      /TokenSource/,
    );
    assert.deepEqual(seen, []);
  });

  test('any other non-string token is refused at the same gate', () => {
    for (const token of [42, {}, ['tok'], true]) {
      assert.throws(
        () =>
          createClient({
            baseUrl: 'http://client.test',
            token: token as unknown as string,
            fetch: recorder().fetch,
          }),
        /TypeError/,
      );
    }
  });

  test('a string bearer still goes out on every call', async () => {
    const { seen, fetch: stub } = recorder();
    const client = createClient({
      baseUrl: 'http://client.test',
      token: 'tok',
      fetch: stub,
    });

    await client.wallet();
    await client.wallet();

    assert.deepEqual(seen, ['Bearer tok', 'Bearer tok']);
  });

  test('an empty bearer sends no authorization header at all', async () => {
    const { seen, fetch: stub } = recorder();
    const client = createClient({
      baseUrl: 'http://client.test',
      token: '',
      fetch: stub,
    });

    await client.wallet();

    assert.deepEqual(seen, ['']);
  });

  /**
   * Every base a caller can write, and the origin a browser resolves the read to.
   *
   * The last two rows are the behaviour that moved: stripping exactly one trailing slash left
   * `'//'` producing `//v1/wallet`, which is protocol-relative — the bearer goes to a host named
   * `v1`. `joinUrl` takes every trailing slash, so no base can turn a route path into a URL
   * naming another host. The rest of the table is the answer this client already gave.
   */
  const BASES: readonly { base: string; url: string; origin: string }[] = [
    {
      base: 'https://x.test',
      url: 'https://x.test/v1/wallet',
      origin: 'https://x.test',
    },
    {
      base: 'https://x.test/',
      url: 'https://x.test/v1/wallet',
      origin: 'https://x.test',
    },
    {
      base: 'https://x.test/api',
      url: 'https://x.test/api/v1/wallet',
      origin: 'https://x.test',
    },
    {
      base: 'https://x.test/api/',
      url: 'https://x.test/api/v1/wallet',
      origin: 'https://x.test',
    },
    { base: '', url: '/v1/wallet', origin: 'https://page.test' },
    { base: '/', url: '/v1/wallet', origin: 'https://page.test' },
    { base: '/api', url: '/api/v1/wallet', origin: 'https://page.test' },
    { base: '//', url: '/v1/wallet', origin: 'https://page.test' },
    {
      base: 'https://x.test//',
      url: 'https://x.test/v1/wallet',
      origin: 'https://x.test',
    },
    { base: '/api//', url: '/api/v1/wallet', origin: 'https://page.test' },
  ];

  test('no base a caller can write sends the read to another origin', async () => {
    const page = 'https://page.test/checkout';
    let examined = 0;
    for (const row of BASES) {
      const urls: string[] = [];
      const client = createClient({
        baseUrl: row.base,
        token: 'tok',
        fetch: async (input) => {
          urls.push(String(input));
          return new Response('{}', {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await client.wallet();

      assert.deepEqual(urls, [row.url], `baseUrl '${row.base}' reads here`);
      assert.equal(
        new URL(urls[0]!, page).origin,
        row.origin,
        `and a browser resolving it lands on the origin '${row.base}' named`,
      );
      examined += 1;
    }
    assert.equal(examined, 10, 'ten bases, each read and resolved');
    assert.equal(new Set(BASES.map((row) => row.base)).size, 10);
  });

  // The positive control for the row above: the join this replaced, resolved through the same
  // lens, so the lens is shown able to tell a foreign host from a path on the page's own origin.
  test('the single-slash strip this replaced sent the bearer to another host', () => {
    const leaked = `${'//'.replace(/\/$/, '')}${'/v1/wallet'}`;
    assert.equal(leaked, '//v1/wallet');
    assert.equal(
      new URL(leaked, 'https://page.test/checkout').origin,
      'https://v1',
      'a browser resolves it to a host nobody configured',
    );
  });
});
