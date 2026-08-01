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
import { EconomyHttpError } from '@pwngh/economy-client';
import { economyClient, READ_KEYS } from '../src/core.js';
import type { EconomyStore, ReadKey } from '../src/core.js';
import { EconomyProvider, useEconomyStore } from '../src/lib/react.js';

const BASE = 'http://economy.test';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Lets every settled read run its continuations. Bounded turns, never a wall-clock wait. */
const drain = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * A wire whose answer a test moves between requests: 200 while the session is good, 401 once
 * the token dies, and back again after the host mints a new one. Every request is logged, so
 * "no read happened" is counted rather than waited for.
 */
function session(): {
  fetchLike: typeof fetch;
  log: string[];
  expire: () => void;
  reissue: () => void;
  answerWrite: (body: unknown, status: number) => void;
} {
  const log: string[] = [];
  let live = true;
  let write: { body: unknown; status: number } = {
    body: { status: 'committed' },
    status: 200,
  };
  const fetchLike: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    log.push(`${method} ${url.pathname}`);
    if (!live) return json({ title: 'Request is not authenticated.' }, 401);
    if (method !== 'GET') return json(write.body, write.status);
    return json({ spendable: 'CREDIT:400.00', items: [], cursor: null });
  };
  return {
    fetchLike,
    log,
    expire: () => {
      live = false;
    },
    reissue: () => {
      live = true;
    },
    answerWrite: (body, status) => {
      write = { body, status };
    },
  };
}

/** Every `setInterval` the store installs, captured rather than run: a poll is fired on cue
 *  and counted, and a cadence that was never installed reads as an empty list. */
function withCapturedTimers<T>(run: () => T): {
  value: T;
  timers: (() => void)[];
} {
  const timers: (() => void)[] = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => {
    timers.push(fn);
    return { unref: () => undefined };
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() =>
    undefined) as typeof globalThis.clearInterval;
  try {
    return { value: run(), timers };
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

/** A store with all four keys subscribed, which is the storefront shape a park has to survive. */
async function subscribed(
  options: Partial<Parameters<typeof economyClient>[0]> & {
    readonly fetch: typeof fetch;
  },
): Promise<{ store: EconomyStore; stop: () => void }> {
  const store = economyClient({ baseUrl: BASE, token: 'tok', ...options });
  const offs = READ_KEYS.map((key) => store.subscribe(key, () => {}));
  await drain();
  return {
    store,
    stop: () => {
      for (const off of offs) off();
      store.close();
    },
  };
}

test('session: a 401 on a read fires onUnauthorized exactly once, for all four keys', async () => {
  const w = session();
  const seen: EconomyHttpError[] = [];
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
    onUnauthorized: (error) => seen.push(error),
  });
  try {
    w.expire();
    await Promise.all(READ_KEYS.map((key) => store.refresh(key)));
    await drain();
    assert.equal(seen.length, 1, 'one park is one call, not one per key');
    assert.equal(seen[0]!.status, 401, 'the call carries the refusal it saw');
    assert.ok(
      EconomyHttpError.is(seen[0]),
      'and it is the http error, not a rewrapped one',
    );
  } finally {
    stop();
  }
});

test('session: a parked store starts no further read, on a poll tick or on demand', async () => {
  const w = session();
  const { value, timers } = withCapturedTimers(() =>
    economyClient({
      baseUrl: BASE,
      token: 'tok',
      fetch: w.fetchLike,
      pollMs: 15_000,
      onUnauthorized: () => {},
    }),
  );
  const store = value;
  const off = store.subscribe('wallet', () => {});
  try {
    await drain();
    w.expire();
    await store.refresh('wallet');
    await drain();
    const parkedAt = w.log.length;
    for (const fire of timers) fire();
    await store.refresh('wallet');
    await store.loadMore('entitlements');
    await drain();
    assert.equal(
      w.log.length - parkedAt,
      0,
      `a parked store issued ${w.log.length - parkedAt} requests it had no credential for`,
    );
  } finally {
    off();
    store.close();
  }
});

