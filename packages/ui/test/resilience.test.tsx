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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EconomyHttpError } from '@pwngh/economy-client';
import { economyClient, MAX_WINDOW, READ_KEYS } from '../src/core.js';
import type { EconomyStore } from '../src/core.js';

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
 * A wire that answers every read with `{}` and every POST with the scripted envelope, logging
 * both. Nothing here waits on wall-clock: a test that needs a read held open gates it itself.
 */
function wire(): {
  fetchLike: typeof fetch;
  log: string[];
  answer: (body: unknown, status?: number) => void;
  fail: (why: Error | null) => void;
} {
  const log: string[] = [];
  let next: { body: unknown; status: number } = { body: {}, status: 200 };
  let broken: Error | null = null;
  const fetchLike: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    log.push(`${method} ${url.pathname}${url.search}`);
    if (broken) throw broken;
    if (method === 'GET') return json({});
    return json(next.body, next.status);
  };
  return {
    fetchLike,
    log,
    answer: (body, status = 200) => {
      next = { body, status };
    },
    fail: (why) => {
      broken = why;
    },
  };
}

/**
 * A sku-ordered entitlements list served the way `/v1` serves one: a page of `limit` rows past
 * `cursor`, and a cursor only when a further row exists. `rows` is mutable, so a test can take
 * rows away underneath a reader the way a revoke does.
 */
function listWire(rows: string[]): { fetchLike: typeof fetch; log: string[] } {
  const log: string[] = [];
  const fetchLike: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    log.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const after = url.searchParams.get('cursor');
    const past = after === null ? rows : rows.filter((sku) => sku > after);
    const items = past
      .slice(0, limit)
      .map((sku) => ({ sku, expiresAt: null, sources: [''] }));
    const cursor = past.length > items.length ? items.at(-1)!.sku : null;
    return json({ items, cursor });
  };
  return { fetchLike, log };
}

/**
 * A wallet wire whose balance a test can move between reads, so "the same answer twice" and
 * "the answer changed" are the same fixture read three times rather than two harnesses.
 */
function walletWire(): {
  fetchLike: typeof fetch;
  log: string[];
  move: (spendable: string) => void;
} {
  const log: string[] = [];
  let spendable = 'CREDIT:400.00';
  const fetchLike: typeof fetch = async (input) => {
    log.push(new URL(String(input)).pathname);
    return json({ spendable, pending: 'CREDIT:0.00' });
  };
  return {
    fetchLike,
    log,
    move: (next) => {
      spendable = next;
    },
  };
}

/**
 * Wraps a wire so a test can hold every read open and let them go on cue. A write is never
 * held: the point of holding is to look at the store while a read it started is still out.
 * Nothing waits on a clock — the release is the test's own call.
 */
function gate(inner: typeof fetch): {
  fetchLike: typeof fetch;
  hold: () => void;
  open: () => void;
} {
  let held: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const fetchLike: typeof fetch = async (input, init) => {
    if ((init?.method ?? 'GET') === 'GET' && held) await held;
    return inner(input, init);
  };
  return {
    fetchLike,
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open: () => {
      const resolve = release;
      held = null;
      release = null;
      resolve?.();
    },
  };
}

const skus = (store: EconomyStore): string[] =>
  (store.readPage('entitlements').data?.items ?? []).map(
    (row) => (row as { sku: string }).sku,
  );

const gets = (log: string[]): string[] =>
  log.filter((line) => line.startsWith('GET')).sort();

const committed = (kind: string) => ({
  status: 'committed',
  transaction: { meta: { kind } },
});

// --- 05#28: the poll cadence -----------------------------------------------------------

/**
 * Subscribes once and reports the poll the store installed: the delay it asked for, and what
 * one firing of it actually does. Nothing here waits on a clock — a real interval cannot be
 * counted without sleeping for it, and a fake one cannot be ticked past a zero delay at all,
 * because a zero-delay interval fires forever inside a single tick.
 */
