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

import { drainInbox, type InboxSummary } from '#src/worker/inbox.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable } from '#src/accounts.ts';
import { fault } from '#src/errors.ts';
import { credit } from '#test/support/builders.ts';
import { makePorts, testConfig } from '#test/support/capabilities.ts';

import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { InboxMessage, Store } from '#src/ports.ts';

// The provider event id doubles as the row `key` and the operation's idempotencyKey.
function topUp(eventId: string): Operation {
  return {
    kind: 'topUp',
    idempotencyKey: `whk:${eventId}`,
    actor: { kind: 'system', service: 'webhook:billing' },
    userId: 'usr_buyer',
    amount: credit('10.00'),
    source: 'card',
  } as unknown as Operation;
}

async function enqueue(store: Store, eventId: string): Promise<InboxMessage> {
  return store.transaction((unit) =>
    unit.inbox.enqueueInbound({
      id: `ibx_${eventId}`,
      key: eventId,
      operation: topUp(eventId),
      status: 'pending',
      attempts: 0,
      receivedAt: 0,
      reason: null,
    }),
  );
}

function committed(): Outcome {
  return {
    status: 'committed',
    transaction: { id: 'txn_x', postedAt: 0, legs: [], links: [], meta: {} },
  };
}

function scriptedEconomy(
  respond: (operation: Operation, call: number) => Outcome,
): Pick<Economy, 'submit'> & { submitted: Operation[] } {
  const submitted: Operation[] = [];
  return {
    submitted,
    submit: async (operation) => {
      submitted.push(operation);
      return respond(operation, submitted.length - 1);
    },
  };
}

function sweep(
  store: Store,
  economy: Pick<Economy, 'submit'>,
  limit = 10,
  maxInboxAttempts?: number,
): Promise<InboxSummary> {
  const ports =
    maxInboxAttempts === undefined
      ? makePorts(store)
      : makePorts(store, { config: { ...testConfig(), maxInboxAttempts } });
  return drainInbox(store, ports, {
    economy: economy as Economy,
    now: 0,
    limit,
  });
}

describe('drainInbox', () => {
  test('applies every pending row and marks it applied', async () => {
    const store = memoryStore();
    await enqueue(store, 'e1');
    await enqueue(store, 'e2');
    const economy = scriptedEconomy(() => committed());

    const summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, ['ibx_e1', 'ibx_e2']);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(summary.deadLettered, []);
    assert.deepEqual(
      economy.submitted.map((o) => o.idempotencyKey),
      ['whk:e1', 'whk:e2'],
    );
    await store.close();
  });

  test('does not re-claim a row already applied by an earlier run', async () => {
    const store = memoryStore();
    await enqueue(store, 'e1');
    const economy = scriptedEconomy(() => committed());

    await sweep(store, economy);
    const second = await sweep(store, economy);

    assert.deepEqual(second.applied, []);
    assert.equal(economy.submitted.length, 1);
    await store.close();
  });

  test('a duplicate Outcome still marks the row applied (re-apply deduped by the operation key)', async () => {
    const store = memoryStore();
    const entry = await enqueue(store, 'e1');
    // The economy reports that the money move already happened. A prior run committed it, but
    // markApplied never landed. The row should still flip to applied so it isn't claimed forever.
    const economy = scriptedEconomy(() => ({
      status: 'duplicate',
      transaction: { id: 'txn_x', postedAt: 0, legs: [], links: [], meta: {} },
    }));

    const summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, [entry.id]);
    assert.deepEqual(summary.failed, []);
    await store.close();
  });
});

