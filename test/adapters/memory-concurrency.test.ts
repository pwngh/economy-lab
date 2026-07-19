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
 * Concurrent use of the in-memory store: overlapping `transaction` callers queue FIFO behind one
 * writer instead of throwing "in-memory transactions do not nest", so `Promise.all` against
 * a `createEconomy` economy just works — outcomes stay correct and the books prove.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from '#src/adapters/memory.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { topUp, spend, credit } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';

import type { Outcome } from '#src/contract.ts';

const statuses = (outcomes: Outcome[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  }
  return counts;
};

describe('memory store: overlapping transactions', () => {
  test('overlapping callers run whole, one at a time, in arrival order', async () => {
    const store = memoryStore();
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        store.transaction(async () => {
          order.push(i);
          // Hold the transaction across a tick so an interleaver would show up.
          await Promise.resolve();
          order.push(i);
        }),
      ),
    );
    assert.deepEqual(order, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test('a failing transaction rolls back without wedging the queue', async () => {
    const store = memoryStore();
    const results = await Promise.allSettled([
      store.transaction(async () => {
        throw new Error('boom');
      }),
      store.transaction(async () => 'after'),
    ]);
    assert.equal(results[0]!.status, 'rejected');
    assert.deepEqual(results[1], { status: 'fulfilled', value: 'after' });
  });
});

describe('concurrent submits through economy.submit', () => {
  test('a retry storm on one idempotency key commits exactly once', async () => {
    const economy = makeEconomy();
    const operation = topUp({ userId: 'usr_storm', amount: credit('10.00') });

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => economy.submit(operation)),
    );

    assert.deepEqual(statuses(outcomes), { committed: 1, duplicate: 7 });
    assert.deepEqual(
      await economy.read.balance(spendable('usr_storm')),
      credit('10.00'),
    );
    const report = await economy.read.health();
    assert.equal(report.conserved && report.backed && report.noOverdraft, true);
  });

  test('an oversubscribed wallet never oversells under Promise.all', async () => {
    const economy = makeEconomy();
    const funded = await economy.submit(
      topUp({ userId: 'usr_rush', amount: credit('3.00') }),
    );
    assert.equal(funded.status, 'committed');

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        economy.submit(
          spend({
            buyerId: 'usr_rush',
            sku: `wrld_${i}`,
            price: credit('1.00'),
            recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
          }),
        ),
      ),
    );

    assert.deepEqual(statuses(outcomes), { committed: 3, rejected: 2 });
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        assert.equal(outcome.detail.reason, 'INSUFFICIENT_FUNDS');
      }
    }
    assert.deepEqual(
      await economy.read.balance(spendable('usr_rush')),
      credit('0.00'),
    );
    const report = await economy.read.health();
    assert.equal(report.conserved && report.backed && report.noOverdraft, true);
  });
});