async function pollOf(
  pollMs: number | false,
): Promise<{ initial: number; delay: number | null; readsPerFiring: number }> {
  const w = wire();
  const scheduled: { fn: () => void; delay: number }[] = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, delay: number) => {
    scheduled.push({ fn, delay });
    return { unref: () => undefined };
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() =>
    undefined) as typeof globalThis.clearInterval;
  let store: EconomyStore;
  try {
    store = economyClient({
      baseUrl: BASE,
      token: 't',
      fetch: w.fetchLike,
      pollMs,
    });
    store.subscribe('wallet', () => {});
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  try {
    await drain();
    const initial = w.log.length;
    if (scheduled.length === 0)
      return { initial, delay: null, readsPerFiring: 0 };
    assert.equal(scheduled.length, 1, 'one key installs one poll');
    scheduled[0]!.fn();
    await drain();
    return {
      initial,
      delay: scheduled[0]!.delay,
      readsPerFiring: w.log.length - initial,
    };
  } finally {
    store.close();
  }
}

// The positive control for every "no poll" row below: a cadence that IS installed is observed
// through the same lens, so a null delay is a timer that was never created and not a probe
// that stopped looking.
test('poll: a cadence installs one timer at that delay, and firing it reads once', async () => {
  const { initial, delay, readsPerFiring } = await pollOf(15_000);
  assert.equal(initial, 1, 'subscribing reads once');
  assert.equal(delay, 15_000, 'the poll waits the cadence it was given');
  assert.equal(readsPerFiring, 1, 'and one firing is one read');
});

test('poll: an explicit short cadence is honoured exactly', async () => {
  const { delay, readsPerFiring } = await pollOf(250);
  assert.equal(delay, 250);
  assert.equal(readsPerFiring, 1);
});

// A zero cadence is not a cadence. `setInterval(fn, 0)` runs at ~1ms, so reading `0` as "poll
// as fast as possible" turns the natural spelling of "off" into a stream of authenticated
// reads from every mounted component.
test('poll: pollMs 0 means off, not a read every millisecond', async () => {
  const { initial, delay } = await pollOf(0);
  assert.equal(initial, 1, 'the on-subscribe read still happens');
  assert.equal(delay, null, 'a zero cadence installs no timer at all');
});

test('poll: false still means off', async () => {
  assert.equal((await pollOf(false)).delay, null);
});

// Each of these reaches `setInterval` today, and each is clamped to 1ms there: they are the
// same defect as `0`, spelled differently.
test('poll: a negative, NaN, or infinite cadence is off, never a hot loop', async () => {
  for (const junk of [-1, -15_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal((await pollOf(junk)).delay, null, `pollMs ${junk} is off`);
  }
});

// A month does not fit a 32-bit timer, and Node answers an overflow by firing every
// millisecond — the slowest cadence a developer can ask for becomes the fastest there is.
test('poll: a cadence past the timer ceiling waits, it does not spin', async () => {
  const month = 30 * 24 * 3_600_000;
  const { delay, readsPerFiring } = await pollOf(month);
  assert.equal(
    delay,
    2_147_483_647,
    'it clamps to the longest wait a timer has',
  );
  assert.equal(readsPerFiring, 1, 'and it is still a poll when it fires');
});

// --- 05#29: recovery after a failed read -----------------------------------------------

test('recovery: a key that failed its first read is re-read by the next subscriber', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    w.fail(new Error('offline'));
    const off = store.subscribe('wallet', () => {});
    await drain();
    assert.match(String(store.read('wallet').error), /offline/);
    off();

    w.fail(null);
    w.log.length = 0;
    const again = store.subscribe('wallet', () => {});
    await drain();
    assert.deepEqual(
      w.log,
      ['GET /v1/wallet'],
      'an error is not a loaded state: the next mount reads again',
    );
    assert.deepEqual(store.read('wallet').data, {}, 'and the data lands');
    assert.equal(
      store.read('wallet').error,
      undefined,
      'a good read clears the error it recovered from',
    );
    again();
  } finally {
    store.close();
  }
});

test('recovery: a key that already holds data is not re-read on every mount', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    const off = store.subscribe('wallet', () => {});
    await drain();
    off();
    w.log.length = 0;
    const again = store.subscribe('wallet', () => {});
    await drain();
    assert.deepEqual(w.log, [], 'loaded data is not re-read by a remount');
    again();
  } finally {
    store.close();
  }
});

// --- 05#30: reads after close() --------------------------------------------------------

test('close: refresh() after close() touches the wire not at all', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  await store.refresh('wallet');
  assert.equal(w.log.length, 1);
  store.close();
  w.log.length = 0;
  await store.refresh('wallet');
  await store.refresh('entitlements');
  await drain();
  assert.deepEqual(
    w.log,
    [],
    'close() is teardown: a still-mounted component cannot spend the old token',
  );
});

