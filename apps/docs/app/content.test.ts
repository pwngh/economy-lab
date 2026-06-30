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

import { describe, expect, it } from 'vitest';

import { docBySlug, docSchema, docs } from '~/content.ts';

// The slug contract: economy-lab's source links to these exact pages via @see {DOCS_BASE_URL}/<slug>.
// Section-rooted under economy/ (mirroring creators.vrchat.com). Every one must resolve, or an
// inbound link dangles. This list is the route manifest, tested.
const CONTRACT = [
  ...[
    'overview',
    'money-model',
    'accounts-and-double-entry',
    'solvency',
    'actors-and-authorization',
    'idempotency',
    'lifecycles',
    'credit-maturity',
    'integrity',
    'the-proof',
    'spend-velocity',
    'concurrency',
  ].map((s) => `economy/concepts/${s}`),
  ...[
    'top-up',
    'spend',
    'refund',
    'clawback',
    'request-payout',
    'settle-payout',
    'reverse-payout',
    'subscribe',
    'cancel-subscription',
    'grant-entitlement',
    'revoke-entitlement',
    'grant-promo',
    'adjust',
    'reverse',
  ].map((s) => `economy/reference/operations/${s}`),
  ...[
    'the-economy',
    'reads',
    'outcomes-and-reason-codes',
    'http-service',
    'background-worker',
    'configuration',
    'performance',
  ].map((s) => `economy/reference/${s}`),
  ...['signer', 'processor', 'rates', 'pricing', 'storage-and-messaging'].map(
    (s) => `economy/ports/${s}`,
  ),
  'economy/scope-and-non-goals',
];

describe('slug contract', () => {
  it('resolves every page economy-lab links to', () => {
    const missing = CONTRACT.filter((slug) => !docBySlug(slug));
    expect(missing).toEqual([]);
  });

  it('has 39 leaf pages, all under the economy/ section root', () => {
    expect(CONTRACT).toHaveLength(39);
    expect(docs.length).toBeGreaterThanOrEqual(39);
    expect(docs.every((d) => d.slug.startsWith('economy/'))).toBe(true);
  });
});

describe('docSchema', () => {
  it('accepts a well-formed page and applies defaults', () => {
    const d = docSchema.parse({ title: 'X', summary: 'Y' });
    expect(d.order).toBe(0);
    expect(d.status).toBe('stable');
    expect(d.sourceRefs).toEqual([]);
  });

  it('rejects a page missing a required field', () => {
    expect(() => docSchema.parse({ title: 'X' })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() =>
      docSchema.parse({ title: 'X', summary: 'Y', status: 'final' }),
    ).toThrow();
  });
});

describe('content', () => {
  it('every page has a non-empty title and summary', () => {
    for (const d of docs) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(0);
    }
  });

  it('is sorted by order then title', () => {
    const sorted = [...docs].sort(
      (a, b) => a.order - b.order || a.title.localeCompare(b.title),
    );
    expect(docs.map((d) => d.slug)).toEqual(sorted.map((d) => d.slug));
  });
});
