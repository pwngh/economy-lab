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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { relayOutbox, type RelaySummary } from '#src/worker/relay.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  testConfig,
} from '#test/support/capabilities.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { Dispatcher, EconomyEvent, Store } from '#src/ports.ts';

// Worker context from deterministic fakes (fixed clock, counted-up ids, etc.). The relay only
// reads logger/meter/config, but we pass the full object to match the other worker tests.
//
// A "poison" row always throws on delivery, so retries never succeed. The relay caps failed
// attempts and marks the row permanently failed ("dead-lettering") rather than retrying forever
// and blocking rows behind it. `maxOutboxAttempts` is that cap; a small value drives a poison
// row to the cap in a few sweeps.
function workerCtx(maxOutboxAttempts?: number): WorkerCtx {
  let config = testConfig();
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config:
      maxOutboxAttempts === undefined
        ? config
        : { ...config, maxOutboxAttempts },
  };
}

// Sample event in the standard emitted shape; the dispatcher receives this for delivery.
function event(id: string): EconomyEvent {
  return {
    id: `evt_${id}`,
    type: 'economy.sale.completed',
    version: 1,
    occurredAt: 0,
    subject: 'usr_buyer',
    data: {},
    audience: 'internal',
  };
}

// Saves a pending event to the outbox. Real operations enqueue inside the same transaction as
// the money move, so we do too, leaving the store in the state a real relay run would pick up.
async function enqueue(store: Store, id: string): Promise<void> {
  await store.transaction((unit) =>
    unit.outbox.enqueue({
      id: `obx_${id}`,
      event: event(id),
      status: 'pending',
      attempts: 0,
    }),
  );
}

// A dispatcher that records every event it receives, so a test asserts what was delivered.
function recordingDispatcher(): Dispatcher & { delivered: string[] } {
  let delivered: string[] = [];
  let dispatcher = (async (e: EconomyEvent) => {
    delivered.push(e.id);
  }) as Dispatcher & { delivered: string[] };
  dispatcher.delivered = delivered;
  return dispatcher;
}

// Runs one relay pass: claims up to `limit` pending events and sends each through the
// dispatcher. `maxOutboxAttempts` pins the dead-letter cap for tests that need it; otherwise
// the fixture default applies.
function sweep(
  store: Store,
  dispatcher: Dispatcher,
  limit = 10,
  maxOutboxAttempts?: number,
): Promise<RelaySummary> {
  return relayOutbox(store, workerCtx(maxOutboxAttempts), {
    dispatcher,
    limit,
  });
}

describe('relayOutbox', () => {
  test('relays every pending row and marks it relayed', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    await enqueue(store, '2');
    let dispatcher = recordingDispatcher();

    let summary = await sweep(store, dispatcher);

    assert.deepEqual(summary.relayed, ['obx_1', 'obx_2']);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(dispatcher.delivered, ['evt_1', 'evt_2']);
    await store.close();
  });

  test('does not re-claim a row already relayed by an earlier run', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    let dispatcher = recordingDispatcher();

    await sweep(store, dispatcher);
    let second = await sweep(store, dispatcher);

    assert.deepEqual(second.relayed, []);
    assert.deepEqual(dispatcher.delivered, ['evt_1']);
    await store.close();
  });

  test('leaves a failed row pending so the next run retries it', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    let attempts = 0;
    let dispatcher: Dispatcher = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('subscriber down');
      }
    };

    let first = await sweep(store, dispatcher);
    let second = await sweep(store, dispatcher);

    assert.deepEqual(first.relayed, []);
    assert.equal(first.failed.length, 1);
    assert.equal(first.failed[0]?.id, 'obx_1');
    assert.deepEqual(second.relayed, ['obx_1']);
    await store.close();
  });

  test('isolates a row that always fails delivery so a healthy one behind it still relays', async () => {
    let store = memoryStore();
    await enqueue(store, 'bad');
    await enqueue(store, 'good');
    let dispatcher: Dispatcher = async (e) => {
      if (e.id === 'evt_bad') {
        throw new Error('poison');
      }
    };

    let summary = await sweep(store, dispatcher);

    assert.deepEqual(summary.relayed, ['obx_good']);
    assert.deepEqual(
      summary.failed.map((f) => f.id),
      ['obx_bad'],
    );
    await store.close();
  });
});

