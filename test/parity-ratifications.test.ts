/// <reference types="node" />
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

/**
 * Locks in three review decisions so a future edit cannot silently undo one: the exact
 * event-type strings other systems read off the event stream, the deliberate absence of a
 * money-laundering-detection job, and the deliberate absence of an asset-download route.
 * Reverse a decision and the matching test fails, forcing the reversal to be deliberate.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { seededDigest, fixedClock } from '#test/support/capabilities.ts';
import { topUp, grantPromo, spend, credit } from '#test/support/builders.ts';
import { SWEEP_NAMES } from '#src/worker/index.ts';
import { createServer } from '#src/server.ts';

import type { Economy } from '#src/contract.ts';
import type { Store, EconomyEvent } from '#src/ports.ts';

// The store is returned too, so a test can read back the outbox events a request wrote.
function makePair(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  const economy = makeEconomy(1, store);
  return { economy, store };
}

// Drains the pending outbox events and marks each one relayed, so a later call in the same test
// will not see it again.
async function eventsOf(store: Store): Promise<EconomyEvent[]> {
  const batch = await store.outbox.claimBatch(100);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  return batch.map((message) => message.event);
}

describe('Submit Emits The Exact Agreed Event-Type Strings', () => {
  test('topUp emits economy.credits.topped_up', async () => {
    const { economy, store } = makePair();

    const outcome = await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');

    const events = await eventsOf(store);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'economy.credits.topped_up');
  });

  test('grantPromo emits economy.promo.granted', async () => {
    const { economy, store } = makePair();

    const outcome = await economy.submit(
      grantPromo({ userId: 'usr_buyer', amount: credit('5.00') }),
    );
    assert.equal(outcome.status, 'committed');

    const events = await eventsOf(store);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'economy.promo.granted');
  });

  test('spend emits economy.sale.completed', async () => {
    const { economy, store } = makePair();
    // Fund the buyer's spendable so the sale commits, then drop the top-up's own event.
    const funded = await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    assert.equal(funded.status, 'committed');
    await eventsOf(store);

    const outcome = await economy.submit(
      spend({
        buyerId: 'usr_buyer',
        sku: 'wrld_pass',
        price: credit('4.00'),
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      }),
    );
    assert.equal(outcome.status, 'committed');

    const events = await eventsOf(store);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'economy.sale.completed');
  });
});

describe('No Money-Laundering-Detection Background Job Exists', () => {
  test('SWEEP_NAMES does not include a laundering job', () => {
    assert.equal(
      (SWEEP_NAMES as readonly string[]).includes('laundering'),
      false,
    );
  });
});

describe('The Server Has No Asset-Download Route', () => {
  test('a download-style path 404s', async () => {
    const { economy } = makePair();
    const handler = createServer(economy);

    const res = await handler(
      new Request('http://economy.local/assets/wrld_pass', { method: 'GET' }),
    );

    assert.equal(res.status, 404);
  });
});
