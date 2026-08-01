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
  spend,
  subscribe,
  requestPayout,
  grantEntitlement,
  idempotencyKey,
} from '@pwngh/economy-core/ops';
import { credits } from '@pwngh/economy-money';
import { systemActor, userActor } from '@pwngh/economy-auth';
import type { App } from '@pwngh/economy-core';
import { economyClient } from '../src/core.js';
import type { EconomyStore } from '../src/core.js';
import {
  EconomyProvider,
  useWallet,
  useEntitlements,
  useSubscriptions,
  usePayouts,
  useSubmit,
} from '../src/lib/react.js';

// jsdom stands in for the browser; react-dom/client renders for real, no headless browser.
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

// A real dev app behind a fetch bridge — wire-level calls, no socket.
async function openApp(
  module: Record<string, unknown> = {},
): Promise<{ app: App; fetchLike: typeof fetch }> {
  const app = await createApp(withDev(module), { env: {} });
  const fetchLike: typeof fetch = async (input, init) =>
    app.handler(
      new Request(input instanceof Request ? input : String(input), init),
    );
  return { app, fetchLike };
}

// The same bridge with a wire log — the loop tests assert exact refetch sets from it.
function logging(fetchLike: typeof fetch): {
  fetchLike: typeof fetch;
  log: string[];
} {
  const log: string[] = [];
  const wrapped: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    log.push(
      `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}`,
    );
    return fetchLike(input, init);
  };
  return { fetchLike: wrapped, log };
}

const fund = (app: App, tag: string, amount = credits(400)) =>
  app.economy.submit(
    topUp({
      idempotencyKey: idempotencyKey('react-test', tag),
      actor: systemActor('fund'),
      userId: 'usr_ada',
      amount,
      source: 'test',
    }),
  );

const spendOp = (tag: string) => ({
  kind: 'spend',
  idempotencyKey: tag,
  orderId: tag,
  buyerId: 'usr_ada',
  sku: 'starter-pack',
  price: 'CREDIT:120.00',
  recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
});

const spendable = (store: EconomyStore) =>
  (store.read('wallet').data as Record<string, string> | undefined)?.spendable;