test('session: parking keeps every loaded page, and resume() re-reads each subscribed key once', async () => {
  const w = session();
  const seen: unknown[] = [];
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
    onUnauthorized: (error) => seen.push(error),
  });
  try {
    const loaded = store.read('wallet').data;
    assert.deepEqual(
      loaded,
      { spendable: 'CREDIT:400.00', items: [], cursor: null },
      'the store loaded before the token died',
    );
    w.expire();
    await store.refresh('wallet');
    await drain();
    assert.deepEqual(
      store.read('wallet').data,
      loaded,
      'the park kept what was loaded — the store outlives the token',
    );
    assert.ok(store.read('wallet').error, 'and the refusal rides beside it');

    w.reissue();
    const resumedAt = w.log.length;
    store.resume();
    await store.settled();
    await drain();
    assert.deepEqual(
      w.log.slice(resumedAt).sort(),
      [
        'GET /v1/entitlements',
        'GET /v1/payouts',
        'GET /v1/subscriptions',
        'GET /v1/wallet',
      ],
      'resume() re-reads each subscribed key exactly once',
    );
    assert.equal(
      store.read('wallet').error,
      undefined,
      'and a key that read cleanly no longer carries the refusal',
    );
    assert.equal(
      seen.length,
      1,
      'one park, one call, across the whole sequence',
    );
  } finally {
    stop();
  }
});

test('session: resume() restarts the poll it stopped', async () => {
  const w = session();
  const { value, timers } = withCapturedTimers(() =>
    economyClient({
      baseUrl: BASE,
      token: 'tok',
      fetch: w.fetchLike,
      pollMs: 15_000,
      onUnauthorized: () => {},
    }),
  );
  const store = value;
  const off = store.subscribe('wallet', () => {});
  try {
    await drain();
    w.expire();
    await store.refresh('wallet');
    await drain();
    w.reissue();
    const installed = timers.length;
    withCapturedTimersInto(timers, () => store.resume());
    await drain();
    assert.ok(
      timers.length > installed,
      'resume() installed a poll again, so a recovered session polls again',
    );
    const before = w.log.length;
    timers.at(-1)!();
    await drain();
    assert.equal(w.log.length - before, 1, 'and firing it reads once');
  } finally {
    off();
    store.close();
  }
});

/** The same capture, aimed at an existing list, for a call made after the store was built. */
function withCapturedTimersInto(timers: (() => void)[], run: () => void): void {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => {
    timers.push(fn);
    return { unref: () => undefined };
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() =>
    undefined) as typeof globalThis.clearInterval;
  try {
    run();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

test('session: a resume that is refused parks again, and asks again', async () => {
  const w = session();
  const seen: unknown[] = [];
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
    onUnauthorized: (error) => seen.push(error),
  });
  try {
    w.expire();
    await store.refresh('wallet');
    await drain();
    assert.equal(seen.length, 1, 'the first park asked once');
    // The host thought it had a new bearer and did not: resume, refused, parked again. One
    // question per death of the session is the rule, and this is a second death.
    store.resume();
    await store.settled();
    await drain();
    assert.equal(seen.length, 2, 'a park after a resume is a second question');
    const parkedAt = w.log.length;
    await store.refresh('wallet');
    await drain();
    assert.equal(w.log.length - parkedAt, 0, 'and the store parked again');
  } finally {
    stop();
  }
});

test('session: a 401 on a write parks the store the same way a read does', async () => {
  const w = session();
  const seen: EconomyHttpError[] = [];
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
    onUnauthorized: (error) => seen.push(error),
  });
  try {
    w.answerWrite({ title: 'Request is not authenticated.' }, 401);
    await assert.rejects(
      () => store.submitRoute('/checkout', { sku: 'sku_hat' }),
      (error: unknown) => EconomyHttpError.is(error) && error.status === 401,
    );
    await drain();
    assert.equal(seen.length, 1, 'the write path reaches the same park');
    const parkedAt = w.log.length;
    await store.refresh('wallet');
    await drain();
    assert.equal(w.log.length - parkedAt, 0, 'and the reads stopped with it');
  } finally {
    stop();
  }
});

