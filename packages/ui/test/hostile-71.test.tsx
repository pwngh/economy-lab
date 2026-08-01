/**
 * @pwngh/economy-ui
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createApp, withDev } from '@pwngh/economy-core';
import { topUp, idempotencyKey } from '@pwngh/economy-core/ops';
import { credits } from '@pwngh/economy-money';
import { systemActor } from '@pwngh/economy-auth';
import type { App } from '@pwngh/economy-core';
import { economyClient } from '../src/core.js';
import { EconomyProvider, useSubmit } from '../src/lib/react.js';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://storefront.test',
});
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

const BASE = 'http://economy.test';

// A stub wire: GETs log and answer {}, POSTs answer the scripted body verbatim.
function stubWire(): {
  fetchLike: typeof fetch;
  gets: string[];
  posts: { path: string; headers: Headers }[];
  answer: (body: unknown, status?: number, raw?: string) => void;
} {
  const gets: string[] = [];
  const posts: { path: string; headers: Headers }[] = [];
  let next: { body?: unknown; status: number; raw?: string } = {
    body: {},
    status: 200,
  };
  const fetchLike: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if ((init?.method ?? 'GET') === 'GET') {
      gets.push(path);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    posts.push({ path, headers: new Headers(init?.headers) });
    const text = next.raw ?? JSON.stringify(next.body);
    return new Response(text, {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetchLike,
    gets,
    posts,
    answer: (body, status = 200, raw?) => {
      next = { body, status, ...(raw !== undefined ? { raw } : {}) };
    },
  };
}

/**
 * Runs event-loop turns until the wire has been quiet for several of them in a row. Every
 * "and nothing else refetched" below rests on this, and a fixed sleep is a guess about how long
 * a surplus read would take to appear: this keeps looking while anything is still arriving and
 * stops as soon as the store has no continuation left to run. Bounded by turns, never by a
 * clock. Every store here polls `false`, so the store owns no timer that could fire later.
 */
const quiet = async (log: string[], calm = 6, limit = 400): Promise<void> => {
  let still = 0;
  for (let i = 0; i < limit && still < calm; i += 1) {
    const before = log.length;
    await new Promise((r) => setImmediate(r));
    still = log.length === before ? still + 1 : 0;
  }
};

// meta.kind is host data on the wire; an inherited Object.prototype name must fall to the
// all-watched superset like any other unknown kind, never crash the settled submit.
test('hostile: meta.kind "toString" resolves and falls back to every watched read', async () => {
  const wire = stubWire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire.fetchLike,
    pollMs: false,
  });
  const offs = [
    store.subscribe('wallet', () => {}),
    store.subscribe('subscriptions', () => {}),
  ];
  try {
    await quiet(wire.gets);
    wire.gets.length = 0;
    wire.answer({
      status: 'committed',
      transaction: { meta: { kind: 'toString' } },
    });
    const outcome = await store.submitRoute('/pay', { anything: true });
    assert.equal((outcome as { status: string }).status, 'committed');
    await quiet(wire.gets);
    assert.deepEqual(
      [...wire.gets].sort(),
      ['/v1/subscriptions', '/v1/wallet'],
      'an inherited-prototype kind is unknown: every watched read refreshes',
    );
  } finally {
    for (const off of offs) off();
    store.close();
  }
});

test('hostile: a made-up meta.kind ("yolo") falls back to every watched read', async () => {
  const wire = stubWire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire.fetchLike,
    pollMs: false,
  });
  const offs = [
    store.subscribe('wallet', () => {}),
    store.subscribe('payouts', () => {}),
  ];
  try {
    await quiet(wire.gets);
    wire.gets.length = 0;
    wire.answer({
      status: 'committed',
      transaction: { meta: { kind: 'yolo' } },
    });
    await store.submitRoute('/pay', {});
    await quiet(wire.gets);
    assert.deepEqual([...wire.gets].sort(), ['/v1/payouts', '/v1/wallet']);
  } finally {
    for (const off of offs) off();
    store.close();
  }
});

test('hostile: a 200 with a non-JSON body rejects, refetches nothing, and the store survives', async () => {
  const wire = stubWire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire.fetchLike,
    pollMs: false,
  });
  const off = store.subscribe('wallet', () => {});
  try {
    await quiet(wire.gets);
    wire.gets.length = 0;
    wire.answer(undefined, 200, '<html>gateway smiled</html>');
    await assert.rejects(store.submitRoute('/pay', {}));
    await quiet(wire.gets);
    assert.deepEqual(
      wire.gets,
      [],
      'a throw before the envelope refetches nothing',
    );
    wire.answer({
      status: 'committed',
      transaction: { meta: { kind: 'topUp' } },
    });
    await store.submitRoute('/pay', {});
    await quiet(wire.gets);
    assert.deepEqual(
      wire.gets,
      ['/v1/wallet'],
      'the next submit still invalidates',
    );
  } finally {
    off();
    store.close();
  }
});

