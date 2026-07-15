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

import { beforeEach, expect, it } from 'vitest';

import { buildEngine } from '~/economy.ts';
import {
  REPLAYABLE,
  clearJournal,
  loadJournal,
  replayJournal,
  saveJournal,
} from '~/journal.ts';

import type { JournalEntry } from '~/journal.ts';

// The node test environment has no localStorage; a Map-backed shim stands in.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  store.clear();
});

it('a saved journal round-trips through the version envelope', () => {
  const entries: JournalEntry[] = [
    { m: 'deposit', a: [{ userId: 'usr_alice', credits: 100 }] },
  ];
  saveJournal(entries);
  expect(loadJournal()).toEqual(entries);
  clearJournal();
  expect(loadJournal()).toEqual([]);
});

it('a journal from another schema version is discarded, not half-replayed', () => {
  // The pre-envelope format: a bare array.
  store.set('elab_journal', JSON.stringify([{ m: 'deposit', a: [] }]));
  expect(loadJournal()).toEqual([]);
  expect(store.has('elab_journal')).toBe(false);

  store.set('elab_journal', JSON.stringify({ v: 999, entries: [] }));
  expect(loadJournal()).toEqual([]);
});

it('a corrupt journal is cleared instead of bricking the handoff', () => {
  store.set('elab_journal', '{not json');
  expect(loadJournal()).toEqual([]);
  expect(store.has('elab_journal')).toBe(false);
});

it('replay applies only REPLAYABLE calls', async () => {
  const eco = await buildEngine();
  const before = eco.now();
  await replayJournal(eco, [
    { m: 'advanceTime', a: [86_400_000] }, // not journaled: must be skipped
    { m: 'deposit', a: [{ userId: 'usr_alice', credits: 100 }] },
  ]);
  expect(eco.now()).toBe(before);
  expect(REPLAYABLE.has('advanceTime')).toBe(false);
});

it('after replay, both sides mint the same ids — the docs handoff invariant', async () => {
  // What a docs page journals: fund a wallet, place an order.
  const entries: JournalEntry[] = [
    { m: 'deposit', a: [{ userId: 'usr_alice', credits: 120 }] },
    {
      m: 'purchase',
      a: [
        {
          buyerId: 'usr_alice',
          sellerId: 'usr_nova',
          listing: 'Docs Demo Pass',
          credits: 120,
          orderId: 'ord_handoff',
        },
      ],
    },
  ];

  // The docs side runs the calls live; the console side replays the journal over a fresh seed.
  const docs = await buildEngine();
  await replayJournal(docs, entries);
  const console_ = await buildEngine();
  await replayJournal(console_, entries);

  // The next engine-minted id continues identically on both sides — the property every
  // "open txn_x in the console" link rests on.
  const next = {
    buyerId: 'usr_alice',
    sellerId: 'usr_nova',
    listing: 'Next Pass',
    credits: 10,
    orderId: 'ord_next',
  };
  await docs.deposit({ userId: 'usr_alice', credits: 10 });
  await console_.deposit({ userId: 'usr_alice', credits: 10 });
  const [a, b] = [await docs.purchase(next), await console_.purchase(next)];
  if (a.status !== 'committed' || b.status !== 'committed') {
    throw new Error(`expected both committed, got ${a.status} / ${b.status}`);
  }
  expect(a.transaction.id).toBeTruthy();
  expect(a.transaction.id).toBe(b.transaction.id);
});