// The positive controls. Without these, "unauthorized is handled" is satisfied by a store that
// parks on everything and never reads at all.
test('session: an authorized store never parks and never fires onUnauthorized', async () => {
  const w = session();
  const seen: unknown[] = [];
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
    onUnauthorized: (error) => seen.push(error),
  });
  try {
    const before = w.log.length;
    await Promise.all(READ_KEYS.map((key) => store.refresh(key)));
    await drain();
    assert.equal(w.log.length - before, 4, 'four keys, four reads, no park');
    assert.equal(seen.length, 0, 'and nothing to re-authenticate');
    assert.ok(store.read('wallet').data, 'the data arrived');
  } finally {
    stop();
  }
});

test('session: a 500 is not a park — a cold backend still recovers on its own', async () => {
  const log: string[] = [];
  let status = 200;
  const fetchLike: typeof fetch = async (input) => {
    log.push(new URL(String(input)).pathname);
    return status === 200
      ? json({ spendable: 'CREDIT:400.00', items: [], cursor: null })
      : json({ title: 'unavailable' }, status);
  };
  const seen: unknown[] = [];
  const { store, stop } = await subscribed({
    fetch: fetchLike,
    pollMs: false,
    onUnauthorized: (error) => seen.push(error),
  });
  try {
    status = 503;
    await store.refresh('wallet');
    await drain();
    assert.equal(seen.length, 0, 'a 503 is not an authentication failure');
    const before = log.length;
    await store.refresh('wallet');
    await drain();
    assert.equal(log.length - before, 1, 'and the store keeps reading');
  } finally {
    stop();
  }
});

test('session: onUnauthorized is optional, and a store without one still parks', async () => {
  const w = session();
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    w.expire();
    await store.refresh('wallet');
    await drain();
    const parkedAt = w.log.length;
    await store.refresh('wallet');
    await drain();
    assert.equal(
      w.log.length - parkedAt,
      0,
      'parking is the store’s behaviour, not the callback’s',
    );
  } finally {
    stop();
  }
});

// Q191: the store the provider already holds, reachable from inside a component. Without it a
// re-auth button has to be handed the store a second time by the host.
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

test('session: a component reaches the store through useEconomyStore, and resumes with it', async () => {
  const w = session();
  const { store, stop } = await subscribed({
    fetch: w.fetchLike,
    pollMs: false,
    onUnauthorized: () => {},
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  function ReAuth() {
    const reached = useEconomyStore();
    return (
      <button type="button" onClick={() => reached.resume()}>
        {reached === store ? 'same store' : 'a different store'}
      </button>
    );
  }
  try {
    w.expire();
    await store.refresh('wallet');
    await drain();
    await act(async () => {
      root.render(
        <EconomyProvider client={store}>
          <ReAuth />
        </EconomyProvider>,
      );
    });
    assert.equal(
      host.textContent,
      'same store',
      'the hook hands back the store the provider was given',
    );
    w.reissue();
    const resumedAt = w.log.length;
    await act(async () => {
      host
        .querySelector('button')!
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await store.settled();
    await drain();
    assert.equal(
      w.log.length - resumedAt,
      READ_KEYS.length,
      'the click resumed every subscribed key',
    );
  } finally {
    await act(async () => root.unmount());
    stop();
  }
});

test('session: useEconomyStore refuses outside a provider, naming itself', async () => {
  const { renderToString } = await import('react-dom/server');
  function Orphan() {
    useEconomyStore();
    return null;
  }
  assert.throws(
    () => renderToString(<Orphan />),
    (error: unknown) =>
      String(error).includes('useEconomyStore() needs an <EconomyProvider>'),
    'the refusal names the hook the caller wrote',
  );
});

test('session: the park is proven over every read key the store ships', () => {
  assert.deepEqual(
    [...READ_KEYS] as ReadKey[],
    ['wallet', 'entitlements', 'subscriptions', 'payouts'],
    'four keys, and the rows above drive all four',
  );
});