// A refused read is still a read that will not happen, and `loadingMore` is set before the
// store knows one will. Nothing else clears it, so the flag outlives every reader.
test('close: a loadMore refused by close() leaves no spinner running', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => `sku-${i + 1}`);
  const { fetchLike } = listWire(rows);
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: fetchLike,
    pollMs: false,
    pageSize: 2,
  });
  await store.refresh('entitlements');
  assert.equal(store.readPage('entitlements').hasMore, true);
  const more = store.loadMore('entitlements');
  store.close();
  await more;
  await drain();
  assert.equal(
    store.readPage('entitlements').loadingMore,
    false,
    'the page that was never fetched does not leave the list loading forever',
  );
});

// --- 05#32: the problem document on a route failure ------------------------------------

test('submitRoute: a route failure throws the client error with its problem document', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    w.answer(
      { title: 'Insufficient balance', detail: 'needs 120, has 40' },
      400,
    );
    const thrown = await store.submitRoute('/checkout', { sku: 'kit' }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(
      EconomyHttpError.is(thrown),
      'the write path throws what the read path throws',
    );
    assert.equal((thrown as EconomyHttpError).status, 400);
    assert.match(
      (thrown as EconomyHttpError).body,
      /needs 120, has 40/,
      'the reason the host gave survives the throw',
    );
  } finally {
    store.close();
  }
});

// --- 05#34: a refresh and a paging read must not stand in for each other ----------------

test('coalesce: a refresh during a paging read re-reads the head instead of joining it', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => `sku-${i + 1}`);
  const { fetchLike, log } = listWire(rows);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let gating = false;
  const gated: typeof fetch = async (input, init) => {
    if (gating && String(input).includes('cursor=')) await gate;
    return fetchLike(input, init);
  };
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: gated,
    pollMs: false,
    pageSize: 2,
  });
  try {
    await store.refresh('entitlements');
    log.length = 0;
    gating = true;
    const more = store.loadMore('entitlements');
    await drain();
    const head = store.refresh('entitlements');
    assert.notEqual(
      more,
      head,
      'a refresh is not the paging read wearing a hat',
    );
    release();
    await Promise.all([more, head]);
    await drain();
    assert.equal(
      log.filter((l) => !l.includes('cursor=')).length,
      1,
      'the refresh really re-read the head; it did not silently resolve on the page',
    );
    assert.deepEqual(
      skus(store),
      ['sku-1', 'sku-2', 'sku-3', 'sku-4'],
      'and both reads landed: two pages held, nothing lost to the other flight',
    );
  } finally {
    store.close();
  }
});

test('coalesce: a refresh started in the gap does not swallow the page', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => `sku-${i + 1}`);
  const { fetchLike, log } = listWire(rows);
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: fetchLike,
    pollMs: false,
    pageSize: 2,
  });
  try {
    await store.refresh('entitlements');
    log.length = 0;
    // The window between `loadMore` scheduling its read and issuing it: a poll tick or a
    // user refresh lands here and used to take the page's place.
    const more = store.loadMore('entitlements');
    const head = store.refresh('entitlements');
    await Promise.all([more, head]);
    await drain();
    assert.equal(
      skus(store).length,
      4,
      'the "Load more" click fetched a page rather than resolving with nothing',
    );
    assert.equal(
      log.filter((l) => l.includes('cursor=')).length,
      1,
      'exactly one resuming read',
    );
    assert.equal(
      store.readPage('entitlements').loadingMore,
      false,
      'and the flight flag cleared',
    );
  } finally {
    store.close();
  }
});

test('coalesce: two identical reads still share one flight', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    const first = store.refresh('wallet');
    const second = store.refresh('wallet');
    assert.equal(first, second, 'same width, same resume point, one read');
    await Promise.all([first, second]);
    assert.deepEqual(w.log, ['GET /v1/wallet']);
  } finally {
    store.close();
  }
});

// --- 05#35: the tail splice past the read ceiling ---------------------------------------

