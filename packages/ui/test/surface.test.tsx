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
import { newIdempotencyKey } from '@pwngh/economy-client';
import { economyClient } from '../src/core.js';

// This file imports the package the way an application does — through the published
// specifiers, never a deep `../src/` path — so a symbol that is written, documented, and
// README'd but exported from nowhere fails here instead of shipping unreachable.
const EXPECTED_ROOT = [
  'EconomyProvider',
  'LIST_KEYS',
  'MAX_WINDOW',
  'READ_KEYS',
  'economyClient',
  'useEconomyStore',
  'useEntitlements',
  'usePayouts',
  'useSubmit',
  'useSubscriptions',
  'useWallet',
].sort();

// `./core` is the same store without the React import, so nothing from the React face rides it.
const EXPECTED_CORE = [
  'LIST_KEYS',
  'MAX_WINDOW',
  'READ_KEYS',
  'economyClient',
].sort();

// The specifiers resolve into dist/, so an absent build reads as a missing export. Say which.
const door = async (spec: string): Promise<Record<string, unknown>> => {
  try {
    return (await import(spec)) as Record<string, unknown>;
  } catch (error) {
    return assert.fail(
      `${spec} does not resolve — run \`npm run build\` first (${String(error)})`,
    );
  }
};

test('surface: the root specifier exports exactly the shipped list', async () => {
  const ui = await door('@pwngh/economy-ui');
  assert.deepEqual(
    Object.keys(ui).sort(),
    EXPECTED_ROOT,
    'growing the surface is deliberate — export it, then edit this pin in the same change',
  );
});

test('surface: ./core ships the store, and the React face never rides it', async () => {
  const core = await door('@pwngh/economy-ui/core');
  assert.deepEqual(Object.keys(core).sort(), EXPECTED_CORE);
  for (const hook of [
    'useWallet',
    'useEntitlements',
    'useSubmit',
    'EconomyProvider',
  ]) {
    assert.ok(!(hook in core), `${hook} would drag React into the core door`);
  }
});

// The audit bug this closes: a hook reachable through no public import path at all.
test('surface: every hook the package defines is reachable through the public door', async () => {
  const bindings = (await import('../src/lib/react.js')) as Record<
    string,
    unknown
  >;
  const ui = await door('@pwngh/economy-ui');
  const hooks = Object.keys(bindings).filter((name) => name.startsWith('use'));
  assert.equal(
    hooks.length,
    6,
    `expected the four reads, the write door and the store door, found ${hooks.length}`,
  );
  for (const hook of hooks) {
    assert.ok(
      hook in ui,
      `${hook} is defined but not exported from '@pwngh/economy-ui'`,
    );
  }
});

// A stale dist would pin yesterday's surface and call it green.
test('surface: the built door matches the source it was built from', async () => {
  const src = (await import('../src/index.js')) as Record<string, unknown>;
  const ui = await door('@pwngh/economy-ui');
  assert.deepEqual(
    Object.keys(ui).sort(),
    Object.keys(src).sort(),
    'dist is stale against src/index.ts — run `npm run build`',
  );
});

// Every expression in the package that can put an idempotency key on the wire.
const mints = (source: string): string[] =>
  [...source.matchAll(/'idempotency-key':\s*([^,\n]+)/g)].map((m) =>
    m[1]!.trim(),
  );

/** The one minting expression, whole: the caller's key when there is one, else the helper's. */
const EXPECTED_MINT = 'idempotencyKey ?? newIdempotencyKey()';

// The key format belongs to @pwngh/economy-client, and what a comparison of key *shapes* cannot
// tell apart is the thing worth catching: a bare `crypto.randomUUID()` here has the same length,
// the same dash positions and the same hex alphabet, so it passed while the package quietly
// owned a second answer to a question it does not decide. Resolve the expression instead.
test('surface: submitRoute mints its default key with the client package helper, never its own', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
    (name) => name.endsWith('.ts') || name.endsWith('.tsx'),
  );
  const found: { file: string; expression: string }[] = [];
  for (const file of files) {
    for (const expression of mints(readFileSync(new URL(file, dir), 'utf8'))) {
      found.push({ file, expression });
    }
  }
  assert.equal(files.length, 4, 'four source files swept for a minting site');
  assert.deepEqual(
    found,
    [{ file: 'lib/core.ts', expression: EXPECTED_MINT }],
    'one site mints the key, and it hands the work to the client package',
  );

  // The second link: that name is the client package's export and not something declared here.
  const core = readFileSync(new URL('lib/core.ts', dir), 'utf8');
  const imported = /import \{([^}]*)\} from '@pwngh\/economy-client';/
    .exec(core)![1]!
    .split(',')
    .map((name) => name.trim());
  assert.ok(
    imported.includes('newIdempotencyKey'),
    `newIdempotencyKey comes from the client package, not from ${imported.join(', ')}`,
  );

  // The control: the same detector against the lookalike the shape comparison accepted. Without
  // it a regex that stopped matching anything would report the roster above as clean.
  const lookalike =
    "  'idempotency-key': idempotencyKey ?? crypto.randomUUID(),";
  assert.deepEqual(mints(lookalike), ['idempotencyKey ?? crypto.randomUUID()']);
  assert.notEqual(mints(lookalike)[0], EXPECTED_MINT);
});

test('surface: submitRoute sends the caller key verbatim and a fresh one otherwise', async () => {
  const keys: string[] = [];
  const fetchLike: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
    return new Response(JSON.stringify({ status: 'committed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const store = economyClient({
    baseUrl: 'http://economy.test',
    fetch: fetchLike,
    pollMs: false,
  });
  try {
    await store.submitRoute('/pay', {}, { idempotencyKey: 'idem_ord_918' });
    await store.submitRoute('/pay', {});
    await store.submitRoute('/pay', {});
    assert.equal(keys.length, 3, 'three writes, three keys');
    assert.equal(keys[0], 'idem_ord_918', 'a caller key goes out as written');
    assert.notEqual(keys[1], keys[2], 'and one call is one attempt');
    assert.equal(
      new Set(keys).size,
      3,
      'no key was reused across the three writes',
    );
    assert.notEqual(
      keys[1],
      newIdempotencyKey(),
      'the helper mints a fresh key per call rather than a constant',
    );
  } finally {
    store.close();
  }
});

// The paging values the README leans on are product: they have to be reachable and right.
test('surface: the paging constants are public and say what the README says', async () => {
  const ui = await door('@pwngh/economy-ui');
  const { LIST_KEYS, MAX_WINDOW, READ_KEYS } = ui;
  assert.deepEqual(
    LIST_KEYS,
    ['entitlements', 'subscriptions', 'payouts'],
    'the three reads that page, and only those',
  );
  assert.equal(MAX_WINDOW, 200, 'the ceiling the /v1 routes cap ?limit= at');
  assert.deepEqual(READ_KEYS, [
    'wallet',
    'entitlements',
    'subscriptions',
    'payouts',
  ]);
});