/**
 * Runs event-loop turns until the wire has been quiet for several of them in a row. The
 * "nothing else refetched" claims below rest on this, and a fixed sleep is a guess about how
 * long a surplus read would take to appear: this keeps looking while anything is still arriving
 * and stops as soon as the store has no continuation left to run. Bounded by turns, never by a
 * clock. Each store using it polls `false`, so no timer of the store's own can fire later — a
 * poll claim still needs the clock, and the two tests that make one still wait on it.
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

test('core: refresh reads, and the poll picks up a server-side change', async () => {
  const { app, fetchLike } = await openApp();
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: fetchLike,
    pollMs: 25,
  });
  try {
    assert.deepEqual(store.read('wallet'), {
      data: undefined,
      error: undefined,
    });
    await fund(app, 'seed');
    await store.refresh('wallet');
    assert.equal(spendable(store), 'CREDIT:400.00');

    // Poll: a subscriber attaches, money moves server-side, the snapshot follows.
    let ticks = 0;
    const off = store.subscribe('wallet', () => {
      ticks += 1;
    });
    await fund(app, 'more', credits(100));
    await until(() => spendable(store) === 'CREDIT:500.00');
    assert.ok(ticks >= 1, 'the subscriber heard the poll');
    off();
  } finally {
    store.close();
    await app.close();
  }
});

// Polling is off, so only the write door can deliver the new balance.
test('core: submit invalidates every subscribed key, no poll to hide behind', async () => {
  const { app, fetchLike } = await openApp();
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: fetchLike,
    pollMs: false,
  });
  try {
    await fund(app, 'seed');
    const off = store.subscribe('wallet', () => {});
    await until(() => spendable(store) !== undefined);
    const outcome = await store.submit(spendOp('react-ord-1'));
    assert.equal(outcome.status, 'committed');
    await until(() => spendable(store) === 'CREDIT:280.00');
    off();
  } finally {
    store.close();
    await app.close();
  }
});

// A read that departed before the write must not satisfy the invalidation.
test('core: invalidation waits out a read already in flight', async () => {
  const { app, fetchLike } = await openApp();
  await fund(app, 'seed');
  let hold: Promise<void> | null = null;
  const gated: typeof fetch = async (input, init) => {
    const res = await fetchLike(input, init);
    if (hold && String(input).includes('/v1/wallet')) await hold;
    return res;
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: gated,
    pollMs: false,
  });
  try {
    await store.refresh('wallet');
    const off = store.subscribe('wallet', () => {});
    let release!: () => void;
    hold = new Promise((r) => {
      release = r;
    });
    const stale = store.refresh('wallet'); // departs pre-write, response held
    const outcome = await store.submit(spendOp('react-ord-2'));
    assert.equal(outcome.status, 'committed');
    hold = null;
    release();
    await stale;
    await until(() => spendable(store) === 'CREDIT:280.00');
    off();
  } finally {
    store.close();
    await app.close();
  }
});

test('core: a throwing subscriber never rejects the shared read', async () => {
  const { app, fetchLike } = await openApp();
  await fund(app, 'seed');
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: fetchLike,
    pollMs: false,
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => {
    unhandled.push(e);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    let heard = 0;
    const off = store.subscribe('wallet', () => {
      throw new Error('listener boom');
    });
    const off2 = store.subscribe('wallet', () => {
      heard += 1;
    });
    await store.refresh('wallet'); // resolves: the read succeeded, the throw was the listener's
    assert.equal(spendable(store), 'CREDIT:400.00');
    assert.ok(heard >= 1, 'the second listener still hears the change');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, [], 'no unhandled rejection escaped');
    off();
    off2();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    store.close();
    await app.close();
  }
});

test('core: after close() a new subscriber triggers no read', async () => {
  const { app, fetchLike } = await openApp();
  let calls = 0;
  const counting: typeof fetch = async (input, init) => {
    calls += 1;
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: counting,
    pollMs: 20,
  });
  try {
    store.close();
    const off = store.subscribe('wallet', () => {});
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls, 0, 'a closed store never reads');
    off();
  } finally {
    store.close();
    await app.close();
  }
});

test('core: a failed read keeps the last good data, and recovery clears the error', async () => {
  const { app, fetchLike } = await openApp();
  await fund(app, 'seed');
  let broken = false;
  const flaky: typeof fetch = async (input, init) => {
    if (broken) throw new Error('transport down');
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: flaky,
    pollMs: false,
  });
  try {
    await store.refresh('wallet');
    assert.equal(spendable(store), 'CREDIT:400.00');
    broken = true;
    await store.refresh('wallet');
    assert.match(String(store.read('wallet').error), /transport down/);
    assert.equal(
      spendable(store),
      'CREDIT:400.00',
      'last good data survives the failure',
    );
    broken = false;
    await store.refresh('wallet');
    assert.equal(
      store.read('wallet').error,
      undefined,
      'a good read clears the error',
    );
  } finally {
    store.close();
    await app.close();
  }
});

test('core: an unauthenticated read carries the 401 as the error', async () => {
  const { app, fetchLike } = await openApp();
  const anonymous = economyClient({
    baseUrl: BASE,
    fetch: fetchLike,
    pollMs: false,
  });
  try {
    await anonymous.refresh('wallet');
    const state = anonymous.read('wallet');
    assert.equal(state.data, undefined);
    assert.match(String(state.error), /401/);
  } finally {
    anonymous.close();
    await app.close();
  }
});

/**
 * One row on each of the three lists, for a fixture that funded a wallet and left every list
 * empty. Ada owns a SKU outright and subscribes to another, and Ben's purchase from her earns
 * the balance her payout reserves against.
 *
 * The payout minimum is the one policy this moves: 20,000 credits by default ($100 at
 * $0.005/credit), and earning that here would need a velocity override as well, for a row whose
 * shape is what the test is about.
 */
const seedEachList = async (app: App): Promise<void> => {
  const key = (n: string) => idempotencyKey('react-rows', n);
  await app.economy.submit(
    grantEntitlement({
      idempotencyKey: key('grant'),
      actor: systemActor('fulfillment'),
      userId: 'usr_ada',
      sku: 'world-kit',
    }),
  );
  await app.economy.submit(
    subscribe({
      idempotencyKey: key('sub'),
      actor: userActor('usr_ada'),
      userId: 'usr_ada',
      sellerId: 'usr_ben',
      sku: 'club-pass',
      price: credits(100),
      periodMs: 30 * 24 * 3_600_000,
    }),
  );
  await app.economy.submit(
    topUp({
      idempotencyKey: key('fund-ben'),
      actor: systemActor('fund'),
      userId: 'usr_ben',
      amount: credits(200),
      source: 'test',
    }),
  );
  await app.economy.submit(
    spend({
      idempotencyKey: key('ben-buys'),
      actor: userActor('usr_ben'),
      orderId: 'ord_react_rows',
      buyerId: 'usr_ben',
      sku: 'hat',
      price: credits(200),
      recipients: [{ sellerId: 'usr_ada', shareBps: 10_000 }],
    }),
  );
  await app.economy.submit(
    requestPayout({
      idempotencyKey: key('payout'),
      actor: userActor('usr_ada'),
      userId: 'usr_ada',
      amount: credits(100),
    }),
  );
};