// Past `MAX_WINDOW` held rows a refresh can only re-read the first 200, so the rows below are
// spliced back on by position. Take rows away at the head and those positions no longer line
// up: the re-read head now contains rows the held tail is about to re-append.
test('merge: a refresh past the read ceiling never lands a row twice', async () => {
  const rows = Array.from(
    { length: 300 },
    (_, i) => `sku-${String(i + 1).padStart(3, '0')}`,
  );
  const { fetchLike } = listWire(rows);
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: fetchLike,
    pollMs: false,
    pageSize: 100,
  });
  try {
    await store.refresh('entitlements');
    await store.loadMore('entitlements');
    await store.loadMore('entitlements');
    assert.equal(skus(store).length, 300, 'three pages held');
    assert.ok(300 > MAX_WINDOW, 'and more than one read can ever re-read');

    rows.splice(0, 50);
    await store.refresh('entitlements');
    const held = skus(store);
    assert.equal(
      new Set(held).size,
      held.length,
      'the tail the refresh could not reach was not re-appended on top of itself',
    );
    assert.deepEqual(held, [...held].sort(), 'and the list is still in order');
    assert.ok(
      held.includes('sku-300'),
      'the rows past the ceiling are still loaded, never dropped',
    );
    assert.ok(
      !held.includes('sku-001'),
      'and the rows that went away are gone',
    );
  } finally {
    store.close();
  }
});

// --- 05#36: what a write invalidates ----------------------------------------------------

test('invalidate: a purchase refetches the balance a caller read without subscribing', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    await store.refresh('wallet');
    w.log.length = 0;
    w.answer(committed('spend'));
    await store.submitRoute('/checkout', { sku: 'kit' });
    await drain();
    assert.deepEqual(
      w.log.filter((l) => l.startsWith('GET')),
      ['GET /v1/wallet'],
      'the balance this caller read refetches, with no hook watching it',
    );
  } finally {
    store.close();
  }
});

test('invalidate: a key nobody has read is not fetched by a write', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    await store.refresh('wallet');
    w.log.length = 0;
    w.answer(committed('subscribe'));
    await store.submitRoute('/join', { sku: 'club' });
    await drain();
    assert.deepEqual(
      w.log.filter((l) => l.startsWith('GET')),
      ['GET /v1/wallet'],
      'subscribe maps to three reads, and only the one that was ever read is refetched',
    );
  } finally {
    store.close();
  }
});

// --- 05#37: what the write door promises a caller ---------------------------------------

test('submit: a rejected outcome resolves, and a route failure rejects', async () => {
  const w = wire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    w.answer({ status: 'rejected', reason: { code: 'INSUFFICIENT_FUNDS' } });
    const no = await store.submitRoute('/checkout', {});
    assert.equal(
      (no as { status: string }).status,
      'rejected',
      'a "no" is data: the envelope resolves with its reason union intact',
    );
    w.answer({ boom: true }, 503);
    await assert.rejects(
      store.submitRoute('/checkout', {}),
      EconomyHttpError.is,
      'a transport failure is not an outcome and is never dressed up as one',
    );
  } finally {
    store.close();
  }
});

test('README: the write door states which half rejects and which half resolves', async () => {
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(
    md.includes('EconomyHttpError'),
    'the README names the error a failed route POST throws',
  );
  assert.match(
    md,
    /await or catch/,
    'and says a caller who does not await must catch',
  );
});

test('README: the poll cadence rule is stated where pollMs is', async () => {
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(md.includes('pollMs'), 'the README names the option');
  assert.ok(
    md.includes('Polling needs a positive finite cadence'),
    'and states the rule rather than only the default',
  );
  assert.match(
    md,
    // The rule sentence wraps, so the span crosses a newline; 80 characters is the whole
    // list of spellings and nothing further.
    /`0`[\s\S]{0,80}mean off/,
    'and names zero among the spellings of off',
  );
});

// --- 05#27: joining the base to a host route path ---------------------------------------

/** The page a browser sits on while the store posts, so a relative URL has a base to resolve on. */
const PAGE = 'https://storefront.test/shop';

/**
 * Records the URL exactly as it reached `fetch`, unparsed. `new URL('//checkout')` throws in
 * Node, which is why a suite that only ever passed a slash-free base never saw this one.
 */
function posted(): {
  fetchLike: typeof fetch;
  urls: string[];
  bearers: string[];
} {
  const urls: string[] = [];
  const bearers: string[] = [];
  const fetchLike: typeof fetch = async (input, init) => {
    urls.push(String(input));
    bearers.push(new Headers(init?.headers).get('authorization') ?? '');
    return json(committed('spend'));
  };
  return { fetchLike, urls, bearers };
}

