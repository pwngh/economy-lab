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
import { makeWorkerCtx, testConfig } from '#test/support/capabilities.ts';

import type { Dispatcher, EconomyEvent, Store } from '#src/ports.ts';

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

async function enqueue(store: Store, id: string): Promise<void> {
  await store.transaction((unit) =>
    unit.outbox.enqueue({
      id: `obx_${id}`,
      event: event(id),
      status: 'pending',
      attempts: 0,
      reason: null,
      correlationId: null,
    }),
  );
}

function recordingDispatcher(): Dispatcher & { delivered: string[] } {
  const delivered: string[] = [];
  const dispatcher = (async (e: EconomyEvent) => {
    delivered.push(e.id);
  }) as Dispatcher & { delivered: string[] };
  dispatcher.delivered = delivered;
  return dispatcher;
}

function sweep(
  store: Store,
  dispatcher: Dispatcher,
  limit = 10,
  maxOutboxAttempts?: number,
): Promise<RelaySummary> {
  // A small `maxOutboxAttempts` drives a poison row to its dead-letter cap in a few sweeps.
  const ctx =
    maxOutboxAttempts === undefined
      ? makeWorkerCtx()
      : makeWorkerCtx({ config: { ...testConfig(), maxOutboxAttempts } });
  return relayOutbox(store, ctx, { dispatcher, limit });
}

describe('relayOutbox', () => {
  test('observes the backlog gauge pair before claiming, and no age once drained', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    const observed: Array<{ name: string; value: number }> = [];
    const ctx = makeWorkerCtx({
      meter: {
        count: () => {},
        observe: (name, value) => observed.push({ name, value }),
      },
    });
    const dispatcher = recordingDispatcher();

    await relayOutbox(store, ctx, { dispatcher, limit: 10 });
    const backlog = observed.find((o) => o.name === 'worker.relay.backlog');
    const age = observed.find((o) => o.name === 'worker.relay.backlog_age_ms');
    assert.equal(backlog?.value, 1);
    assert.notEqual(age, undefined);
    assert.ok(age!.value >= 0);

    observed.length = 0;
    await relayOutbox(store, ctx, { dispatcher, limit: 10 });
    assert.equal(
      observed.find((o) => o.name === 'worker.relay.backlog')?.value,
      0,
    );
    assert.equal(
      observed.find((o) => o.name === 'worker.relay.backlog_age_ms'),
      undefined,
    );
    await store.close();
  });

  test('relays every pending row and marks it relayed', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    await enqueue(store, '2');
    const dispatcher = recordingDispatcher();

    const summary = await sweep(store, dispatcher);

    assert.deepEqual(summary.relayed, ['obx_1', 'obx_2']);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(dispatcher.delivered, ['evt_1', 'evt_2']);
    await store.close();
  });

  test('does not re-claim a row already relayed by an earlier run', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    const dispatcher = recordingDispatcher();

    await sweep(store, dispatcher);
    const second = await sweep(store, dispatcher);

    assert.deepEqual(second.relayed, []);
    assert.deepEqual(dispatcher.delivered, ['evt_1']);
    await store.close();
  });

  test('leaves a failed row pending so the next run retries it', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    let attempts = 0;
    const dispatcher: Dispatcher = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('subscriber down');
      }
    };

    const first = await sweep(store, dispatcher);
    const second = await sweep(store, dispatcher);

    assert.deepEqual(first.relayed, []);
    assert.equal(first.failed.length, 1);
    assert.equal(first.failed[0]?.id, 'obx_1');
    assert.deepEqual(second.relayed, ['obx_1']);
    await store.close();
  });

  test('isolates a row that always fails delivery so a healthy one behind it still relays', async () => {
    const store = memoryStore();
    await enqueue(store, 'bad');
    await enqueue(store, 'good');
    const dispatcher: Dispatcher = async (e) => {
      if (e.id === 'evt_bad') {
        throw new Error('poison');
      }
    };

    const summary = await sweep(store, dispatcher);

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
    const store = memoryStore();
    await enqueue(store, '1');
    const dispatcher: Dispatcher = async () => {
      throw new Error('transient');
    };

    const summary = await sweep(store, dispatcher);

    // A raw dispatcher throw is the injected port's fault, so it never reads as a store failure.
    assert.equal(summary.failed[0]?.code, 'PROVIDER.FAILURE');
    assert.equal(summary.failed[0]?.retryable, true);
    await store.close();
  });

  test('honors the claim limit, leaving the remainder for the next run', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    await enqueue(store, '2');
    await enqueue(store, '3');
    const dispatcher = recordingDispatcher();

    const summary = await sweep(store, dispatcher, 2);

    assert.deepEqual(summary.relayed, ['obx_1', 'obx_2']);
    assert.deepEqual(dispatcher.delivered, ['evt_1', 'evt_2']);
    await store.close();
  });
});

describe('relayOutbox — Retry Cap', () => {
  test('bumps attempts on each under-cap failure, keeping the row claimable', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    const dispatcher: Dispatcher = async () => {
      throw new Error('subscriber down');
    };

    const first = await sweep(store, dispatcher, 10, 3);
    const second = await sweep(store, dispatcher, 10, 3);

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
    const claimable = await store.outbox.claimBatch(10);
    assert.deepEqual(
      claimable.map((m) => m.id),
      ['obx_1'],
    );
    assert.equal(claimable[0]?.attempts, 2);
    await store.close();
  });

  test('dead-letters an always-failing row at the cap and stops re-claiming it', async () => {
    const store = memoryStore();
    await enqueue(store, '1');
    const dispatcher: Dispatcher = async () => {
      throw new Error('always poison');
    };

    // The cap is `>=`: the third failure (attempts 3) dead-letters the row, not the fourth.
    const s1 = await sweep(store, dispatcher, 10, 3);
    const s2 = await sweep(store, dispatcher, 10, 3);
    const s3 = await sweep(store, dispatcher, 10, 3);

    assert.deepEqual(s1.deadLettered, []);
    assert.deepEqual(s2.deadLettered, []);
    assert.deepEqual(s3.failed, []);
    assert.deepEqual(s3.deadLettered, [
      { id: 'obx_1', reason: 'PROVIDER.FAILURE' },
    ]);

    const s4 = await sweep(store, dispatcher, 10, 3);
    assert.deepEqual(s4.relayed, []);
    assert.deepEqual(s4.failed, []);
    assert.deepEqual(s4.deadLettered, []);
    assert.deepEqual(await store.outbox.claimBatch(10), []);
    await store.close();
  });

  test('a dead-lettered always-failing row does not block a healthy row behind it', async () => {
    const store = memoryStore();
    await enqueue(store, 'bad');
    await enqueue(store, 'good');
    const dispatcher: Dispatcher = async (e) => {
      if (e.id === 'evt_bad') {
        throw new Error('poison');
      }
    };

    const summary = await sweep(store, dispatcher, 10, 1);

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