test('hooks: all four render real data, each over its own wire read', async () => {
  const { app, fetchLike } = await openApp({
    policy: { payoutMinimumEarnedMinor: 10_000n },
  });
  // 500 in, 100 out to the subscription's first period: the balance below is what is left.
  await fund(app, 'seed', credits(500));
  await seedEachList(app);
  const paths: string[] = [];
  const recording: typeof fetch = async (input, init) => {
    paths.push(new URL(String(input)).pathname);
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: recording,
    pollMs: false,
  });
  let walletResult: ReturnType<typeof useWallet> | null = null;
  let entitlementsResult: ReturnType<typeof useEntitlements> | null = null;
  let subscriptionsResult: ReturnType<typeof useSubscriptions> | null = null;
  let payoutsResult: ReturnType<typeof usePayouts> | null = null;

  function Storefront() {
    walletResult = useWallet();
    entitlementsResult = useEntitlements();
    subscriptionsResult = useSubscriptions();
    payoutsResult = usePayouts();
    return (
      <output>
        {(walletResult.data as Record<string, string>)?.spendable ?? 'loading'}
      </output>
    );
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
      await until(
        () =>
          walletResult?.data !== undefined && payoutsResult?.data !== undefined,
      );
    });
    assert.equal(
      dom.window.document.querySelector('output')!.textContent,
      'CREDIT:400.00',
    );
    assert.deepEqual(
      Object.keys(walletResult!).sort(),
      ['data', 'error', 'refresh'],
      'the wallet hook returns { data, error, refresh }, nothing else — it has no list',
    );
    // The list hooks are that shape plus the window, and nothing beyond it.
    const paging = [
      'data',
      'error',
      'hasMore',
      'loadMore',
      'loadingMore',
      'refresh',
    ];
    for (const [name, result] of Object.entries({
      useEntitlements: entitlementsResult!,
      useSubscriptions: subscriptionsResult!,
      usePayouts: payoutsResult!,
    })) {
      assert.deepEqual(
        Object.keys(result).sort(),
        paging,
        `${name} adds exactly the window`,
      );
    }
    // Every list carries a row. Against `{ items: [], cursor: null }` these three claims
    // predicted nothing about a list that has any, and the fixture never gave them one — a
    // hook wired to another list's read answered the same empty page as the right one.
    assert.deepEqual(
      entitlementsResult!.data!.items.map((row) => row.sku).sort(),
      ['club-pass', 'world-kit'],
      'the subscription grant rides beside the direct one',
    );
    assert.deepEqual(
      subscriptionsResult!.data!.items.map(
        (row) => `${row.sku} ${row.state} ${row.price}`,
      ),
      ['club-pass ACTIVE CREDIT:100.00'],
    );
    assert.deepEqual(
      payoutsResult!.data!.items.map((row) => `${row.state} ${row.reserve}`),
      ['RESERVED CREDIT:100.00'],
    );
    // `hasMore` against the cursor the wire handed back, rather than against the seed it
    // happens to match while every list is short.
    for (const [name, result] of Object.entries({
      useEntitlements: entitlementsResult!,
      useSubscriptions: subscriptionsResult!,
      usePayouts: payoutsResult!,
    })) {
      assert.equal(
        result.hasMore,
        result.data!.cursor !== null,
        `${name}'s hasMore is the wire's own answer about whether rows remain`,
      );
      assert.equal(result.loadingMore, false, `${name} has no page in flight`);
    }
    // The expansion table at runtime: four hooks, four distinct reads, one each.
    assert.deepEqual(paths.filter((p) => p.startsWith('/v1')).sort(), [
      '/v1/entitlements',
      '/v1/payouts',
      '/v1/subscriptions',
      '/v1/wallet',
    ]);

    // refresh() is the hook's only verb: money moves server-side, the caller asks again.
    await fund(app, 'more', credits(100));
    await act(async () => {
      await walletResult!.refresh();
    });
    assert.equal(
      dom.window.document.querySelector('output')!.textContent,
      'CREDIT:500.00',
    );
  } finally {
    await act(async () => root.unmount());
    store.close();
    await app.close();
  }
});

