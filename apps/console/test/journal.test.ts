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
import { toAmount } from '#src/money.ts';

import { buildEngine } from '~/economy.ts';
import {
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

function deposit(key: string, minor: bigint): JournalEntry {
  return {
    kind: 'topUp',
    idempotencyKey: key,
    actor: { kind: 'system', service: 'console' },
    userId: 'usr_alice',
    amount: toAmount('CREDIT', minor),
    source: 'card',
  };
}

function order(key: string, orderId: string, minor: bigint): JournalEntry {
  return {
    kind: 'spend',
    idempotencyKey: key,
    actor: { kind: 'user', userId: 'usr_alice' },
    orderId,
    buyerId: 'usr_alice',
    sku: 'Docs Demo Pass',
    price: toAmount('CREDIT', minor),
    recipients: [{ sellerId: 'usr_nova', shareBps: 10_000 }],
  };
}

it('a saved journal round-trips, bigint minor units included', () => {
  const entries = [deposit('idem_j1', 12_000n)];
  saveJournal(entries);
  const loaded = loadJournal();
  expect(loaded).toEqual(entries);
  expect(
    (loaded[0] as Extract<JournalEntry, { kind: 'topUp' }>).amount.minor,
  ).toBe(12_000n);
  clearJournal();
  expect(loadJournal()).toEqual([]);
});

it('a journal from another schema version is discarded, not half-replayed', () => {
  // The v1 format: facade calls, not Operations.
  store.set(
    'elab_journal',
    JSON.stringify({ v: 1, entries: [{ m: 'deposit', a: [] }] }),
  );
  expect(loadJournal()).toEqual([]);
  expect(store.has('elab_journal')).toBe(false);

  store.set('elab_journal', JSON.stringify({ v: 999, entries: [] }));
  expect(loadJournal()).toEqual([]);
});

it('a corrupt journal is cleared instead of bricking the handoff', () => {
  store.set('elab_journal', '{not json');
  expect(loadJournal()).toEqual([]);
  expect(store.has('elab_journal')).toBe(false);

  // Right version, wrong shape: entries that are not Operations.
  store.set(
    'elab_journal',
    JSON.stringify({ v: 2, entries: [{ m: 'deposit', a: [] }] }),
  );
  expect(loadJournal()).toEqual([]);
});

it('a replayed entry that faults is skipped, not fatal to the rest', async () => {
  const eco = await buildEngine();
  const bad = {
    ...order('idem_bad', 'ord_bad', 1n),
    // A user acting on another user's wallet throws AUTH.UNAUTHORIZED.
    actor: { kind: 'user' as const, userId: 'usr_nova' },
  };
  await replayJournal(eco, [bad, deposit('idem_ok', 1_000n)]);
  const wallet = await eco.wallet('usr_alice');
  expect(wallet).not.toBeNull();
});

it('after replay, both sides mint the same ids — the docs handoff invariant', async () => {
  // What a docs page journals: fund a wallet, place an order.
  const entries = [
    deposit('idem_h1', 12_000n),
    order('idem_h2', 'ord_handoff', 12_000n),
  ];

  // The docs side runs the operations live; the console side replays the journal over a fresh
  // seed.
  const docs = await buildEngine();
  await replayJournal(docs, entries);
  const console_ = await buildEngine();
  await replayJournal(console_, entries);

  // The next engine-minted id continues identically on both sides — the property every
  // "open txn_x in the console" link rests on.
  await docs.economy.submit(deposit('idem_h3', 1_000n));
  await console_.economy.submit(deposit('idem_h3', 1_000n));
  const [a, b] = [
    await docs.economy.submit(order('idem_h4', 'ord_next', 1_000n)),
    await console_.economy.submit(order('idem_h4', 'ord_next', 1_000n)),
  ];
  if (a.status !== 'committed' || b.status !== 'committed') {
    throw new Error(`expected both committed, got ${a.status} / ${b.status}`);
  }
  expect(a.transaction.id).toBeTruthy();
  expect(a.transaction.id).toBe(b.transaction.id);
});
