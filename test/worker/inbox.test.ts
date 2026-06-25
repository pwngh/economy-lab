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
import { fault } from '#src/errors.ts';
import { credit } from '#test/support/builders.ts';
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
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { InboxEntry, Store } from '#src/ports.ts';

// Worker context from deterministic fakes (fixed clock, counted-up ids, etc.). drainInbox only reads
// logger/meter/config, but we pass the full object to match the other worker tests. A small
// `maxInboxAttempts` drives a poison row to its dead-letter cap in a few sweeps.
function workerCtx(maxInboxAttempts?: number): WorkerCtx {
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
      maxInboxAttempts === undefined ? config : { ...config, maxInboxAttempts },
  };
}

// The topUp a stored inbox row carries: the verified provider event already mapped to its Operation,
// keyed by the provider event id (which doubles as the row `key` and the operation's idempotencyKey).
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

// Enqueue a pending inbox row, the way the webhook handler does inside its transaction, leaving the
// store in the state a real apply sweep would pick up.
async function enqueue(store: Store, eventId: string): Promise<InboxEntry> {
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

// A committed Outcome, the success the economy returns when a topUp posts.
function committed(): Outcome {
  return {
    status: 'committed',
    transaction: { id: 'txn_x', postedAt: 0, legs: [], links: [] },
  };
}

// An Economy stub whose `submit` returns/throws what a test scripts, recording every operation it
// was handed so a test can assert which rows were applied and in what order. Only `submit` is read by
// drainInbox, so the rest of the surface is omitted.
function scriptedEconomy(
  respond: (operation: Operation, call: number) => Outcome,
): Pick<Economy, 'submit'> & { submitted: Operation[] } {
  let submitted: Operation[] = [];
  return {
    submitted,
    submit: async (operation) => {
      submitted.push(operation);
      return respond(operation, submitted.length - 1);
    },
  };
}

// One drain pass: claims pending rows and submits each through `economy`. `maxInboxAttempts` pins the
// dead-letter cap for tests that need it; otherwise the fixture default applies.
function sweep(
  store: Store,
  economy: Pick<Economy, 'submit'>,
  limit = 10,
  maxInboxAttempts?: number,
): Promise<InboxSummary> {
  return drainInbox(store, workerCtx(maxInboxAttempts), {
    economy: economy as Economy,
    now: 0,
    limit,
  });
}

describe('drainInbox', () => {
  test('applies every pending row and marks it applied', async () => {
    let store = memoryStore();
    await enqueue(store, 'e1');
    await enqueue(store, 'e2');
    let economy = scriptedEconomy(() => committed());

    let summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, ['ibx_e1', 'ibx_e2']);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(summary.deadLettered, []);
    // Both stored Operations went through the economy.
    assert.deepEqual(
      economy.submitted.map((o) => o.idempotencyKey),
      ['whk:e1', 'whk:e2'],
    );
    await store.close();
  });

  test('does not re-claim a row already applied by an earlier run', async () => {
    let store = memoryStore();
    await enqueue(store, 'e1');
    let economy = scriptedEconomy(() => committed());

    await sweep(store, economy);
    let second = await sweep(store, economy);

    assert.deepEqual(second.applied, []);
    // The economy saw the row only once: the applied row isn't re-claimed, so it isn't re-submitted.
    assert.equal(economy.submitted.length, 1);
    await store.close();
  });

  test('a duplicate Outcome still marks the row applied (re-apply deduped by the operation key)', async () => {
    let store = memoryStore();
    let entry = await enqueue(store, 'e1');
    // The economy reports the money move already happened (a prior run committed it but markApplied
    // didn't land); the row should still flip to applied so it isn't claimed forever.
    let economy = scriptedEconomy(() => ({
      status: 'duplicate',
      transaction: { id: 'txn_x', postedAt: 0, legs: [], links: [] },
    }));

    let summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, [entry.id]);
    assert.deepEqual(summary.failed, []);
    await store.close();
  });
});

describe('drainInbox — Retryable Failure', () => {
  test('leaves a row pending after a retryable throw so the next run retries it', async () => {
    let store = memoryStore();
    await enqueue(store, 'e1');
    let calls = 0;
    let economy = scriptedEconomy(() => {
      calls += 1;
      if (calls === 1) {
        throw fault('STORE.FAILURE', 'db blip', { retryable: true });
      }
      return committed();
    });

    let first = await sweep(store, economy);
    assert.deepEqual(first.applied, []);
    assert.deepEqual(first.failed, [
      { id: 'ibx_e1', code: 'STORE.FAILURE', retryable: true },
    ]);
    assert.deepEqual(first.deadLettered, []);

    // The row stayed pending with its attempt bumped; the next run claims it again and succeeds.
    let second = await sweep(store, economy);
    assert.deepEqual(second.applied, ['ibx_e1']);
    await store.close();
  });

  test('one failing row does not stop the rest of the batch', async () => {
    let store = memoryStore();
    await enqueue(store, 'bad');
    await enqueue(store, 'good');
    let economy = scriptedEconomy((operation) => {
      if (operation.idempotencyKey === 'whk:bad') {
        throw fault('STORE.FAILURE', 'boom', { retryable: true });
      }
      return committed();
    });

    let summary = await sweep(store, economy);

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
    let store = memoryStore();
    await enqueue(store, 'poison');
    // Always throws a retryable fault, so retries never succeed. Cap at 2: dead-letters on the 2nd
    // failure (the one that takes attempts to 2).
    let economy = scriptedEconomy(() => {
      throw fault('STORE.FAILURE', 'always down', { retryable: true });
    });

    let first = await sweep(store, economy, 10, 2);
    assert.deepEqual(
      first.failed.map((f) => f.id),
      ['ibx_poison'],
    );
    assert.deepEqual(first.deadLettered, []);

    let second = await sweep(store, economy, 10, 2);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.deadLettered, [
      { id: 'ibx_poison', reason: 'STORE.FAILURE' },
    ]);

    // The dead row is terminal: a later sweep never claims it again, so the economy isn't called.
    let submittedBefore = economy.submitted.length;
    let third = await sweep(store, economy, 10, 2);
    assert.deepEqual(third.applied, []);
    assert.deepEqual(third.deadLettered, []);
    assert.equal(economy.submitted.length, submittedBefore);
    await store.close();
  });

  test('dead-letters a row the economy rejects (a terminal business no, not retried)', async () => {
    let store = memoryStore();
    await enqueue(store, 'e1');
    // A well-formed request the economy declines as data (not a thrown fault): retrying would be
    // declined the same way forever, so the row is parked rather than burning attempts.
    let economy = scriptedEconomy(() => ({
      status: 'rejected',
      reason: 'INSUFFICIENT_FUNDS',
    }));

    let summary = await sweep(store, economy);

    assert.deepEqual(summary.applied, []);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(summary.deadLettered, [
      { id: 'ibx_e1', reason: 'INSUFFICIENT_FUNDS' },
    ]);

    // Parked immediately: a later sweep doesn't re-submit it.
    let second = await sweep(store, economy);
    assert.deepEqual(second.deadLettered, []);
    assert.equal(economy.submitted.length, 1);
    await store.close();
  });
});