/**
 * Every base a caller can write, against the path the README documents and the same path
 * without its leading slash. `origin` is where a browser sends the request once it resolves the
 * URL against the page — which is to say, the host that receives the bearer. `read` is where the
 * same base sends a wallet read, so the two paths are held to the same answer.
 */
const JOINS: readonly {
  base: string;
  path: string;
  url: string;
  origin: string;
  read: string;
}[] = [
  {
    base: 'https://x.test',
    path: '/checkout',
    url: 'https://x.test/checkout',
    origin: 'https://x.test',
    read: 'https://x.test/v1/wallet',
  },
  {
    base: 'https://x.test/',
    path: '/checkout',
    url: 'https://x.test/checkout',
    origin: 'https://x.test',
    read: 'https://x.test/v1/wallet',
  },
  {
    base: 'https://x.test/api',
    path: '/checkout',
    url: 'https://x.test/api/checkout',
    origin: 'https://x.test',
    read: 'https://x.test/api/v1/wallet',
  },
  {
    base: 'https://x.test/api/',
    path: '/checkout',
    url: 'https://x.test/api/checkout',
    origin: 'https://x.test',
    read: 'https://x.test/api/v1/wallet',
  },
  {
    base: '/',
    path: '/checkout',
    url: '/checkout',
    origin: 'https://storefront.test',
    read: '/v1/wallet',
  },
  {
    base: '',
    path: '/checkout',
    url: '/checkout',
    origin: 'https://storefront.test',
    read: '/v1/wallet',
  },
  {
    base: '/api',
    path: '/checkout',
    url: '/api/checkout',
    origin: 'https://storefront.test',
    read: '/api/v1/wallet',
  },
  {
    base: '/api/',
    path: '/checkout',
    url: '/api/checkout',
    origin: 'https://storefront.test',
    read: '/api/v1/wallet',
  },
  {
    base: 'https://x.test',
    path: 'checkout',
    url: 'https://x.test/checkout',
    origin: 'https://x.test',
    read: 'https://x.test/v1/wallet',
  },
];

test('join: every base a caller can write reaches the origin they chose', async () => {
  for (const row of JOINS) {
    const wire = posted();
    const store = economyClient({
      baseUrl: row.base,
      token: 'tok',
      fetch: wire.fetchLike,
      pollMs: false,
    });
    try {
      await store.submitRoute(row.path, { sku: 'kit' });
      // The read leg through the same base: the wire client has always stripped a trailing
      // slash of its own, and this is what says so rather than assuming it.
      await store.refresh('wallet');
    } finally {
      store.close();
    }
    assert.deepEqual(
      wire.urls,
      [row.url, row.read],
      `baseUrl '${row.base}' with '${row.path}' writes and reads at exactly these two URLs`,
    );
    for (const sent of wire.urls) {
      assert.equal(
        new URL(sent, PAGE).origin,
        row.origin,
        'and a browser resolving it lands on the origin the caller named',
      );
    }
    assert.deepEqual(
      wire.bearers,
      ['Bearer tok', 'Bearer tok'],
      'the bearer rode with both',
    );
  }
  assert.equal(
    JOINS.length,
    9,
    'nine base-and-path combinations, written and read',
  );
  assert.equal(
    new Set(JOINS.map((row) => row.base)).size,
    8,
    'eight distinct bases, where every earlier test in this package passed the same one',
  );
  assert.equal(new Set(JOINS.map((row) => row.path)).size, 2);
  assert.equal(
    new Set(JOINS.map((row) => row.url)).size +
      new Set(JOINS.map((row) => row.read)).size,
    8,
    'four distinct write URLs and four read URLs across those bases',
  );
});

// The positive control for the row above: the concatenation this replaced, resolved through the
// same lens. `//checkout` is protocol-relative — a browser reads `checkout` as the HOST — so the
// lens has to be able to tell that apart from a path on the caller's own origin.
test('join: the concatenation this replaced sent the bearer to another origin', () => {
  const leaked = `${'/'}${'/checkout'}`;
  assert.equal(
    leaked,
    '//checkout',
    'the documented base and path, concatenated',
  );
  assert.equal(
    new URL(leaked, PAGE).origin,
    'https://checkout',
    'a browser resolves it to a host nobody configured',
  );
  assert.notEqual(new URL(leaked, PAGE).origin, new URL(PAGE).origin);
});