// A 200 non-envelope is a peel answer ({"ok":true} from a handler's own Response). The store
// cannot name a kind, so the safe superset refreshes — over-fetch, never a stale miss.
test('hostile: a 200 non-envelope body resolves and refreshes every watched read', async () => {
  const wire = stubWire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire.fetchLike,
    pollMs: false,
  });
  const off = store.subscribe('wallet', () => {});
  try {
    await quiet(wire.gets);
    wire.gets.length = 0;
    wire.answer({ ok: true });
    const outcome = await store.submitRoute('/pay', { sku: 'kit' });
    assert.deepEqual(
      outcome,
      { ok: true },
      'the non-envelope body comes back verbatim',
    );
    await quiet(wire.gets);
    assert.deepEqual(wire.gets, ['/v1/wallet']);
  } finally {
    off();
    store.close();
  }
});

test('hostile: no token means no authorization header on submitRoute', async () => {
  const wire = stubWire();
  const store = economyClient({
    baseUrl: BASE,
    fetch: wire.fetchLike,
    pollMs: false,
  });
  try {
    wire.answer({
      status: 'committed',
      transaction: { meta: { kind: 'topUp' } },
    });
    await store.submitRoute('/pay', {});
    assert.equal(wire.posts.length, 1);
    assert.equal(wire.posts[0]!.headers.get('authorization'), null);
    assert.match(
      wire.posts[0]!.headers.get('idempotency-key') ?? '',
      /^[0-9a-f-]{36}$/,
      'a fresh UUID key is minted when the caller passes none',
    );
  } finally {
    store.close();
  }
});

// The wire-client contract: an empty token is no token. The strict server grammar refuses
// a bare `Bearer` header, so sending one would turn "anonymous" into a malformed request.
test('hostile: an empty-string token sends no authorization header, like the wire client', async () => {
  const wire = stubWire();
  const store = economyClient({
    baseUrl: BASE,
    token: '',
    fetch: wire.fetchLike,
    pollMs: false,
  });
  try {
    wire.answer({
      status: 'committed',
      transaction: { meta: { kind: 'topUp' } },
    });
    await store.submitRoute('/pay', {});
    assert.equal(wire.posts.length, 1);
    assert.equal(
      wire.posts[0]!.headers.get('authorization'),
      null,
      'an empty token never rides the wire as a bare `Bearer` header',
    );
  } finally {
    store.close();
  }
});

test('hostile: close() during an in-flight submit skips the refetch', async () => {
  const wire = stubWire();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const gated: typeof fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === 'POST') await gate;
    return wire.fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: gated,
    pollMs: false,
  });
  const off = store.subscribe('wallet', () => {});
  try {
    await quiet(wire.gets);
    wire.gets.length = 0;
    wire.answer({
      status: 'committed',
      transaction: { meta: { kind: 'topUp' } },
    });
    const flight = store.submitRoute('/pay', {});
    store.close();
    release();
    const outcome = await flight;
    assert.equal(
      (outcome as { status: string }).status,
      'committed',
      'the envelope still lands',
    );
    await quiet(wire.gets);
    assert.deepEqual(wire.gets, [], 'a closed store never refetches');
  } finally {
    off();
    store.close();
  }
});

// --- useSubmit under fire --------------------------------------------------------------

test('hostile: two un-awaited submits serialize, and the second lastOutcome wins', async () => {
  const posts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let n = 0;
  const wire: typeof fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    n += 1;
    const tag = `leg-${n}`;
    posts.push(tag);
    if (tag === 'leg-1') await gate;
    return new Response(
      JSON.stringify({
        status: 'committed',
        transaction: { meta: { kind: 'topUp' }, tag },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire,
    pollMs: false,
  });
  let door: ReturnType<typeof useSubmit> | null = null;
  function Door() {
    door = useSubmit('/pay');
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(
        <EconomyProvider client={store}>
          <Door />
        </EconomyProvider>,
      );
    });
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = door!.submit({ leg: 1 });
      second = door!.submit({ leg: 2 });
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.deepEqual(
      posts,
      ['leg-1'],
      'the second POST waits for the first envelope',
    );
    assert.equal(door!.pending, true, 'pending holds across the whole queue');
    release();
    await act(async () => {
      await Promise.all([first, second]);
    });
    assert.deepEqual(
      posts,
      ['leg-1', 'leg-2'],
      'the queue ran in submission order',
    );
    assert.equal(
      (door!.lastOutcome as unknown as { transaction: { tag: string } })
        .transaction.tag,
      'leg-2',
      'the later submit owns lastOutcome',
    );
    assert.equal(door!.pending, false, 'pending clears once the queue drains');
  } finally {
    await act(async () => root.unmount());
    store.close();
  }
});

