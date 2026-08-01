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
import { economyClient } from '../src/core.js';
import type { EconomyStoreOptions } from '../src/core.js';

const BASE = 'http://storefront.test';

// Records one entry per request: the authorization header, then the trace header.
function recording(): {
  auth: string[];
  trace: string[];
  fetch: typeof fetch;
} {
  const auth: string[] = [];
  const trace: string[] = [];
  const stub: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    auth.push(headers.get('authorization') ?? '');
    trace.push(headers.get('x-trace') ?? '');
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { auth, trace, fetch: stub };
}

function store(options: Partial<EconomyStoreOptions>, fetchLike: typeof fetch) {
  return economyClient({
    baseUrl: BASE,
    fetch: fetchLike,
    pollMs: false,
    ...options,
  });
}

test('token: a TokenSource is called per request, never stringified into the header', async () => {
  const seen = recording();
  const client = store({ token: () => 'tok' }, seen.fetch);

  await client.refresh('wallet');
  await client.refresh('entitlements');
  client.close();

  assert.deepEqual(seen.auth, ['Bearer tok', 'Bearer tok']);
});

test('token: a rotating source sends the bearer of the moment, not the one at construction', async () => {
  const seen = recording();
  const minted: string[] = ['tok_1', 'tok_2', 'tok_3'];
  const client = store({ token: () => minted.shift() ?? 'spent' }, seen.fetch);

  await client.refresh('wallet');
  await client.refresh('wallet');
  await client.refresh('wallet');
  client.close();

  assert.deepEqual(seen.auth, ['Bearer tok_1', 'Bearer tok_2', 'Bearer tok_3']);
});

test('token: an async source is awaited before the request goes out', async () => {
  const seen = recording();
  const client = store(
    { token: async () => Promise.resolve('tok_async') },
    seen.fetch,
  );

  await client.refresh('wallet');
  client.close();

  assert.deepEqual(seen.auth, ['Bearer tok_async']);
});

test('token: a fixed string bearer still goes out on every request', async () => {
  const seen = recording();
  const client = store({ token: 'tok_fixed' }, seen.fetch);

  await client.refresh('wallet');
  await client.refresh('payouts');
  client.close();

  assert.deepEqual(seen.auth, ['Bearer tok_fixed', 'Bearer tok_fixed']);
});

test('token: headers ride every request alongside the bearer', async () => {
  const seen = recording();
  const client = store(
    { token: 'tok', headers: { 'x-trace': 'trace_1' } },
    seen.fetch,
  );

  await client.refresh('wallet');
  await client.submitRoute('/checkout', { sku: 'sku_1' });
  await new Promise((r) => setImmediate(r));
  client.close();

  // Three: the read, the write, and the write's invalidation re-reading the balance this
  // caller holds. The refetch carries the credentials exactly as the other two do.
  assert.deepEqual(seen.auth, ['Bearer tok', 'Bearer tok', 'Bearer tok']);
  assert.deepEqual(seen.trace, ['trace_1', 'trace_1', 'trace_1']);
});