test('hooks: StrictMode double-mount shares one poll and unmount ends it', async () => {
  const { app, fetchLike } = await openApp();
  await fund(app, 'seed');
  let calls = 0;
  const counting: typeof fetch = async (input, init) => {
    calls += 1;
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: counting,
    pollMs: 20,
  });
  let result: ReturnType<typeof useWallet> | null = null;
  function Balance() {
    result = useWallet();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <EconomyProvider client={store}>
            <Balance />
          </EconomyProvider>
        </React.StrictMode>,
      );
    });
    await act(async () => {
      await until(() => result?.data !== undefined);
    });
    await act(async () => root.unmount());
    await new Promise((r) => setTimeout(r, 50)); // drain any tick already dispatched
    const settled = calls;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls, settled, 'no poll survives the unmount');
  } finally {
    store.close();
    await app.close();
  }
});

// Each row whole, rather than its cells found anywhere in the file: the three substrings this
// replaced were satisfied by a table that mapped a hook to the wrong read, and the export
// checks that stood beside them are `surface.test.tsx`'s exact roster said a second time.
test('README: the expansion table resolves every read to its hook and its wire path', async () => {
  const { readFileSync } = await import('node:fs');
  const { READ_KEYS } = await import('../src/core.js');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  let rows = 0;
  for (const key of READ_KEYS) {
    const hook = `use${key[0]!.toUpperCase()}${key.slice(1)}`;
    assert.match(
      md,
      // \s* absorbs the column padding prettier aligns the table to.
      new RegExp(
        `\\|\\s*\`${hook}\\(\\)\`\\s*\\|\\s*\`client\\.${key}\\(\\)\`\\s*\\|\\s*\`GET /v1/${key}\`\\s*\\|`,
      ),
      `the table maps ${hook}() to client.${key}() to GET /v1/${key}, in one row`,
    );
    rows += 1;
  }
  assert.equal(rows, 4, 'four read keys, four rows resolved');
  // The paths those rows name are the paths the hooks reach: 'hooks: all four render real data'
  // reads them off the wire.
  assert.deepEqual(READ_KEYS.map((key) => `/v1/${key}`).sort(), [
    '/v1/entitlements',
    '/v1/payouts',
    '/v1/subscriptions',
    '/v1/wallet',
  ]);
});

// The paging claims are product too: every one below is asserted against the code elsewhere
// in this suite, so the README cannot drift from what the hooks do.
test('README: the paging table, the window, and the invalidation ruling are all stated', async () => {
  const { readFileSync } = await import('node:fs');
  const { LIST_KEYS, MAX_WINDOW } = await import('../src/core.js');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const key of LIST_KEYS) {
    const hook = `use${key[0]!.toUpperCase()}${key.slice(1)}`;
    assert.match(
      md,
      // \s* absorbs the column padding prettier aligns the table to; the row and its verdict
      // are still matched exactly.
      new RegExp(`\\|\\s*\`${hook}\\(\\)\`\\s*\\|.*\\|\\s*yes\\s*\\|`),
      `the expansion table marks ${hook}() as paging`,
    );
  }
  assert.match(
    md,
    /\|\s*`useWallet\(\)`\s*\|.*\|\s*no\s*\|/,
    'the table marks useWallet() as not paging',
  );
  // The number the cap sentence states, read out and compared to the constant. `includes('200')`
  // was what stood here, which the paragraph's own deletion left green as long as any other
  // sentence mentioned an HTTP 200.
  // \s+ because the sentence wraps between "most" and the number.
  const cap = /at most\s+(\d+) items — the exported `MAX_WINDOW`/.exec(md);
  assert.ok(
    cap,
    'the README states the per-read cap and names the constant it comes from',
  );
  assert.equal(
    Number(cap[1]),
    MAX_WINDOW,
    'and the number it states is the one the package exports',
  );
  assert.ok(
    md.includes('`cursor` is a resume token'),
    'the README says the cursor is what advances a list',
  );
  assert.ok(
    md.includes('names a position and never a person'),
    'the README states that a cursor carries no scope',
  );
  assert.ok(
    md.includes('not reset to page one'),
    'the README states what invalidation does to an already-paged list',
  );
  assert.ok(
    md.includes('useSyncExternalStore'),
    'the README says why the store owns hasMore and loadingMore',
  );
  assert.ok(
    md.includes('`useWallet()`\nhas no list') ||
      md.includes('`useWallet()` has no list'),
    'the non-goals keep the wallet hook listless',
  );
});