test('join: the base and write path the README documents stay on the page origin', async () => {
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  // The fenced blocks only: these are the lines a reader copies, and prose that names the
  // option cannot drift the counts below.
  const code = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .join('\n');
  const bases = [...code.matchAll(/baseUrl: '([^']*)'/g)].map((m) => m[1]!);
  const paths = [...code.matchAll(/useSubmit\('([^']*)'\)/g)].map((m) => m[1]!);
  assert.equal(bases.length, 5, 'five economyClient examples carry a baseUrl');
  assert.equal(paths.length, 1, 'and one of them names the write door path');
  let examined = 0;
  for (const base of bases) {
    for (const path of paths) {
      const wire = posted();
      const store = economyClient({
        baseUrl: base,
        token: 'tok',
        fetch: wire.fetchLike,
        pollMs: false,
      });
      try {
        await store.submitRoute(path, {});
      } finally {
        store.close();
      }
      assert.equal(
        new URL(wire.urls[0]!, PAGE).origin,
        new URL(PAGE).origin,
        `the documented baseUrl '${base}' with '${path}' must stay on the storefront's own origin`,
      );
      examined += 1;
    }
  }
  assert.equal(
    examined,
    5,
    'every documented base posted through the write door',
  );
});

// --- Q124: what a landed read tells the consumers ---------------------------------------

test('snapshot: two reads of the same rows are one notification, and a new row is news', async () => {
  const rows = ['pass-1', 'pass-2'];
  const { fetchLike, log } = listWire(rows);
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: fetchLike,
    pollMs: false,
  });
  try {
    let heard = 0;
    const off = store.subscribe('entitlements', () => {
      heard += 1;
    });
    await drain();
    assert.equal(log.length, 1, 'the subscriber read once');
    assert.equal(heard, 1, 'and the first landing is news');
    const first = store.readPage('entitlements');

    await store.refresh('entitlements');
    await store.refresh('entitlements');
    assert.equal(log.length, 3, 'three reads examined, and all three landed');
    assert.equal(heard, 1, 'the two that changed nothing told nobody');
    assert.equal(
      store.readPage('entitlements'),
      first,
      'the snapshot kept its identity, which is the Object.is comparison useSyncExternalStore makes',
    );

    // The control. Without a read that really changes something, "an unchanged read is
    // silent" is satisfied by a store that never notifies at all.
    rows.push('pass-3');
    await store.refresh('entitlements');
    assert.equal(log.length, 4, 'a fourth read');
    assert.equal(heard, 2, 'and a row that appeared reaches every consumer');
    assert.deepEqual(skus(store), ['pass-1', 'pass-2', 'pass-3']);
    off();
  } finally {
    store.close();
  }
});

test('snapshot: the same balance twice is one notification, and a moved balance is two', async () => {
  const w = walletWire();
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: w.fetchLike,
    pollMs: false,
  });
  try {
    let heard = 0;
    const off = store.subscribe('wallet', () => {
      heard += 1;
    });
    await drain();
    const first = store.read('wallet');
    assert.deepEqual(first.data, {
      spendable: 'CREDIT:400.00',
      pending: 'CREDIT:0.00',
    });

    await store.refresh('wallet');
    await store.refresh('wallet');
    assert.equal(w.log.length, 3, 'three reads examined');
    assert.equal(heard, 1, 'a balance that did not move is not news');
    assert.equal(store.read('wallet'), first, 'and the snapshot is one object');

    // The control, on the read that has no list and no paging behind it.
    w.move('CREDIT:280.00');
    await store.refresh('wallet');
    assert.equal(w.log.length, 4, 'a fourth read');
    assert.equal(heard, 2, 'a purchase moved it, so every consumer hears');
    assert.equal(
      (store.read('wallet').data as { spendable: string }).spendable,
      'CREDIT:280.00',
    );
    off();
  } finally {
    store.close();
  }
});

// --- Q129: the reads a write schedules, awaited -------------------------------------------

