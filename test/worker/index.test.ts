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

import { runSweeps, createWorker } from '#src/worker/index.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { fault } from '#src/errors.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { makeWorkerCtx, seededDigest } from '#test/support/capabilities.ts';

import type { SweepInput } from '#src/worker/index.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';
import type {
  Digest,
  Dispatcher,
  Posting,
  Scheduler,
  Store,
} from '#src/ports.ts';

function emptyFeed(): ReconcileFeed {
  return { pull: async () => ({ processor: [], ledger: [] }) };
}

function nullDispatcher(): Dispatcher {
  return async () => {};
}

function sweepInput(overrides?: Partial<SweepInput>): SweepInput {
  return {
    now: 1_000,
    limit: 10,
    dispatcher: nullDispatcher(),
    feed: emptyFeed(),
    windows: [{ from: 0, to: 1_000 }],
    ...overrides,
  };
}

// Two real accounts, so the checkpoint job has heads to snapshot.
function seedPosting(): Posting {
  const amount = toAmount('CREDIT', 500n);
  return {
    txnId: 'txn_seed',
    legs: [credit(spendable('usr_a'), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}

async function seededStore(): Promise<{ store: Store; digest: Digest }> {
  const digest = seededDigest(1);
  const store = memoryStore({ digest });
  await store.transaction((unit) => postEntry(unit.ledger, seedPosting()));
  return { store, digest };
}

// One flag per job, flipped on that job's first probed store call. Jobs without a distinct read
// are tracked otherwise: checkpoint by its `checkpoints.put` write (its heads read is shared
// with treasury), reconcile on the feed (see `recordingFeed`), and feeSweep — which also shares
// the heads read — has no flag here and is asserted in treasury.test.ts instead.
type Touched = {
  payouts: boolean;
  subscriptions: boolean;
  treasury: boolean;
  checkpoint: boolean;
  checkpointVerify: boolean;
  relay: boolean;
  promos: boolean;
};

function recordingStore(
  store: Store,
  touched: Touched,
  faults?: Partial<Record<keyof Touched, Error>>,
): Store {
  const trip = (key: keyof Touched): void => {
    touched[key] = true;
    const error = faults?.[key];
    if (error !== undefined) {
      throw error;
    }
  };
  return {
    ...store,
    sagas: {
      ...store.sagas,
      claimDue: probe(store.sagas.claimDue, () => trip('payouts')),
    },
    subscriptions: {
      ...store.subscriptions,
      claimDue: probe(store.subscriptions.claimDue, () =>
        trip('subscriptions'),
      ),
    },
    promos: {
      ...store.promos,
      claimDue: probe(store.promos.claimDue, () => trip('promos')),
    },
    outbox: {
      ...store.outbox,
      claimBatch: probe(store.outbox.claimBatch, () => trip('relay')),
    },
    checkpoints: {
      ...store.checkpoints,
      put: probe(store.checkpoints.put, () => trip('checkpoint')),
      latest: probe(store.checkpoints.latest, () => trip('checkpointVerify')),
    },
    ledger: {
      ...store.ledger,
      heads: () => {
        trip('treasury');
        return store.ledger.heads();
      },
    },
  };
}

// `before` runs first so the flag records even when the real call returns empty.
function probe<TArgs extends unknown[], TResult>(
  method: (...args: TArgs) => Promise<TResult>,
  before: () => void,
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => {
    before();
    return method(...args);
  };
}

function recordingFeed(touched: { reconcile: boolean }): ReconcileFeed {
  return {
    pull: async () => {
      touched.reconcile = true;
      return { processor: [], ledger: [] };
    },
  };
}

function freshTouched(): Touched {
  return {
    payouts: false,
    subscriptions: false,
    treasury: false,
    checkpoint: false,
    checkpointVerify: false,
    relay: false,
    promos: false,
  };
}

// --- runSweeps invokes every sweep ------------------------------------------------

async function invokesEverySweep(): Promise<void> {
  const { store, digest } = await seededStore();
  const touched = freshTouched();
  const reconcileTouched = { reconcile: false };
  const recording = recordingStore(store, touched);

  await runSweeps(
    recording,
    makeWorkerCtx({ digest }),
    sweepInput({ feed: recordingFeed(reconcileTouched) }),
  );

  assert.deepEqual(touched, {
    payouts: true,
    subscriptions: true,
    treasury: true,
    checkpoint: true,
    checkpointVerify: true,
    relay: true,
    promos: true,
  });
  assert.equal(reconcileTouched.reconcile, true);
  await store.close();
}

async function reportsEverySweepUnderItsName(): Promise<void> {
  const { store, digest } = await seededStore();

  const batch = await runSweeps(store, makeWorkerCtx({ digest }), sweepInput());

  for (const name of [
    'payouts',
    'subscriptions',
    'treasury',
    'feeSweep',
    'checkpoint',
    'checkpointVerify',
    'relay',
    'reconcile',
    'promos',
  ] as const) {
    assert.equal(batch[name].ok, true, `${name} should have run cleanly`);
  }
  await store.close();
}

// --- isolation: a thrown sweep stays in its own slot ------------------------------

async function isolatesAThrownSweepFromTheBatch(): Promise<void> {
  const { store, digest } = await seededStore();
  const touched = freshTouched();
  const recording = recordingStore(store, touched, {
    payouts: fault('STORE.FAILURE', 'sagas down', { retryable: true }),
  });

  const batch = await runSweeps(
    recording,
    makeWorkerCtx({ digest }),
    sweepInput(),
  );

  assert.equal(batch.payouts.ok, false);
  assert.equal(batch.subscriptions.ok, true);
  assert.equal(batch.treasury.ok, true);
  assert.equal(batch.checkpoint.ok, true);
  assert.equal(batch.checkpointVerify.ok, true);
  assert.equal(batch.relay.ok, true);
  assert.equal(batch.reconcile.ok, true);
  assert.equal(batch.promos.ok, true);
  assert.equal(touched.subscriptions, true);
  await store.close();
}

async function classifiesTheIsolatedFaultOnItsRetryVerdict(): Promise<void> {
  const { store, digest } = await seededStore();
  const recording = recordingStore(store, freshTouched(), {
    subscriptions: fault('LEDGER.UNBALANCED', 'terminal', { retryable: false }),
  });

  const batch = await runSweeps(
    recording,
    makeWorkerCtx({ digest }),
    sweepInput(),
  );

  assert.equal(batch.subscriptions.ok, false);
  assert.equal(
    batch.subscriptions.ok === false && batch.subscriptions.code,
    'LEDGER.UNBALANCED',
  );
  assert.equal(
    batch.subscriptions.ok === false && batch.subscriptions.retryable,
    false,
  );
  await store.close();
}

async function wrapsANonEconomyThrowAsRetryableStoreFailure(): Promise<void> {
  const { store, digest } = await seededStore();
  const recording = recordingStore(store, freshTouched(), {
    relay: new Error('raw boom'),
  });

  const batch = await runSweeps(
    recording,
    makeWorkerCtx({ digest }),
    sweepInput(),
  );

  assert.equal(batch.relay.ok, false);
  assert.equal(batch.relay.ok === false && batch.relay.code, 'STORE.FAILURE');
  assert.equal(batch.relay.ok === false && batch.relay.retryable, true);
  await store.close();
}

// --- createWorker composition root ------------------------------------------------

async function runOnceDrivesOneBatch(): Promise<void> {
  const { store, digest } = await seededStore();
  const worker = createWorker(store, makeWorkerCtx({ digest }));

  const run = await worker.runOnce(sweepInput());

  assert.equal(run.batch.payouts.ok, true);
  assert.equal(worker.start, undefined); // no scheduler injected
  await store.close();
}

async function startSchedulesTheBatchOnTheInjectedScheduler(): Promise<void> {
  const { store, digest } = await seededStore();
  let scheduled: { ms: number; task: () => Promise<void> } | null = null;
  let canceled = false;
  const scheduler: Scheduler = {
    every: (ms, task) => {
      scheduled = { ms, task };
      return () => {
        canceled = true;
      };
    },
  };
  const worker = createWorker(store, makeWorkerCtx({ digest }), scheduler);

  assert.notEqual(worker.start, undefined);
  const stop = worker.start!(5_000, sweepInput());
  assert.equal(scheduled!.ms, 5_000);
  await scheduled!.task();
  stop();
  assert.equal(canceled, true);
  await store.close();
}

async function skipsTheReconcileSweepWhenNoFeedIsConfigured(): Promise<void> {
  const { store, digest } = await seededStore();
  const ctx = makeWorkerCtx({ digest });

  // No feed and no windows: a host with no provider settlement report passes neither, and
  // the reconcile job reports a clean empty run instead of demanding a throwing stub.
  const batch = await runSweeps(
    store,
    ctx,
    sweepInput({ feed: undefined, windows: undefined }),
  );

  assert.deepEqual(batch.reconcile, {
    ok: true,
    summary: { reconciled: [], drifted: [], failed: [] },
  });
  await store.close();
}

async function skipsTheRelaySweepWhenNoDispatcherIsConfigured(): Promise<void> {
  const { store, digest } = await seededStore();
  // A relay run that actually happened would mark this event; a skipped run leaves it pending.
  await store.transaction((unit) =>
    unit.outbox.enqueue({
      id: 'obx_skip',
      event: {
        id: 'evt_skip',
        type: 'economy.sale.completed',
        version: 1,
        occurredAt: 0,
        subject: 'usr_buyer',
        data: {},
        audience: 'internal',
      },
      status: 'pending',
      attempts: 0,
      reason: null,
    }),
  );

  // An undefined `dispatcher` is the no-dispatcher deployment (see selectDispatcher in src/index.ts).
  const batch = await runSweeps(
    store,
    makeWorkerCtx({ digest }),
    sweepInput({ dispatcher: undefined }),
  );

  assert.equal(batch.relay.ok, true);
  assert.deepEqual(batch.relay.ok === true && batch.relay.summary, {
    relayed: [],
    failed: [],
    deadLettered: [],
  });
  assert.equal(batch.payouts.ok, true);
  assert.equal(batch.reconcile.ok, true);
  const pending = await store.outbox.claimBatch(10);
  assert.deepEqual(
    pending.map((m) => m.id),
    ['obx_skip'],
  );
  assert.equal(pending[0]?.attempts, 0);
  await store.close();
}

describe('Worker Composition Root', () => {
  test('invokes every sweep once', () => invokesEverySweep());
  test('reports every sweep under its name', () =>
    reportsEverySweepUnderItsName());
  test('skips the relay sweep cleanly when no dispatcher is configured', () =>
    skipsTheRelaySweepWhenNoDispatcherIsConfigured());
  test('skips the reconcile sweep cleanly when no feed is configured', () =>
    skipsTheReconcileSweepWhenNoFeedIsConfigured());

  test('isolates a thrown sweep from the batch', () =>
    isolatesAThrownSweepFromTheBatch());
  test('keeps the isolated fault code and its retryable flag', () =>
    classifiesTheIsolatedFaultOnItsRetryVerdict());
  test('wraps a raw thrown Error as a retryable STORE.FAILURE', () =>
    wrapsANonEconomyThrowAsRetryableStoreFailure());

  test('runOnce drives one batch', () => runOnceDrivesOneBatch());
  test('start schedules the batch on the injected scheduler', () =>
    startSchedulesTheBatchOnTheInjectedScheduler());
});
