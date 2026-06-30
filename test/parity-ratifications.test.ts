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
 * Locks in three design decisions so a future edit cannot silently undo one. Each decision was a
 * review objection. The O-numbers are those objection ids, reused as the test group names. Reverse
 * a decision and the matching test fails, which forces the reversal to be deliberate.
 *
 *  - O5: the three event types the request path emits must equal an agreed set of exact strings.
 *    These names are the public contract that other systems read off the event stream. They were
 *    renamed away from older names (`purchase.completed`, `marketplace.sale`) and must not drift
 *    back.
 *
 *  - O11: money-laundering-ring detection is intentionally not built. The worker runs a fixed job
 *    list (`SWEEP_NAMES`). This test guards that no `laundering` job crept in.
 *
 *  - O7: signed asset downloads are out of scope, so the server has no asset or download route. Any
 *    download-style URL returns 404.
 *
 * Related objections are covered elsewhere: risk-denial (O4) by the subscribe velocity test, and
 * O12 and O14 by the shared store conformance suite.
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

// Builds a fresh store and an economy wired onto it. Both share one fixed-seed hash and one frozen
// clock, so hashes and timestamps are deterministic. The store is returned as well, so a test can
// read back the events a request wrote. Events land in the store's outbox, a table written in the
// same transaction as the money move. An event is therefore never sent for a rolled-back move and
// never lost for a committed one.
function makePair(): { economy: Economy; store: Store } {
  let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  let economy = makeEconomy(1, store);
  return { economy, store };
}

// Drains the pending outbox events and marks each one relayed, so a later call in the same test
// will not see it again. The limit of 100 is well above what any one request produces, so this
// drains the whole queue.
async function eventsOf(store: Store): Promise<EconomyEvent[]> {
  let batch = await store.outbox.claimBatch(100);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  return batch.map((message) => message.event);
}

describe('Submit Emits The Exact Agreed Event-Type Strings', () => {
  test('topUp emits economy.credits.topped_up', async () => {
    let { economy, store } = makePair();

    let outcome = await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');

    let events = await eventsOf(store);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'economy.credits.topped_up');
  });

  test('grantPromo emits economy.promo.granted', async () => {
    let { economy, store } = makePair();

    let outcome = await economy.submit(
      grantPromo({ userId: 'usr_buyer', amount: credit('5.00') }),
    );
    assert.equal(outcome.status, 'committed');

    let events = await eventsOf(store);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'economy.promo.granted');
  });

  test('spend emits economy.sale.completed', async () => {
    let { economy, store } = makePair();
    // Fund the buyer's spendable so the sale commits, then drop the top-up's own event.
    let funded = await economy.submit(
      topUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );
    assert.equal(funded.status, 'committed');
    await eventsOf(store);

    let outcome = await economy.submit(
      spend({
        buyerId: 'usr_buyer',
        sku: 'wrld_pass',
        price: credit('4.00'),
        recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      }),
    );
    assert.equal(outcome.status, 'committed');

    let events = await eventsOf(store);
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
    let { economy } = makePair();
    let handler = createServer(economy);

    let res = await handler(
      new Request('http://economy.local/assets/wrld_pass', { method: 'GET' }),
    );

    assert.equal(res.status, 404);
  });
});