test('settled: a write resolves on its own answer, and settled() waits out the reads it scheduled', async () => {
  const w = wire();
  const held = gate(w.fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: held.fetchLike,
    pollMs: false,
  });
  try {
    await store.refresh('wallet');
    await store.refresh('entitlements');
    w.log.length = 0;
    w.answer(committed('spend'));
    held.hold();

    const outcome = await store.submitRoute('/checkout', { sku: 'world-kit' });
    assert.equal(
      (outcome as { status: string }).status,
      'committed',
      'the write is decided the moment the route answers',
    );
    assert.deepEqual(
      gets(w.log),
      [],
      'and it did not wait on the reads it went stale — a buy button is not held open by a refetch',
    );

    let done = false;
    const waiting = store.settled().then(() => {
      done = true;
    });
    await drain();
    assert.equal(
      done,
      false,
      'the refetches are still out, so settled() is still waiting',
    );

    held.open();
    await waiting;
    assert.equal(done, true);
    assert.deepEqual(
      gets(w.log),
      ['GET /v1/entitlements?limit=50', 'GET /v1/wallet'],
      'settled() resolves once every read a spend maps to has landed',
    );
  } finally {
    store.close();
  }
});

test('settled: it answers for a read nobody kept a handle to', async () => {
  const w = walletWire();
  const held = gate(w.fetchLike);
  const store = economyClient({
    baseUrl: BASE,
    token: 't',
    fetch: held.fetchLike,
    pollMs: false,
  });
  try {
    held.hold();
    // `subscribe` reads an unread key and voids the promise, so this is the read a caller has
    // no handle to at all — the same shape as a poll tick and as a write's refetch.
    const off = store.subscribe('wallet', () => {});
    let done = false;
    const waiting = store.settled().then(() => {
      done = true;
    });
    await drain();
    assert.equal(done, false, 'the read is out, so the store is not settled');
    assert.equal(w.log.length, 0, 'and it has not reached the wire yet');

    held.open();
    await waiting;
    assert.equal(w.log.length, 1, 'one read examined');
    assert.equal(
      (store.read('wallet').data as { spendable: string }).spendable,
      'CREDIT:400.00',
      'and it had landed in the snapshot before settled() resolved',
    );
    off();
  } finally {
    store.close();
  }
});

test('README: the two things a landed read can do are both written down', async () => {
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const claims = [
    // What a poll costs a mounted component, which is the reason the snapshot is kept.
    'The snapshot keeps its identity',
    // That a write does not wait, and what a caller awaits when it needs the reads.
    'submit` resolves on the route',
    'settled()',
  ];
  const missing = claims.filter((claim) => !md.includes(claim));
  assert.deepEqual(missing, [], 'the README states each of these');
  assert.equal(claims.length, 3, 'three claims checked');
});

// --- the roster this file answers for ---------------------------------------------------

// Every door the store hands out, and the behaviour here that drives it. A new door fails
// this until it is either driven or admitted with the reason it is not.
const DRIVEN: Readonly<Record<string, string>> = {
  client:
    'admitted: the escape hatch to the lab client, covered by surface.test.tsx',
  read: 'the recovery and close rows read the wallet snapshot',
  readPage: 'the merge and coalesce rows read the entitlements window',
  subscribe: 'the poll rows and the recovery rows',
  refresh: 'the close row, both coalesce rows, and the merge row',
  loadMore: 'both coalesce rows and the merge row',
  submit: 'admitted: the wire write door, covered by economy-react.test.tsx',
  submitRoute:
    'the problem-document row, both invalidate rows, and the submit row',
  settled: 'both settled rows, where a held read proves it really waits',
  resume: 'admitted: the park and re-read door, covered by session.test.tsx',
  close: 'the close row, and the teardown of every store built here',
};

test('coverage: every store door and every read key is answered for here', async () => {
  const store = economyClient({ baseUrl: BASE, pollMs: false });
  try {
    assert.deepEqual(
      Object.keys(store).sort(),
      Object.keys(DRIVEN).sort(),
      'the roster resolves against the store, so a new door lands here first',
    );
    assert.equal(Object.keys(DRIVEN).length, 11, 'eleven doors');
    assert.deepEqual(
      [...READ_KEYS],
      ['wallet', 'entitlements', 'subscriptions', 'payouts'],
      'four read keys',
    );
    const hooks = await import('../src/lib/react.js');
    for (const key of READ_KEYS) {
      const hook = `use${key[0]!.toUpperCase()}${key.slice(1)}`;
      assert.ok(hook in hooks, `${hook} is a shipped hook`);
    }
    assert.ok('useSubmit' in hooks, 'and the write door hook');
  } finally {
    store.close();
  }
});