describe('drainInbox — Retryable Failure', () => {
  test('dead-letters a non-retryable throw immediately instead of burning attempts', async () => {
    const store = memoryStore();
    await enqueue(store, 'e1');
    const economy = scriptedEconomy(() => {
      throw fault(
        'SAGA.INVALID_TRANSITION',
        'settle claim on a failed payout',
        {
          retryable: false,
        },
      );
    });

    const first = await sweep(store, economy);
    assert.deepEqual(first.failed, []);
    assert.deepEqual(first.deadLettered, [
      { id: 'ibx_e1', reason: 'SAGA.INVALID_TRANSITION' },
    ]);
    await store.close();
  });

  test('a raw applier throw reads as the port failing, not storage', async () => {
    const store = memoryStore();
    await enqueue(store, 'raw');
    const economy = scriptedEconomy(() => {
      throw new Error('host applier fell over');
    });

    const summary = await sweep(store, economy);
    assert.deepEqual(summary.failed, [
      { id: 'ibx_raw', code: 'PROVIDER.FAILURE', retryable: true },
    ]);
  });

  test('leaves a row pending after a retryable throw so the next run retries it', async () => {
    const store = memoryStore();
    await enqueue(store, 'e1');
    let calls = 0;
    const economy = scriptedEconomy(() => {
      calls += 1;
      if (calls === 1) {
        throw fault('STORE.FAILURE', 'db blip', { retryable: true });
      }
      return committed();
    });

    const first = await sweep(store, economy);
    assert.deepEqual(first.applied, []);
    assert.deepEqual(first.failed, [
      { id: 'ibx_e1', code: 'STORE.FAILURE', retryable: true },
    ]);
    assert.deepEqual(first.deadLettered, []);

    const second = await sweep(store, economy);
    assert.deepEqual(second.applied, ['ibx_e1']);
    await store.close();
  });

  test('one failing row does not stop the rest of the batch', async () => {
    const store = memoryStore();
    await enqueue(store, 'bad');
    await enqueue(store, 'good');
    const economy = scriptedEconomy((operation) => {
      if (operation.idempotencyKey === 'whk:bad') {
        throw fault('STORE.FAILURE', 'boom', { retryable: true });
      }
      return committed();
    });

    const summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, ['ibx_good']);
    assert.deepEqual(
      summary.failed.map((f) => f.id),
      ['ibx_bad'],
    );
    await store.close();
  });
});

describe('drainInbox — Dead-Letter', () => {
  test('dead-letters a poison row once attempts reach the cap and stops re-claiming it', async () => {
    const store = memoryStore();
    await enqueue(store, 'poison');
    // The cap is 2: the row dead-letters on the failure that takes attempts to 2.
    const economy = scriptedEconomy(() => {
      throw fault('STORE.FAILURE', 'always down', { retryable: true });
    });

    const first = await sweep(store, economy, 10, 2);
    assert.deepEqual(
      first.failed.map((f) => f.id),
      ['ibx_poison'],
    );
    assert.deepEqual(first.deadLettered, []);

    const second = await sweep(store, economy, 10, 2);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.deadLettered, [
      { id: 'ibx_poison', reason: 'STORE.FAILURE' },
    ]);

    const submittedBefore = economy.submitted.length;
    const third = await sweep(store, economy, 10, 2);
    assert.deepEqual(third.applied, []);
    assert.deepEqual(third.deadLettered, []);
    assert.equal(economy.submitted.length, submittedBefore);
    await store.close();
  });

  test('dead-letters a row the economy rejects (a terminal business no, not retried)', async () => {
    const store = memoryStore();
    await enqueue(store, 'e1');
    // A business decline is data, not a throw; it would repeat forever, so the row parks at once.
    const economy = scriptedEconomy(() => ({
      status: 'rejected',
      detail: {
        reason: 'INSUFFICIENT_FUNDS',
        account: spendable('usr_buyer'),
        need: credit('10.00'),
        have: credit('0.00'),
      },
    }));

    const summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, []);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(summary.deadLettered, [
      { id: 'ibx_e1', reason: 'INSUFFICIENT_FUNDS' },
    ]);

    const second = await sweep(store, economy);
    assert.deepEqual(second.deadLettered, []);
    assert.equal(economy.submitted.length, 1);
    await store.close();
  });
});