test('hostile: a transport throw rejects the returned promise and still clears pending', async () => {
  const wire: typeof fetch = async (input, init) =>
    (init?.method ?? 'GET') === 'GET'
      ? new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('{"boom":true}', { status: 503 });
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire,
    pollMs: false,
  });
  let door: ReturnType<typeof useSubmit> | null = null;
  function Door() {
    door = useSubmit('/pay');
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(
        <EconomyProvider client={store}>
          <Door />
        </EconomyProvider>,
      );
    });
    // The reason the host gave rides the throw: the status and the body it answered with,
    // in the same error the reads throw.
    await act(async () => {
      await assert.rejects(door!.submit({}), {
        name: 'EconomyHttpError',
        status: 503,
        body: '{"boom":true}',
      });
    });
    assert.equal(door!.pending, false, 'pending clears on the throw');
    assert.equal(
      door!.lastOutcome,
      undefined,
      'a throw never becomes an outcome',
    );
    // The queue is not poisoned: the next submit still runs.
    await act(async () => {
      await assert.rejects(door!.submit({}), {
        name: 'EconomyHttpError',
        status: 503,
      });
    });
    assert.equal(door!.pending, false);
  } finally {
    await act(async () => root.unmount());
    store.close();
  }
});

test('hostile: unmount during an in-flight submit resolves without error', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const wire: typeof fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === 'POST') await gate;
    return new Response(
      JSON.stringify({
        status: 'committed',
        transaction: { meta: { kind: 'topUp' } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: wire,
    pollMs: false,
  });
  let door: ReturnType<typeof useSubmit> | null = null;
  function Door() {
    door = useSubmit('/pay');
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  let flight!: Promise<unknown>;
  await act(async () => {
    root.render(
      <EconomyProvider client={store}>
        <Door />
      </EconomyProvider>,
    );
  });
  await act(async () => {
    flight = door!.submit({});
    await new Promise((r) => setTimeout(r, 10));
  });
  await act(async () => root.unmount());
  release();
  const outcome = await flight;
  assert.equal((outcome as { status: string }).status, 'committed');
  store.close();
});

// The end-to-end teeth for the map fix: a subscribe through a host route must refetch
// entitlements — the grant rides the charge in the same transaction.
test('hostile: a route subscribe refetches entitlements along with wallet and subscriptions', async () => {
  const app: App = await createApp(
    withDev({
      routes: {
        'POST /join': async ({ request }: { request: Request }) => {
          const { sku } = (await request.json()) as { sku: string };
          return {
            kind: 'subscribe',
            sku,
            sellerId: 'usr_ben',
            price: credits(100),
            periodMs: 30 * 24 * 3_600_000,
          };
        },
      },
    }),
    { env: {} },
  );
  const fetchLike: typeof fetch = async (input, init) =>
    app.handler(
      new Request(input instanceof Request ? input : String(input), init),
    );
  const log: string[] = [];
  const logged: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    log.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return fetchLike(input, init);
  };
  await app.economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('hostile-71', 'sub-seed'),
      actor: systemActor('fund'),
      userId: 'usr_ada',
      amount: credits(400),
      source: 'test',
    }),
  );
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
  });
  const offs = (
    ['wallet', 'entitlements', 'subscriptions', 'payouts'] as const
  ).map((k) => store.subscribe(k, () => {}));
  try {
    await until(() => log.filter((l) => l.startsWith('GET')).length >= 4);
    log.length = 0;
    const outcome = await store.submitRoute('/join', { sku: 'club' });
    assert.equal((outcome as { status: string }).status, 'committed');
    await until(() => log.filter((l) => l.startsWith('GET')).length >= 3);
    await quiet(log);
    assert.deepEqual(
      [...log].sort(),
      [
        'GET /v1/entitlements',
        'GET /v1/subscriptions',
        'GET /v1/wallet',
        'POST /join',
      ],
      'subscribe touches wallet, entitlements, and subscriptions — payouts stays quiet',
    );
    const entitlements = (await store.client.entitlements()) as {
      items: { sku: string }[];
    };
    assert.ok(
      entitlements.items.some((e) => e.sku === 'club'),
      'the grant is real: the entitlements read shows the sku',
    );
  } finally {
    for (const off of offs) off();
    store.close();
    await app.close();
  }
});

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i += 1)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'condition never became true');
};