describe('relayOutbox — Classification And Limit', () => {
  test('reports a failed dispatch with an error code and whether it is retryable', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    let dispatcher: Dispatcher = async () => {
      throw new Error('transient');
    };

    let summary = await sweep(store, dispatcher);

    assert.equal(summary.failed[0]?.code, 'STORE.FAILURE');
    assert.equal(summary.failed[0]?.retryable, true);
    await store.close();
  });

  test('honors the claim limit, leaving the remainder for the next run', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    await enqueue(store, '2');
    await enqueue(store, '3');
    let dispatcher = recordingDispatcher();

    let summary = await sweep(store, dispatcher, 2);

    assert.deepEqual(summary.relayed, ['obx_1', 'obx_2']);
    assert.deepEqual(dispatcher.delivered, ['evt_1', 'evt_2']);
    await store.close();
  });
});

describe('relayOutbox — Retry Cap', () => {
  test('bumps attempts on each under-cap failure, keeping the row claimable', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    let dispatcher: Dispatcher = async () => {
      throw new Error('subscriber down');
    };

    // Cap of 3: the first two failures are under the cap, so each bumps `attempts` and the row
    // stays 'pending' to be re-claimed. No dead-lettering across these two sweeps.
    let first = await sweep(store, dispatcher, 10, 3);
    let second = await sweep(store, dispatcher, 10, 3);

    assert.deepEqual(
      first.failed.map((f) => f.id),
      ['obx_1'],
    );
    assert.deepEqual(first.deadLettered, []);
    assert.deepEqual(
      second.failed.map((f) => f.id),
      ['obx_1'],
    );
    assert.deepEqual(second.deadLettered, []);
    // attempts has been bumped to 2; the row is still pending and still claimed.
    let claimable = await store.outbox.claimBatch(10);
    assert.deepEqual(
      claimable.map((m) => m.id),
      ['obx_1'],
    );
    assert.equal(claimable[0]?.attempts, 2);
    await store.close();
  });

  test('dead-letters an always-failing row at the cap and stops re-claiming it', async () => {
    let store = memoryStore();
    await enqueue(store, '1');
    let dispatcher: Dispatcher = async () => {
      throw new Error('always poison');
    };

    // Cap of 3: failures 1 and 2 stay 'pending' (under the cap); failure 3 takes `attempts` to
    // 3 and dead-letters the row (status 'failed'), since the worker uses a `>=` cap. The row is
    // then terminal and never claimed again.
    let s1 = await sweep(store, dispatcher, 10, 3);
    let s2 = await sweep(store, dispatcher, 10, 3);
    let s3 = await sweep(store, dispatcher, 10, 3);

    assert.deepEqual(s1.deadLettered, []);
    assert.deepEqual(s2.deadLettered, []);
    // The third failure dead-letters, recording the normalized error code as the reason.
    assert.deepEqual(s3.failed, []);
    assert.deepEqual(s3.deadLettered, [
      { id: 'obx_1', reason: 'STORE.FAILURE' },
    ]);

    // Poison row is terminal: claimBatch never returns it, so a further sweep is a no-op and the
    // queue is not wedged behind it.
    let s4 = await sweep(store, dispatcher, 10, 3);
    assert.deepEqual(s4.relayed, []);
    assert.deepEqual(s4.failed, []);
    assert.deepEqual(s4.deadLettered, []);
    assert.deepEqual(await store.outbox.claimBatch(10), []);
    await store.close();
  });

  test('a dead-lettered always-failing row does not block a healthy row behind it', async () => {
    let store = memoryStore();
    await enqueue(store, 'bad');
    await enqueue(store, 'good');
    let dispatcher: Dispatcher = async (e) => {
      if (e.id === 'evt_bad') {
        throw new Error('poison');
      }
    };

    // Cap of 1: the first failure of 'bad' reaches the cap and dead-letters it in the same sweep
    // that relays 'good'. One pass clears both: 'good' delivered, 'bad' terminal.
    let summary = await sweep(store, dispatcher, 10, 1);

    assert.deepEqual(summary.relayed, ['obx_good']);
    assert.deepEqual(
      summary.deadLettered.map((d) => d.id),
      ['obx_bad'],
    );
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(await store.outbox.claimBatch(10), []);
    await store.close();
  });
});
