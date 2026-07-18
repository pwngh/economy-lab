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

// The search stack, exercised as the exact bytes that ship: the index the loader emits (bodies
// lowercased for matching, reason and fault codes kept verbatim in `code`) and the ranking in
// public/search.js, run with an injected document and fetch the way bounce.test.ts runs the
// console bounce. The ranking claims under test: a title hit outranks a body hit, a pasted
// reason code lands its documenting pages regardless of typed case, and operation pages surface
// first among same-kind matches.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

import { loader } from './routes/search-index.json.ts';

const SEARCH_JS = readFileSync(
  fileURLToPath(new URL('../public/search.js', import.meta.url)),
  'utf8',
);

type Entry = {
  slug: string;
  title: string;
  summary: string;
  section: string;
  body: string;
  code: string[];
};

function element() {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  return {
    handlers,
    hidden: true,
    innerHTML: '',
    children: [],
    value: '',
    addEventListener: (name: string, fn: (e: unknown) => unknown) => {
      handlers[name] = fn;
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    contains: () => false,
    blur: () => {},
  };
}

/** Boots the shipped script against a fixture index and returns a query → ordered-slugs helper. */
function boot(index: Entry[]) {
  const input = element();
  const results = element();
  const document = {
    getElementById: (id: string) =>
      id === 'site-search-input' ? input : id === 'site-search-results' ? results : null,
    addEventListener: () => {},
    activeElement: null,
  };
  const fetch = async () => ({ json: async () => index });
  new Function('document', 'fetch', 'window', SEARCH_JS)(document, fetch, {});
  return async (query: string) => {
    input.value = query;
    await input.handlers.input?.(undefined);
    return [...results.innerHTML.matchAll(/href="\/([^"]+)\/"/g)].map((m) => m[1]);
  };
}

const entry = (over: Partial<Entry>): Entry => ({
  slug: 'economy/x',
  title: 'X',
  summary: '',
  section: 'Concepts',
  body: '',
  code: [],
  ...over,
});

describe('search index', () => {
  let index: Entry[];

  beforeAll(async () => {
    index = await loader().json();
  });

  test('bodies are lowercased for case-blind matching', () => {
    for (const d of index) expect(d.body).toBe(d.body.toLowerCase());
  });

  test('reason and fault codes survive verbatim in code tokens', () => {
    const outcomes = index.find((d) => d.slug === 'economy/reference/outcomes-and-reason-codes');
    expect(outcomes?.code).toContain('INSUFFICIENT_FUNDS');
    expect(outcomes?.code?.some((c) => c.startsWith('LEDGER.'))).toBe(true);
  });

  test('operation pages carry the Operations section label', () => {
    const spend = index.find((d) => d.slug === 'economy/reference/operations/spend');
    expect(spend?.section).toBe('Operations');
  });
});

describe('search ranking', () => {
  test('a typed lowercase reason code finds its documenting pages', async () => {
    const query = boot([
      entry({ slug: 'economy/concepts/solvency', body: 'nothing relevant here' }),
      entry({
        slug: 'economy/reference/outcomes-and-reason-codes',
        section: 'Reference',
        code: ['INSUFFICIENT_FUNDS'],
      }),
    ]);
    expect(await query('insufficient_funds')).toEqual([
      'economy/reference/outcomes-and-reason-codes',
    ]);
  });

  test('operation pages surface first among same-kind matches', async () => {
    const query = boot([
      entry({
        slug: 'economy/reference/outcomes-and-reason-codes',
        section: 'Reference',
        code: ['INSUFFICIENT_FUNDS'],
      }),
      entry({
        slug: 'economy/reference/operations/spend',
        section: 'Operations',
        code: ['INSUFFICIENT_FUNDS'],
      }),
    ]);
    expect(await query('INSUFFICIENT_FUNDS')).toEqual([
      'economy/reference/operations/spend',
      'economy/reference/outcomes-and-reason-codes',
    ]);
  });

  test('a title hit outranks a body hit, and the Operations bump cannot cross that line', async () => {
    const query = boot([
      entry({
        slug: 'economy/reference/operations/top-up',
        section: 'Operations',
        body: 'idempotency appears only in the body',
      }),
      entry({ slug: 'economy/concepts/idempotency', title: 'Idempotency' }),
    ]);
    expect(await query('idempotency')).toEqual([
      'economy/concepts/idempotency',
      'economy/reference/operations/top-up',
    ]);
  });

  test('the bare tail of a namespaced fault code still lands it', async () => {
    const query = boot([entry({ slug: 'economy/concepts/solvency', code: ['LEDGER.OVERDRAFT'] })]);
    expect(await query('overdraft')).toEqual(['economy/concepts/solvency']);
  });

  test('no match renders nothing', async () => {
    const query = boot([entry({ slug: 'economy/concepts/solvency', body: 'ledger' })]);
    expect(await query('zebra')).toEqual([]);
  });
});