test('every hook refuses to run outside an <EconomyProvider>, by name', async () => {
  const { renderToString } = await import('react-dom/server');
  const hooks = { useWallet, useEntitlements, useSubscriptions, usePayouts };
  for (const [name, hook] of Object.entries(hooks)) {
    function Naked() {
      hook();
      return null;
    }
    assert.throws(
      () => renderToString(<Naked />),
      (e: unknown) =>
        String(e).includes(`${name}() needs an <EconomyProvider>`),
      `${name} names itself in the refusal`,
    );
  }
});

// --- wave 7.1: the money loop ---------------------------------------------------------

// The host owns the price — the client names a sku, nothing more (the browser law).
const LISTINGS = new Map([
  ['starter-pack', credits(120)],
  ['gem', credits(50)],
  ['yacht', credits(9_000)],
]);
const CHECKOUT_MODULE = {
  // Headroom past the 1,000-credit/hour dev cap: the rejected 9,000-credit attempt
  // below still counts into the outflow window and would risk-deny the legs after it.
  policy: { velocityLimitMinor: 10_000_000n },
  routes: {
    'POST /checkout': async ({ request }: { request: Request }) => {
      const { sku } = (await request.json()) as { sku: string };
      const price = LISTINGS.get(sku);
      if (!price) return new Response(null, { status: 404 });
      return {
        kind: 'spend',
        orderId: `ord:${sku}`,
        sku,
        price,
        recipients: [{ sellerId: 'usr_ben', shareBps: 10_000 }],
      };
    },
  },
};

test('money loop: a route submit refetches exactly the mapped reads', async () => {
  const { app, fetchLike } = await openApp(CHECKOUT_MODULE);
  await fund(app, 'seed');
  const { fetchLike: logged, log } = logging(fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: logged,
    pollMs: false,
  });
  let wallet: ReturnType<typeof useWallet> | null = null;
  let entitlements: ReturnType<typeof useEntitlements> | null = null;
  let payouts: ReturnType<typeof usePayouts> | null = null;
  let subscriptions: ReturnType<typeof useSubscriptions> | null = null;
  let door: ReturnType<typeof useSubmit> | null = null;
  function Storefront() {
    wallet = useWallet();
    entitlements = useEntitlements();
    payouts = usePayouts();
    subscriptions = useSubscriptions();
    door = useSubmit('/checkout');
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
        [wallet, entitlements, payouts, subscriptions].every(
          (r) => r?.data !== undefined,
        ),
      );
    });

    // The committed leg: spend maps to wallet + entitlements, nothing else refetches.
    const before = log.length;
    let outcome: Awaited<
      ReturnType<ReturnType<typeof useSubmit>['submit']>
    > | null = null;
    await act(async () => {
      outcome = await door!.submit({ sku: 'starter-pack' });
    });
    await act(async () => {
      await until(
        () => log.slice(before).filter((l) => l.startsWith('GET')).length >= 2,
      );
    });
    await quiet(log);
    assert.equal((outcome as { status: string } | null)?.status, 'committed');
    assert.deepEqual(
      log.slice(before).sort(),
      ['GET /v1/entitlements', 'GET /v1/wallet', 'POST /checkout'],
      'exactly the mapped reads refetch — payouts and subscriptions stay quiet',
    );
    assert.equal(door!.pending, false, 'pending settles after the envelope');
    assert.equal((door!.lastOutcome as { status: string }).status, 'committed');

    // The rejection leg: a "no" is data on lastOutcome and refetches nothing.
    const beforeNo = log.length;
    await act(async () => {
      outcome = await door!.submit({ sku: 'yacht' });
    });
    await quiet(log);
    assert.equal((outcome as { status: string } | null)?.status, 'rejected');
    assert.deepEqual(
      log.slice(beforeNo),
      ['POST /checkout'],
      'a rejection refetches nothing',
    );
    assert.equal((door!.lastOutcome as { status: string }).status, 'rejected');

    // The duplicate leg: a replayed success invalidates identically.
    const beforeDup = log.length;
    await act(async () => {
      outcome = await door!.submit(
        { sku: 'gem' },
        { idempotencyKey: 'loop-dup-1' },
      );
    });
    await act(async () => {
      outcome = await door!.submit(
        { sku: 'gem' },
        { idempotencyKey: 'loop-dup-1' },
      );
    });
    await act(async () => {
      await until(
        () =>
          log.slice(beforeDup).filter((l) => l === 'GET /v1/wallet').length >=
          2,
      );
    });
    await quiet(log);
    assert.equal((outcome as { status: string } | null)?.status, 'duplicate');
    assert.deepEqual(
      log.slice(beforeDup).sort(),
      [
        'GET /v1/entitlements',
        'GET /v1/entitlements',
        'GET /v1/wallet',
        'GET /v1/wallet',
        'POST /checkout',
        'POST /checkout',
      ],
      'duplicate-as-success refetches the same mapped set',
    );
  } finally {
    await act(async () => root.unmount());
    store.close();
    await app.close();
  }
});

