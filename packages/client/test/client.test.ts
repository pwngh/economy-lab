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
import { readFileSync } from 'node:fs';

import {
  createClient,
  EconomyHttpError,
  isCommitted,
  isRejected,
  newIdempotencyKey,
} from '../src/index.js';
import type { WireOutcome } from '../src/index.js';

const BASE = 'https://api.example.com';
const TOKEN = 'tok_9f3c1a7e';

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
};

/** A transport that records every call and answers with one canned body. */
function recorder(
  body: unknown,
  status = 200,
): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === null ? null : await request.text(),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchImpl };
}

test('each read hits its own /v1 path and carries the bearer', async () => {
  const { calls, fetch } = recorder({ items: [], cursor: null });
  const client = createClient({ baseUrl: BASE, token: TOKEN, fetch });

  await client.wallet('usr_ada');
  await client.entitlements('usr_ada', 25);
  await client.subscriptions('usr_ada', { state: 'ACTIVE' });
  await client.payouts('usr_ada', { state: 'SUBMITTED', limit: 5 });
  await client.rates();
  await client.catalog();
  await client.posting('txn_0f8c3a41');

  assert.deepEqual(
    calls.map((c) => c.url.slice(BASE.length)),
    [
      '/v1/wallet?userId=usr_ada',
      '/v1/entitlements?userId=usr_ada&limit=25',
      '/v1/subscriptions?userId=usr_ada&state=ACTIVE',
      '/v1/payouts?userId=usr_ada&state=SUBMITTED&limit=5',
      '/v1/rates',
      '/v1/catalog',
      '/v1/posting/txn_0f8c3a41',
    ],
  );
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.get('authorization'), `Bearer ${TOKEN}`);
  }
});

test('a trailing slash on baseUrl does not double up in the path', async () => {
  const { calls, fetch } = recorder({});
  const client = createClient({ baseUrl: `${BASE}/`, fetch });

  await client.rates();

  assert.equal(calls[0]!.url, `${BASE}/v1/rates`);
  assert.equal(calls[0]!.headers.get('authorization'), null);
});

test('a rejection comes back as data, not a throw', async () => {
  const envelope: WireOutcome = {
    status: 'rejected',
    reason: 'INSUFFICIENT_FUNDS',
    detail: { need: 'CREDIT:600.00', have: 'CREDIT:400.00' },
  };
  const { calls, fetch } = recorder(envelope);
  const client = createClient({ baseUrl: BASE, token: TOKEN, fetch });

  const outcome = await client.submit({
    kind: 'spend',
    idempotencyKey: 'ord_7712',
    buyerId: 'usr_ada',
    sku: 'world-kit',
    price: 'CREDIT:600.00',
  });

  assert.equal(isCommitted(outcome), false);
  assert.ok(isRejected(outcome));
  assert.equal(outcome.reason, 'INSUFFICIENT_FUNDS');
  assert.equal(outcome.detail.have, 'CREDIT:400.00');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.url, `${BASE}/submit`);
  assert.equal(
    JSON.parse(calls[0]!.body!).idempotencyKey,
    'ord_7712',
    'the submit body reaches the wire whole',
  );
});

test('a duplicate reads as committed, because it is the same posting', () => {
  const duplicate: WireOutcome = {
    status: 'duplicate',
    transaction: { id: 'txn_0f8c3a41' },
  };
  assert.ok(isCommitted(duplicate));
  assert.equal(isRejected(duplicate), false);
});

test('a token function is read fresh on every call', async () => {
  const { calls, fetch } = recorder({});
  let issued = 0;
  const client = createClient({
    baseUrl: BASE,
    token: async () => `tok_${++issued}`,
    fetch,
  });

  await client.rates();
  await client.rates();

  assert.equal(calls[0]!.headers.get('authorization'), 'Bearer tok_1');
  assert.equal(calls[1]!.headers.get('authorization'), 'Bearer tok_2');
});

test('extra headers ride every request without displacing the bearer', async () => {
  const { calls, fetch } = recorder({});
  const client = createClient({
    baseUrl: BASE,
    token: TOKEN,
    headers: { 'x-request-id': 'req_4c1d9e' },
    fetch,
  });

  await client.wallet();

  assert.equal(calls[0]!.headers.get('x-request-id'), 'req_4c1d9e');
  assert.equal(calls[0]!.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.headers.get('content-type'), 'application/json');
});

