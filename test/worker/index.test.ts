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

import type { SweepInput } from '#src/worker/index.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type {
  Digest,
  Dispatcher,
  Posting,
  Scheduler,
  Store,
} from '#src/ports.ts';

// Deterministic fake capabilities handed to every background job. Takes the same `digest`
// (hasher) the seed posting used, so the checkpoint job hashes the bytes recorded at seed time.
function workerCtx(digest: Digest): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

// Reconciliation source empty on both sides (processor and ledger): nothing to mismatch, so
// the reconcile job runs clean without a real processor record.
function emptyFeed(): ReconcileFeed {
  return { pull: async () => ({ processor: [], ledger: [] }) };
}

// Event dispatcher that discards everything. Never invoked (no event is queued); present only
// to complete the input object.
function nullDispatcher(): Dispatcher {
  return async () => {};
}

// Arguments the runner passes to every job: `now`, a per-pass `limit` for due-item scans,
// a `dispatcher` for event delivery, and `feed` plus `windows` for reconciliation. Override any
// field per test.
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

// Balanced posting: 500 credits from platform revenue to a user's spendable balance. Gives the
// ledger two real accounts so the checkpoint job has something to snapshot.
function seedPosting(): Posting {
  let amount = toAmount('CREDIT', 500n);
  return {
    txnId: 'txn_seed',
    legs: [credit(spendable('usr_a'), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}

// In-memory store with the seed posting committed, so checkpoint and treasury jobs read real
// accounts. Returns the store plus its hasher, for passing into the worker context.
async function seededStore(): Promise<{ store: Store; digest: Digest }> {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });
  await store.transaction((unit) => postEntry(unit.ledger, seedPosting()));
  return { store, digest };
}

// One boolean per job, flipped on the job's first store read; a test asserts all true to prove
// every job ran.
//
// Three jobs lack a distinct read to watch:
//   - checkpoint reads the same `ledger.heads` (per-account latest entries) as treasury, so it
//     can't be told apart there; tracked by its later `checkpoints.put` write instead.
//   - checkpointVerify is tracked by its `checkpoints.latest` read.
//   - reconcile is tracked on its feed (see `recordingFeed`), not in this store.
//   - feeSweep shares treasury's `ledger.heads` read, so it has no distinct flag in this
//     roll-up; it is asserted instead in treasury.test.ts.
type Touched = {
  payouts: boolean;
  subscriptions: boolean;
  treasury: boolean;
  checkpoint: boolean;
  checkpointVerify: boolean;
  relay: boolean;
  promos: boolean;
};

// Wrap a store so each job's first call flips its flag in `touched`, optionally throwing a
// supplied error from one chosen job. Shared by the "every job ran" and "throw is isolated" tests.
function recordingStore(
  store: Store,
  touched: Touched,
  faults?: Partial<Record<keyof Touched, Error>>,
): Store {
  let trip = (key: keyof Touched): void => {
    touched[key] = true;
    let error = faults?.[key];
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

// Wrap an async store method to run `before` (flips the flag, may throw) and only then call the
// real method. Running `before` first records the flag even when the real call returns empty.
function probe<TArgs extends unknown[], TResult>(
  method: (...args: TArgs) => Promise<TResult>,
  before: () => void,
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => {
    before();
    return method(...args);
  };
}

// Reconciliation source that flips its flag when pulled, so the reconcile job's run is observable
// like the store-backed jobs.
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
  let { store, digest } = await seededStore();
  let touched = freshTouched();
  let reconcileTouched = { reconcile: false };
  let recording = recordingStore(store, touched);

  await runSweeps(
    recording,
    workerCtx(digest),
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
  let { store, digest } = await seededStore();

  let batch = await runSweeps(store, workerCtx(digest), sweepInput());

  for (let name of [
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

// --- isolation: a thrown sweep lands in its own slot ------------------------------

async function isolatesAThrownSweepFromTheBatch(): Promise<void> {
  let { store, digest } = await seededStore();
  let touched = freshTouched();
  let recording = recordingStore(store, touched, {
    payouts: fault('STORE.FAILURE', 'sagas down', { retryable: true }),
  });

  let batch = await runSweeps(recording, workerCtx(digest), sweepInput());

  assert.equal(batch.payouts.ok, false);
  // The jobs that run after the failing one all completed and reported success.
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
  let { store, digest } = await seededStore();
  let recording = recordingStore(store, freshTouched(), {
    subscriptions: fault('LEDGER.UNBALANCED', 'terminal', { retryable: false }),
  });

  let batch = await runSweeps(recording, workerCtx(digest), sweepInput());

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
  let { store, digest } = await seededStore();
  let recording = recordingStore(store, freshTouched(), {
    relay: new Error('raw boom'),
  });

  let batch = await runSweeps(recording, workerCtx(digest), sweepInput());

  assert.equal(batch.relay.ok, false);
  assert.equal(batch.relay.ok === false && batch.relay.code, 'STORE.FAILURE');
  assert.equal(batch.relay.ok === false && batch.relay.retryable, true);
  await store.close();
}

// --- createWorker composition root ------------------------------------------------

async function runOnceDrivesOneBatch(): Promise<void> {
  let { store, digest } = await seededStore();
  let worker = createWorker(store, workerCtx(digest));

  let run = await worker.runOnce(sweepInput());

  assert.equal(run.batch.payouts.ok, true);
  assert.equal(worker.start, undefined); // no scheduler injected
  await store.close();
}

async function startSchedulesTheBatchOnTheInjectedScheduler(): Promise<void> {
  let { store, digest } = await seededStore();
  let scheduled: { ms: number; task: () => Promise<void> } | null = null;
  let canceled = false;
  let scheduler: Scheduler = {
    every: (ms, task) => {
      scheduled = { ms, task };
      return () => {
        canceled = true;
      };
    },
  };
  let worker = createWorker(store, workerCtx(digest), scheduler);

  assert.notEqual(worker.start, undefined);
  let stop = worker.start!(5_000, sweepInput());
  // start registered the interval with the scheduler and got back a cancel function.
  assert.equal(scheduled!.ms, 5_000);
  // Running the registered task once executes a full batch of every job without throwing.
  await scheduled!.task();
  stop();
  assert.equal(canceled, true);
  await store.close();
}

// No dispatcher: relay sweep skips cleanly. Reports success with an empty summary, never touches
// the outbox, leaves pending events queued for a later run.
async function skipsTheRelaySweepWhenNoDispatcherIsConfigured(): Promise<void> {
  let { store, digest } = await seededStore();
  // Queue one event: a relay run that happened would deliver and mark it (changing the outbox);
  // a skipped run leaves it pending and untouched.
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

  // dispatcher: undefined is the no-dispatcher deployment (see selectDispatcher in src/index.ts).
  let batch = await runSweeps(
    store,
    workerCtx(digest),
    sweepInput({ dispatcher: undefined }),
  );

  // The relay slot is a clean success carrying the empty summary, not a caught error.
  assert.equal(batch.relay.ok, true);
  assert.deepEqual(batch.relay.ok === true && batch.relay.summary, {
    relayed: [],
    failed: [],
    deadLettered: [],
  });
  // Every other sweep still ran.
  assert.equal(batch.payouts.ok, true);
  assert.equal(batch.reconcile.ok, true);
  // The queued event was not dropped: it is still pending and claimable by a future run.
  let pending = await store.outbox.claimBatch(10);
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