// The kind resolution order, isolated behind a stub wire: envelope meta.kind first, the
// sent draft's kind second, every watched read when neither names one, nothing on a "no".
test('core: submitRoute keys the refetch off envelope kind, then the draft, then all watched', async () => {
  let envelope: Record<string, unknown> = {};
  const gets: string[] = [];
  const stub: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if ((init?.method ?? 'GET') === 'GET') {
      gets.push(path);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: stub,
    pollMs: false,
  });
  const offs = [
    store.subscribe('wallet', () => {}),
    store.subscribe('subscriptions', () => {}),
  ];
  try {
    await quiet(gets); // the two initial reads
    gets.length = 0;

    envelope = {
      status: 'committed',
      transaction: { meta: { kind: 'adjust' } },
    };
    await store.submitRoute('/pay', { anything: true });
    await quiet(gets);
    assert.deepEqual(
      gets,
      ['/v1/wallet'],
      'envelope kind wins: adjust → wallet only',
    );

    gets.length = 0;
    envelope = { status: 'committed', transaction: { meta: {} } };
    await store.submitRoute('/pay', {
      kind: 'cancelSubscription',
      subscriptionId: 'sub_1',
    });
    await quiet(gets);
    assert.deepEqual(
      gets,
      ['/v1/subscriptions'],
      'empty meta falls back to the sent draft: cancelSubscription → subscriptions only',
    );

    gets.length = 0;
    envelope = { status: 'committed', transaction: { meta: {} } };
    await store.submitRoute('/pay', { sku: 'starter-pack' });
    await quiet(gets);
    assert.deepEqual(
      gets.sort(),
      ['/v1/subscriptions', '/v1/wallet'],
      'no kind anywhere: every watched read refreshes — a safe superset',
    );

    gets.length = 0;
    envelope = { status: 'rejected', reason: 'INSUFFICIENT_FUNDS', detail: {} };
    await store.submitRoute('/pay', { kind: 'spend' });
    await quiet(gets);
    assert.deepEqual(gets, [], 'a rejection refetches nothing');
  } finally {
    for (const off of offs) off();
    store.close();
  }
});

test('useSubmit refuses outside an <EconomyProvider>, and pending tracks the flight', async () => {
  const { renderToString } = await import('react-dom/server');
  function Naked() {
    useSubmit('/checkout');
    return null;
  }
  assert.throws(
    () => renderToString(<Naked />),
    /useSubmit\(\) needs an <EconomyProvider>/,
  );

  const { app, fetchLike } = await openApp(CHECKOUT_MODULE);
  await fund(app, 'pending-seed');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const gated: typeof fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === 'POST') await gate;
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 'dev_user_ada',
    fetch: gated,
    pollMs: false,
  });
  let door: ReturnType<typeof useSubmit> | null = null;
  function Door() {
    door = useSubmit('/checkout');
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
    assert.equal(door!.pending, false);
    let flight!: Promise<unknown>;
    await act(async () => {
      flight = door!.submit({ sku: 'starter-pack' });
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(
      door!.pending,
      true,
      'pending is true while the submit is in flight',
    );
    release();
    await act(async () => {
      await flight;
    });
    assert.equal(
      door!.pending,
      false,
      'pending clears when the envelope lands',
    );
  } finally {
    await act(async () => root.unmount());
    store.close();
    await app.close();
  }
});