// The header map and the bearer both write `authorization`, and the doc on the option is where a
// caller learns which one wins.
test('an authorization header rides along until a bearer overwrites it', async () => {
  const smuggled = 'Bearer tok_from_the_header_map';
  const send = async (options: { token?: string }) => {
    const { calls, fetch } = recorder({});
    await createClient({
      baseUrl: BASE,
      headers: { authorization: smuggled },
      fetch,
      ...options,
    }).rates();
    return calls[0]!.headers.get('authorization');
  };

  assert.equal(
    await send({}),
    smuggled,
    'no bearer, so the map writes the header',
  );
  assert.equal(
    await send({ token: TOKEN }),
    `Bearer ${TOKEN}`,
    'a bearer overwrites it',
  );
  assert.equal(
    await send({ token: '' }),
    smuggled,
    'an empty bearer writes nothing',
  );

  const src = readFileSync(
    new URL('../src/lib/client.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    src.includes('`authorization` is not one of them'),
    false,
    'the option doc claims a guarantee this factory does not make',
  );
  assert.ok(
    src.includes('A non-empty bearer overwrites'),
    'and says which one wins instead',
  );
});

test('an unknown posting is null and any other failure throws', async () => {
  const missing = recorder({ title: 'Not Found' }, 404);
  const client = createClient({
    baseUrl: BASE,
    token: TOKEN,
    fetch: missing.fetch,
  });
  assert.equal(await client.posting('txn_nope'), null);

  const broken = recorder({ title: 'Internal Server Error' }, 500);
  const failing = createClient({
    baseUrl: BASE,
    token: TOKEN,
    fetch: broken.fetch,
  });
  await assert.rejects(
    () => failing.rates(),
    (error: unknown) => {
      assert.ok(error instanceof EconomyHttpError);
      assert.equal(error.status, 500);
      return true;
    },
  );

  const absent = recorder({ title: 'Not Found' }, 404);
  const unhealthy = createClient({ baseUrl: BASE, fetch: absent.fetch });
  assert.equal(await unhealthy.healthy(), false);
});

test('an idempotency key is unique, and a prefix survives into it', () => {
  const one = newIdempotencyKey('checkout');
  const two = newIdempotencyKey('checkout');

  assert.notEqual(one, two);
  assert.ok(one.startsWith('checkout_'));
  assert.match(newIdempotencyKey(), /^[0-9a-f-]{36}$/);
});

// A browser throws `Illegal invocation` on a `fetch` called with anything but the global as its
// receiver, so this stands in a transport that insists on the same thing.
test('the transport survives a global fetch that is detached after construction', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(
        new Response('{"buy":"1"}', {
          headers: { 'content-type': 'application/json' },
        }),
      );
    } as typeof fetch;
    const client = createClient({ baseUrl: BASE });
    const stamped = createClient({ baseUrl: BASE, token: () => TOKEN });

    (globalThis as { fetch?: typeof fetch }).fetch = undefined;

    assert.deepEqual(await client.rates(), { buy: '1' });
    assert.deepEqual(await stamped.rates(), { buy: '1' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('a runtime with no fetch is told which option supplies one', async () => {
  const saved = globalThis.fetch;
  try {
    (globalThis as { fetch?: typeof fetch }).fetch = undefined;
    assert.throws(() => createClient({ baseUrl: BASE }), /options\.fetch/);

    const { calls, fetch } = recorder({});
    await createClient({ baseUrl: BASE, fetch }).rates();
    assert.equal(
      calls.length,
      1,
      'an explicit transport still works without a global',
    );
  } finally {
    globalThis.fetch = saved;
  }
});

// One factory, two paths through it: the bearer decides which. They must not disagree about
// what an empty one means.
test('an empty bearer sends no authorization header, whichever path built the client', async () => {
  const plain = recorder({});
  await createClient({ baseUrl: BASE, token: '', fetch: plain.fetch }).rates();

  const withHeaders = recorder({});
  await createClient({
    baseUrl: BASE,
    token: '',
    headers: { 'x-request-id': 'req_1' },
    fetch: withHeaders.fetch,
  }).rates();

  const fromFunction = recorder({});
  await createClient({
    baseUrl: BASE,
    token: () => '',
    fetch: fromFunction.fetch,
  }).rates();

  assert.equal(plain.calls[0]!.headers.get('authorization'), null);
  assert.equal(withHeaders.calls[0]!.headers.get('authorization'), null);
  assert.equal(fromFunction.calls[0]!.headers.get('authorization'), null);
  assert.equal(withHeaders.calls[0]!.headers.get('x-request-id'), 'req_1');
});

// Three ways a call can fail, and a caller has to be able to tell them apart without parsing
// strings. A 2xx that will not parse is a transport failure like any other, and it keeps the
// body it could not read.
test('a non-2xx, an unparseable body, and a dead transport are three distinct failures', async () => {
  const refused = recorder({ title: 'Unauthorized' }, 401);
  await assert.rejects(
    () =>
      createClient({
        baseUrl: BASE,
        token: TOKEN,
        fetch: refused.fetch,
      }).rates(),
    (error: unknown) => {
      assert.ok(error instanceof EconomyHttpError);
      assert.equal(error.status, 401);
      return true;
    },
  );

  const html: typeof fetch = async () =>
    new Response('<html>gateway</html>', {
      headers: { 'content-type': 'text/html' },
    });
  await assert.rejects(
    () => createClient({ baseUrl: BASE, fetch: html }).rates(),
    (error: unknown) => {
      assert.ok(error instanceof EconomyHttpError);
      assert.equal(error.status, 200);
      assert.equal(error.body, '<html>gateway</html>');
      return true;
    },
  );

  const offline: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => createClient({ baseUrl: BASE, fetch: offline }).rates(),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error instanceof EconomyHttpError, false);
      return true;
    },
  );
});

test('no error path carries the bearer', async () => {
  const secret = 'tok_do_not_log_me';
  const refused = recorder({ title: 'Unauthorized' }, 401);
  const client = createClient({
    baseUrl: BASE,
    token: secret,
    headers: { 'x-request-id': 'req_1' },
    fetch: refused.fetch,
  });

  await assert.rejects(client.rates(), (error: unknown) => {
    const seen = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
    assert.equal(
      seen.includes(secret),
      false,
      'the bearer reached an error path',
    );
    return true;
  });
});
