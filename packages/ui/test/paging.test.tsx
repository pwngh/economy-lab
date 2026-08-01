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
import {
  topUp,
  grantEntitlement,
  idempotencyKey,
} from '@pwngh/economy-core/ops';
import { credits } from '@pwngh/economy-money';
import { systemActor } from '@pwngh/economy-auth';
import type { App } from '@pwngh/economy-core';
import { economyClient, MAX_WINDOW } from '../src/core.js';
import type { EconomyStore, ListKey } from '../src/core.js';
import {
  EconomyProvider,
  useEntitlements,
  usePayouts,
  useSubscriptions,
  useWallet,
} from '../src/lib/react.js';

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

async function openApp(): Promise<{ app: App; fetchLike: typeof fetch }> {
  const app = await createApp(withDev({}), { env: {} });
  const fetchLike: typeof fetch = async (input, init) =>
    app.handler(
      new Request(input instanceof Request ? input : String(input), init),
    );
  return { app, fetchLike };
}

// The paging tests read `?limit=` off the log, so the window a read asked for is visible.
function recording(fetchLike: typeof fetch): {
  fetchLike: typeof fetch;
  log: string[];
} {
  const log: string[] = [];
  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    log.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    return fetchLike(input, init);
  };
  return { fetchLike: wrapped, log };
}

const fund = (app: App) =>
  app.economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('paging', 'seed'),
      actor: systemActor('fund'),
      userId: 'usr_ada',
      amount: credits(400),
      source: 'test',
    }),
  );

// Ownership records, not money: five grants make a list worth paging without five purchases.
const grant = (app: App, sku: string) =>
  app.economy.submit(
    grantEntitlement({
      idempotencyKey: idempotencyKey('paging', sku),
      actor: systemActor('fulfillment'),
      userId: 'usr_ada',
      sku,
    }),
  );

const seed = async (app: App, count: number): Promise<void> => {
  for (let i = 1; i <= count; i += 1) await grant(app, `pass-${i}`);
};

const spendOp = (tag: string) => ({
  kind: 'spend',
  idempotencyKey: tag,
  orderId: tag,
  buyerId: 'usr_ada',
  sku: 'starter-pack',
  price: 'CREDIT:120.00',
  recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
});

const items = (store: EconomyStore, key: ListKey): unknown[] =>
  store.readPage(key).data?.items ?? [];
const skus = (store: EconomyStore, key: ListKey): string[] =>
  items(store, key).map((row) => (row as { sku: string }).sku);

// The token a list currently resumes on. Pinning the log against this rather than against
// literal token bytes asserts the stronger thing: the store sends back exactly what it got.
const resumeOf = (store: EconomyStore, key: ListKey): string =>
  store.readPage(key).data?.cursor ?? '';

/**
 * Runs event-loop turns until the wire has been quiet for several of them in a row. The
 * "nothing else refetched" claims below rest on this, and a fixed sleep is a guess about how
 * long a surplus read would take to appear: this keeps looking while anything is still arriving
 * and stops as soon as the store has no continuation left to run. Bounded by turns, never by a
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
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i += 1)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'condition never became true');
};

test('paging: loadMore reads the next page and every loaded row stays loaded', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 5);
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 2,
  });
  try {
    await store.refresh('entitlements');
    assert.equal(
      items(store, 'entitlements').length,
      2,
      'the first read is one page',
    );
    assert.equal(
      store.readPage('entitlements').hasMore,
      true,
      'a cursor means more',
    );
    const firstPage = skus(store, 'entitlements');

    const afterOne = resumeOf(store, 'entitlements');
    await store.loadMore('entitlements');
    assert.equal(
      items(store, 'entitlements').length,
      4,
      'the second page appended',
    );
    assert.deepEqual(
      skus(store, 'entitlements').slice(0, 2),
      firstPage,
      'page one is still page one — the list accumulated, it did not get replaced',
    );
    assert.equal(store.readPage('entitlements').hasMore, true);

    const afterTwo = resumeOf(store, 'entitlements');
    await store.loadMore('entitlements');
    assert.deepEqual(
      skus(store, 'entitlements'),
      ['pass-1', 'pass-2', 'pass-3', 'pass-4', 'pass-5'],
      'all five rows, in one list',
    );
    assert.equal(
      store.readPage('entitlements').hasMore,
      false,
      'a null cursor is the end of the list',
    );
    assert.deepEqual(
      log,
      [
        'GET /v1/entitlements?limit=2',
        `GET /v1/entitlements?limit=2&cursor=${afterOne}`,
        `GET /v1/entitlements?limit=2&cursor=${afterTwo}`,
      ],
      'one read per page, each resuming on the token the page before it handed back',
    );
  } finally {
    store.close();
    await app.close();
  }
});

// The defect this closes: the window could only widen to the route's own read ceiling, so a
// creator with more rows than that could not reach them at all.
test('paging: a reader walks past the 200-item read ceiling, a page at a time', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 250);
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 100,
  });
  try {
    await store.refresh('entitlements');
    assert.equal(items(store, 'entitlements').length, 100);
    const afterOne = resumeOf(store, 'entitlements');
    await store.loadMore('entitlements');
    const afterTwo = resumeOf(store, 'entitlements');
    await store.loadMore('entitlements');

    const loaded = skus(store, 'entitlements');
    assert.equal(
      loaded.length,
      250,
      'every row, past a ceiling that used to be the end',
    );
    assert.ok(
      loaded.length > MAX_WINDOW,
      'and past what one read can ever hand back',
    );
    assert.equal(new Set(loaded).size, 250, 'no row arrived twice');
    assert.deepEqual(loaded, [...loaded].sort(), 'and none was skipped over');
    assert.equal(
      store.readPage('entitlements').hasMore,
      false,
      'a null cursor is the end',
    );
    // Each hop against the token the hop before it handed back. A count plus a `cursor=`
    // substring cannot tell a stale resume point from a fresh one, and the second hop is where
    // a resume protocol breaks: page three asking again from page two's cursor reads the same
    // rows twice, and both the count and the substring are still satisfied.
    assert.deepEqual(
      log,
      [
        'GET /v1/entitlements?limit=100',
        `GET /v1/entitlements?limit=100&cursor=${afterOne}`,
        `GET /v1/entitlements?limit=100&cursor=${afterTwo}`,
      ],
      'three reads for three pages, each resuming where the one before it left off',
    );
    assert.notEqual(
      afterOne,
      afterTwo,
      'and the resume point really moved between the hops',
    );
  } finally {
    store.close();
    await app.close();
  }
});

test('paging: past the end loadMore resolves without touching the wire', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 3);
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 5,
  });
  try {
    await store.refresh('entitlements');
    assert.equal(items(store, 'entitlements').length, 3);
    assert.equal(
      store.readPage('entitlements').hasMore,
      false,
      'three rows never filled five',
    );
    log.length = 0;
    let heard = 0;
    const off = store.subscribe('entitlements', () => {
      heard += 1;
    });
    await store.loadMore('entitlements');
    await store.loadMore('entitlements');
    off();
    assert.deepEqual(
      log,
      [],
      'hasMore false means loadMore is a no-op, not a wasted read',
    );
    // Not a re-render either. Nothing but this counts the notify, and the store has two guards
    // against a page that is not there: the early return here, and the cursor check inside the
    // flight. The inner one alone would still raise the loading flag and lower it again, so
    // every subscribed component would render twice for a click that fetched nothing.
    assert.equal(heard, 0, 'a list at its end pages by doing nothing at all');
  } finally {
    store.close();
    await app.close();
  }
});

test('paging: a list nobody has read yet has no pages to load', async () => {
  const { app, fetchLike } = await openApp();
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 2,
  });
  try {
    assert.deepEqual(store.readPage('payouts'), {
      data: undefined,
      error: undefined,
      hasMore: false,
      loadingMore: false,
    });
    await store.loadMore('payouts');
    assert.deepEqual(
      log,
      [],
      'there is no second page before there is a first',
    );
    // The control for the absence above: the same key, the same log, one read that really
    // happens. Without it the claim holds equally for a log that records nothing at all.
    await store.refresh('payouts');
    assert.deepEqual(
      log,
      ['GET /v1/payouts?limit=2'],
      'this is what the log looks like when a read does happen',
    );
    let heard = 0;
    const off = store.subscribe('payouts', () => {
      heard += 1;
    });
    await store.loadMore('payouts');
    off();
    assert.equal(
      log.length,
      1,
      'and a first page with no cursor leaves nothing to page either',
    );
    assert.equal(heard, 0, 'not even a re-render');
  } finally {
    store.close();
    await app.close();
  }
});

test('paging: a rejection mid-paging leaves the loaded pages intact, and the retry recovers', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 5);
  let broken = false;
  const flaky: typeof fetch = async (input, init) => {
    if (broken && String(input).includes('/v1/entitlements'))
      throw new Error('transport down');
    return fetchLike(input, init);
  };
  const { fetchLike: logged, log } = recording(flaky);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 2,
  });
  try {
    await store.refresh('entitlements');
    const loaded = skus(store, 'entitlements');
    assert.equal(loaded.length, 2);

    const resume = resumeOf(store, 'entitlements');
    broken = true;
    log.length = 0;
    await store.loadMore('entitlements');
    const failed = store.readPage('entitlements');
    assert.deepEqual(
      skus(store, 'entitlements'),
      loaded,
      'the page that had loaded is still loaded, untouched by the failed read',
    );
    assert.match(
      String(failed.error),
      /transport down/,
      'the error rides beside the data',
    );
    assert.equal(
      failed.loadingMore,
      false,
      'the flight flag clears on the failure',
    );
    assert.equal(failed.hasMore, true, 'the next page is still there to retry');

    broken = false;
    await store.loadMore('entitlements');
    assert.equal(
      items(store, 'entitlements').length,
      4,
      'the retry lands the second page',
    );
    assert.equal(
      store.readPage('entitlements').error,
      undefined,
      'a good read clears the error',
    );
    assert.deepEqual(
      log,
      [
        `GET /v1/entitlements?limit=2&cursor=${resume}`,
        `GET /v1/entitlements?limit=2&cursor=${resume}`,
      ],
      'the failed page never moved the resume point, so the retry asks from the same one',
    );
  } finally {
    store.close();
    await app.close();
  }
});

// The invalidation ruling the README states: the write refetches the width the reader holds.
test('paging: an invalidating write refetches the whole loaded window, never page one', async () => {
  const { app, fetchLike } = await openApp();
  await fund(app);
  await seed(app, 4);
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 2,
  });
  const off = store.subscribe('entitlements', () => {});
  try {
    await until(() => store.readPage('entitlements').data !== undefined);
    await store.loadMore('entitlements');
    assert.equal(items(store, 'entitlements').length, 4, 'two pages loaded');

    log.length = 0;
    const outcome = await store.submit(spendOp('paging-ord-1'));
    assert.equal(outcome.status, 'committed');
    await until(() => log.some((l) => l.startsWith('GET /v1/entitlements')));
    await quiet(log);

    assert.deepEqual(
      log.filter((l) => l.startsWith('GET')),
      ['GET /v1/entitlements?limit=4'],
      'the refetch asks for all four loaded rows, not the first two',
    );
    assert.equal(
      items(store, 'entitlements').length,
      4,
      'the reader who paged past page one is left where they were',
    );
  } finally {
    off();
    store.close();
    await app.close();
  }
});

test('paging: two loadMore calls at once share one read', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 5);
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 2,
  });
  try {
    await store.refresh('entitlements');
    const resume = resumeOf(store, 'entitlements');
    log.length = 0;
    const first = store.loadMore('entitlements');
    const second = store.loadMore('entitlements');
    assert.equal(
      first,
      second,
      'the second call joins the flight rather than starting one',
    );
    await Promise.all([first, second]);
    assert.equal(
      items(store, 'entitlements').length,
      4,
      'one page arrived, not two',
    );
    assert.deepEqual(log, [`GET /v1/entitlements?limit=2&cursor=${resume}`]);
  } finally {
    store.close();
    await app.close();
  }
});

test('paging: pageSize caps at the wire ceiling the route enforces', async () => {
  const { app, fetchLike } = await openApp();
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 500,
  });
  try {
    await store.refresh('entitlements');
    assert.deepEqual(
      log,
      [`GET /v1/entitlements?limit=${MAX_WINDOW}`],
      'an oversized page size asks for the ceiling, never past it',
    );
  } finally {
    store.close();
    await app.close();
  }
});

// The expansion table under paging: loadMore is still one hook, one client read, one path.
test('paging: loadMore hits exactly its own wire path and leaves the neighbours quiet', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 5);
  const { fetchLike: logged, log } = recording(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
    pageSize: 2,
  });
  let entitlements: ReturnType<typeof useEntitlements> | null = null;
  let subscriptions: ReturnType<typeof useSubscriptions> | null = null;
  let payouts: ReturnType<typeof usePayouts> | null = null;
  let wallet: ReturnType<typeof useWallet> | null = null;
  function Storefront() {
    entitlements = useEntitlements();
    subscriptions = useSubscriptions();
    payouts = usePayouts();
    wallet = useWallet();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(
        <EconomyProvider client={store}>
          <Storefront />
        </EconomyProvider>,
      );
    });
    await act(async () => {
      await until(() =>
        [entitlements, subscriptions, payouts, wallet].every(
          (r) => r?.data !== undefined,
        ),
      );
    });
    assert.equal(
      entitlements!.hasMore,
      true,
      'five grants over a two-row page',
    );
    assert.equal(
      subscriptions!.hasMore,
      false,
      'an empty list has nothing to page',
    );

    const resume = resumeOf(store, 'entitlements');
    log.length = 0;
    await act(async () => {
      await entitlements!.loadMore();
    });
    await quiet(log);
    assert.deepEqual(
      log,
      [`GET /v1/entitlements?limit=2&cursor=${resume}`],
      'one hook, one client read: no neighbour refetched to serve a page',
    );
    assert.equal(entitlements!.data!.items.length, 4);
  } finally {
    await act(async () => root.unmount());
    store.close();
    await app.close();
  }
});

test('paging: loadingMore is true only while the resuming read is out', async () => {
  const { app, fetchLike } = await openApp();
  await seed(app, 5);
  let gating = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const gated: typeof fetch = async (input, init) => {
    if (gating && String(input).includes('/v1/entitlements')) await gate;
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: gated,
    pollMs: false,
    pageSize: 2,
  });
  let result: ReturnType<typeof useEntitlements> | null = null;
  function List() {
    result = useEntitlements();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(
        <EconomyProvider client={store}>
          <List />
        </EconomyProvider>,
      );
    });
    await act(async () => {
      await until(() => result?.data !== undefined);
    });
    assert.equal(
      result!.loadingMore,
      false,
      'the first read is not a widening',
    );

    gating = true;
    let flight!: Promise<void>;
    await act(async () => {
      flight = result!.loadMore();
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(
      result!.loadingMore,
      true,
      'the component sees the page arriving',
    );
    assert.equal(
      result!.data!.items.length,
      2,
      'and still renders the page it has',
    );

    release();
    await act(async () => {
      await flight;
    });
    assert.equal(
      result!.loadingMore,
      false,
      'the flag clears when the page lands',
    );
    assert.equal(result!.data!.items.length, 4);
  } finally {
    await act(async () => root.unmount());
    store.close();
    await app.close();
  }
});
