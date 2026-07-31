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

import { advanceDuePayouts } from '#src/worker/payouts.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { credit, sagaAnchor, usd } from '#test/support/builders.ts';
import {
  fixedClock,
  makeWorkerCtx,
  testConfig,
} from '#test/support/capabilities.ts';
import { seededDigest } from '#test/support/capabilities.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { Config } from '#src/config.ts';
import type {
  CallOptions,
  PayoutProviderStatus,
  Processor,
  Saga,
  Store,
  Unit,
} from '#src/ports.ts';

// The matching half goes to STORED_VALUE, which may go negative and is never read here, so
// seeding trips no overdraft check and leaves REVENUE alone.
async function fund(
  unit: Unit,
  account: AccountRef,
  amount: Amount,
  options?: CallOptions,
): Promise<void> {
  await postEntry(
    unit.ledger,
    {
      txnId: 'txn_seed',
      legs: [creditLeg(account, amount), debit(SYSTEM.STORED_VALUE, amount)],
      meta: { kind: 'test.fund' },
    },
    options,
  );
}

// A payout record as the request handler leaves it; defaults fill what a case doesn't state.
// The default quote is the fixed payout rate's pricing of the 20000.00 reserve.
function saga(overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>): Saga {
  return {
    userId: 'usr_seller',
    reserve: credit('20000.00'),
    rateId: 'payout:CREDIT->USD:1',
    txnId: `txn_anchor_${overrides.id}`,
    // A payout reaches SUBMITTED only by being handed to the rail, and the rail answers with its
    // own reference, so that is the state a row carries one in. A SUBMITTED row without one is
    // the hand-off whose answer was lost, and the sweep treats it as unfinished.
    providerRef:
      overrides.state === 'SUBMITTED' ? `prov_${overrides.id}` : null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: usd('100.00'),
    ...overrides,
  };
}

// From RESERVED onward, funds earned and posts the row's anchor (see sagaAnchor); every
// money-moving step re-proves the row against it before acting.
async function openSaga(store: Store, row: Saga): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    if (row.state === 'RESERVED' || row.state === 'SUBMITTED') {
      await fund(unit, earned(row.userId), row.reserve);
      await unit.ledger.append(sagaAnchor(row));
    }
  });
}

function failingProcessor(): Processor {
  return {
    submitPayout: async () => {
      throw fault(ERROR_CODES.PROVIDER_FAILURE, 'provider down', {
        retryable: true,
      });
    },
  };
}

function probingProcessor(
  answer: PayoutProviderStatus['state'] | 'throw',
  asked: string[] = [],
): Processor {
  return {
    submitPayout: async (input) => ({ providerRef: `prov_${input.key}` }),
    payoutStatus: async (input) => {
      asked.push(input.providerRef);
      if (answer === 'throw') {
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'status endpoint down', {
          retryable: true,
        });
      }
      return { state: answer };
    },
  };
}

// --- The cases (one behavior each) ---

async function submitsAReservedSagaToTheProvider(store: Store): Promise<void> {
  const recorded: Array<{ key: string; userId: string; amount: Amount }> = [];
  const processor: Processor = {
    submitPayout: async (input) => {
      recorded.push(input);
      return { providerRef: `prov_${input.key}` };
    },
  };
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'RESERVED', reserve: credit('20000.00') }),
  );

  const summary = await advanceDuePayouts(store, makeWorkerCtx({ processor }), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.submitted, ['pay_1']);
  // The provider is paid USD: the reserved credits at the payout rate, rounded down.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.key, 'pay_1');
  assert.deepEqual(recorded[0]!.amount, usd('100.00'));
  // Submitting posts nothing; the credits moved into the reserve at request time.
  const advanced = await store.sagas.load('pay_1');
  assert.equal(advanced!.state, 'SUBMITTED');
  assert.equal(advanced!.providerRef, 'prov_pay_1');
}

async function leavesAWithinWindowSubmittedSagaForTheWebhook(
  store: Store,
): Promise<void> {
  // The worker never self-settles: settlement arrives via the provider webhook
  // (src/operations/settlePayout.ts), so a within-window SUBMITTED saga is left untouched.
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('20000.00') }),
  );

  const summary = await advanceDuePayouts(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.submitted, []);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
  assert.deepEqual(await store.ledger.balance(SYSTEM.TRUST_CASH), usd('0.00'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.USD_CLEARING),
    usd('0.00'),
  );
  const stillSubmitted = await store.sagas.load('pay_1');
  assert.equal(stillSubmitted!.state, 'SUBMITTED');
}

async function forceFailsASubmittedSagaPastTheMaxAgeAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  // updatedAt 0 with a one-minute cap, swept two minutes later: past the cap, the age check
  // force-fails the saga. dueAt in the past keeps it selected.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ config, clock: fixedClock(120_000) }),
    { now: 120_000, limit: 10 },
  );

  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.id, 'pay_1');
  assert.equal(summary.deadLettered[0]!.reason, 'payout.timeout');
  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  // The terminal reason persists on the saga row itself, where the console reads it.
  assert.equal(failed!.reason, 'payout.timeout');
  assert.deepEqual(failed!.payoutUsd, usd('100.00'));
  // The reversal posts in the same transaction as the FAILED flip, so a timed-out payout never
  // strands the escrowed reserve.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.TRUST_CASH), usd('0.00'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.USD_CLEARING),
    usd('0.00'),
  );
}

async function metersTheAgeGaugeAndTheDeadLetterCounter(
  store: Store,
): Promise<void> {
  const counts: Array<{ name: string; tags?: Record<string, string> }> = [];
  const ages: Array<{ value: number; tags?: Record<string, string> }> = [];
  const meter = {
    count: (name: string, _n: number, tags?: Record<string, string>) => {
      counts.push({ name, tags });
    },
    observe: (name: string, value: number, tags?: Record<string, string>) => {
      if (name === 'worker.payouts.saga_age_ms') ages.push({ value, tags });
    },
  };
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  await advanceDuePayouts(
    store,
    makeWorkerCtx({ config, clock: fixedClock(120_000), meter }),
    { now: 120_000, limit: 10 },
  );

  // The gauge reports time in the current state for every claimed saga.
  assert.deepEqual(ages, [{ value: 120_000, tags: { state: 'SUBMITTED' } }]);
  assert.deepEqual(counts, [
    {
      name: 'worker.payouts.dead_lettered',
      tags: { reason: 'payout.timeout' },
    },
  ]);
}

async function deadLettersEvenWhenTheLoggerThrows(store: Store): Promise<void> {
  // A logger is observability, not a participant: its failure must neither roll back the
  // reversal (the log call sits after the transaction) nor report the item as unfinished.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  const logger = {
    log: () => {
      throw new Error('log sink down');
    },
  };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ config, clock: fixedClock(120_000), logger }),
    { now: 120_000, limit: 10 },
  );

  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.reason, 'payout.timeout');
  assert.deepEqual(summary.retrying, []);
  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
}

async function leavesASubmittedSagaAtTheAgeBoundaryForTheWebhook(
  store: Store,
): Promise<void> {
  // At exactly the cap the boundary is inclusive: only a strictly-past-cap age force-fails.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ config, clock: fixedClock(60_000) }),
    { now: 60_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.submitted, []);
  const stillSubmitted = await store.sagas.load('pay_1');
  assert.equal(stillSubmitted!.state, 'SUBMITTED');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
}

// The attempt ceiling used to end a payout here, returning the reserve on the strength of a
// thrown submit — which says nothing about whether the rail moved the money. Reaching the ceiling
// now only stops the sweep re-asking; the settlement window is what ends the payout.
async function keepsTheReserveAtTheAttemptCeiling(store: Store): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'RESERVED',
      attempts: 0,
      reserve: credit('20000.00'),
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: failingProcessor(),
      config,
      clock: fixedClock(1_000),
    }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.submitted, []);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, [
    { id: 'pay_1', code: 'PROVIDER.FAILURE' },
  ]);
  const held = await store.sagas.load('pay_1');
  assert.equal(held!.state, 'SUBMITTED');
  assert.equal(held!.attempts, 1);
  assert.equal(held!.providerRef, null);
  assert.deepEqual(held!.payoutUsd, usd('100.00'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
}

async function leavesARetryableFaultForTheNextSweep(
  store: Store,
): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAttempts: 5 };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: failingProcessor(),
      config,
      clock: fixedClock(1_000),
    }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  assert.equal(summary.retrying.length, 1);
  assert.equal(summary.retrying[0]!.id, 'pay_1');
  assert.equal(summary.retrying[0]!.code, 'PROVIDER.FAILURE');
  const pending = await store.sagas.load('pay_1');
  assert.equal(pending!.state, 'SUBMITTED');
  assert.equal(pending!.attempts, 1);
}

// Regression: a failed submit once never raised the attempt count, so a downed provider
// retried forever and stranded the seller's reserve. The count still climbs, and the reserve
// still comes back — now on the settlement window rather than the count.
async function climbsAttemptsEachRunThenTimesOutAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  // Three SLA ticks of 120s fit inside a 300s window; the fourth is past it.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 300_000 };
  const ctx = (at: number) =>
    makeWorkerCtx({
      processor: failingProcessor(),
      config,
      clock: fixedClock(at),
    });
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));
  const sla = testConfig().payoutSla.SUBMITTED!;

  // Each failed hand-off reschedules one SLA ahead, so the sweeps step on that cadence.
  const climbed: number[] = [];
  for (const step of [0, 1, 2]) {
    const at = 1_000 + step * sla;
    const run = await advanceDuePayouts(store, ctx(at), { now: at, limit: 10 });
    assert.equal(run.retrying.length, 1, `sweep ${step}`);
    assert.deepEqual(run.deadLettered, [], `sweep ${step}`);
    climbed.push((await store.sagas.load('pay_1'))!.attempts);
    // The reserve is untouched while the outcome is unknown.
    assert.deepEqual(
      await store.ledger.balance(earned('usr_seller')),
      credit('0.00'),
      `sweep ${step}`,
    );
  }
  assert.deepEqual(climbed, [1, 2, 3]);

  const at = 1_000 + 3 * sla;
  const timed = await advanceDuePayouts(store, ctx(at), { now: at, limit: 10 });
  assert.deepEqual(timed.deadLettered, [
    { id: 'pay_1', reason: 'payout.timeout' },
  ]);

  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
}

async function isolatesAPerItemFaultAndContinuesTheBatch(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  const config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(store, saga({ id: 'pay_bad', state: 'RESERVED' }));
  await openSaga(store, saga({ id: 'pay_good', state: 'RESERVED' }));

  const processor: Processor = {
    submitPayout: async (input) => {
      if (input.key === 'pay_bad') {
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'provider down', {
          retryable: true,
        });
      }
      return { providerRef: `prov_${input.key}` };
    },
  };

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, config }),
    {
      now: 1_000,
      limit: 10,
    },
  );

  assert.deepEqual(summary.submitted, ['pay_good']);
  assert.deepEqual(
    summary.retrying.map((r) => r.id),
    ['pay_bad'],
  );
  assert.deepEqual(summary.deadLettered, []);
  await store.close();
}

async function deadLetteringEmitsOnePayoutReversedEvent(
  store: Store,
): Promise<void> {
  // Driven through the timeout, which is the path that ends a payout the rail never settled.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      attempts: 0,
      reserve: credit('20000.00'),
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  await advanceDuePayouts(
    store,
    makeWorkerCtx({ config, clock: fixedClock(120_000) }),
    { now: 120_000, limit: 10 },
  );

  // The reversed event is enqueued in the same transaction as the reversal entry.
  const messages = await store.outbox.claimBatch(10);
  const reversed = messages.filter(
    (m) => m.event.type === 'economy.payout.reversed',
  );
  assert.equal(reversed.length, 1);
  const event = reversed[0]!.event;
  assert.equal(event.audience, 'internal');
  assert.equal(event.subject, 'usr_seller');
  assert.equal(event.data.sagaId, 'pay_1');
  assert.equal(event.data.reason, 'payout.timeout');
}

async function reversesPromptlyWhenTheProviderReportsFailure(
  store: Store,
): Promise<void> {
  // Well inside maxPayoutAgeMs, where the sweep would otherwise only wait: the probe's FAILED
  // answer releases the reserve this run instead of after the timeout.
  const asked: string[] = [];
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      providerRef: 'prov_pay_1',
      updatedAt: 1_000,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: probingProcessor('FAILED', asked),
      clock: fixedClock(1_000),
    }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(asked, ['prov_pay_1']);
  assert.deepEqual(summary.deadLettered, [
    { id: 'pay_1', reason: 'payout.provider_failed' },
  ]);
  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  assert.equal(failed!.reason, 'payout.provider_failed');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
}

async function reversesPromptlyWhenTheProviderReportsAReturn(
  store: Store,
): Promise<void> {
  // A RETURNED disbursement (sent, then bounced back to the rail) releases the reserve the same
  // way, under its own stable reason so dashboards can tell the two apart.
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      providerRef: 'prov_pay_1',
      updatedAt: 1_000,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: probingProcessor('RETURNED'),
      clock: fixedClock(1_000),
    }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, [
    { id: 'pay_1', reason: 'payout.provider_returned' },
  ]);
  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.reason, 'payout.provider_returned');
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
}

async function neverForceFailsAPayoutTheProviderReportsSettled(
  store: Store,
): Promise<void> {
  // Past maxPayoutAgeMs a force-fail would return the reserve on top of USD the provider says it
  // disbursed — a double-pay. SETTLED blocks the force-fail and leaves settlement to the webhook.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      providerRef: 'prov_pay_1',
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: probingProcessor('SETTLED'),
      config,
      clock: fixedClock(120_000),
    }),
    { now: 120_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  const held = await store.sagas.load('pay_1');
  assert.equal(held!.state, 'SUBMITTED');
  // The next look is rescheduled one SUBMITTED-SLA ahead; the timeout base is left alone.
  assert.equal(held!.dueAt, 120_000 + testConfig().payoutSla.SUBMITTED!);
  assert.equal(held!.updatedAt, 0);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
}

async function defersTheTimeoutWhileTheProviderReportsPending(
  store: Store,
): Promise<void> {
  // PENDING past the cap risks the same double-pay, so the sweep defers the timeout by
  // refreshing updatedAt, its measuring point.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      providerRef: 'prov_pay_1',
      updatedAt: 0,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: probingProcessor('PENDING'),
      config,
      clock: fixedClock(120_000),
    }),
    { now: 120_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  const deferred = await store.sagas.load('pay_1');
  assert.equal(deferred!.state, 'SUBMITTED');
  assert.equal(deferred!.updatedAt, 120_000);
  assert.equal(deferred!.dueAt, 120_000 + testConfig().payoutSla.SUBMITTED!);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function probesOnTheSlaCadenceWhilePendingWithinTheWindow(
  store: Store,
): Promise<void> {
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'SUBMITTED',
      reserve: credit('20000.00'),
      providerRef: 'prov_pay_1',
      updatedAt: 1_000,
      dueAt: 0,
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: probingProcessor('PENDING'),
      clock: fixedClock(1_000),
    }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  const watched = await store.sagas.load('pay_1');
  assert.equal(watched!.state, 'SUBMITTED');
  assert.equal(watched!.updatedAt, 1_000);
  assert.equal(watched!.dueAt, 1_000 + testConfig().payoutSla.SUBMITTED!);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function fallsBackToTheTimeoutWhenTheProbeCannotAnswer(): Promise<void> {
  // UNKNOWN and a probe fault are both "no evidence": the timeout stands as if there were no
  // probe, and the fault is not counted against the saga.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  for (const answer of ['UNKNOWN', 'throw'] as const) {
    const scoped = memoryStore({ digest: seededDigest(1) });
    await openSaga(
      scoped,
      saga({
        id: 'pay_1',
        state: 'SUBMITTED',
        reserve: credit('20000.00'),
        providerRef: 'prov_pay_1',
        updatedAt: 0,
        dueAt: 0,
      }),
    );

    const summary = await advanceDuePayouts(
      scoped,
      makeWorkerCtx({
        processor: probingProcessor(answer),
        config,
        clock: fixedClock(120_000),
      }),
      { now: 120_000, limit: 10 },
    );

    assert.deepEqual(
      summary.deadLettered,
      [{ id: 'pay_1', reason: 'payout.timeout' }],
      `answer ${answer}`,
    );
    assert.deepEqual(summary.retrying, [], `answer ${answer}`);
    assert.deepEqual(
      await scoped.ledger.balance(earned('usr_seller')),
      credit('20000.00'),
      `answer ${answer}`,
    );
  }
}

describe('advanceDuePayouts', () => {
  test('submits a reserved saga to the provider as USD with no ledger posting', () =>
    submitsAReservedSagaToTheProvider(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('leaves a within-window submitted saga untouched for the settlement webhook', () =>
    leavesAWithinWindowSubmittedSagaForTheWebhook(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('force-fails a submitted saga past the max age and returns the reserve', () =>
    forceFailsASubmittedSagaPastTheMaxAgeAndReturnsTheReserve(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('dead-letters a timed-out payout even when the logger throws', () =>
    deadLettersEvenWhenTheLoggerThrows(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('meters the saga-age gauge and the dead-letter counter', () =>
    metersTheAgeGaugeAndTheDeadLetterCounter(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('leaves a submitted saga at the age boundary untouched for the settlement webhook', () =>
    leavesASubmittedSagaAtTheAgeBoundaryForTheWebhook(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('keeps the reserve at the attempt ceiling, where a thrown submit proves nothing', () =>
    keepsTheReserveAtTheAttemptCeiling(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('leaves a retryable fault for the next run', () =>
    leavesARetryableFaultForTheNextSweep(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('climbs the attempt count each run, then times out a stuck payout and returns the reserve', () =>
    climbsAttemptsEachRunThenTimesOutAndReturnsTheReserve(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('isolates a per-item fault and continues the batch', () =>
    isolatesAPerItemFaultAndContinuesTheBatch());
  test('a dead-lettered payout holds one economy.payout.reversed event with the reason', () =>
    deadLetteringEmitsOnePayoutReversedEvent(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('reverses promptly when the provider reports a submitted payout failed', () =>
    reversesPromptlyWhenTheProviderReportsFailure(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('reverses promptly under its own reason when the provider reports a return', () =>
    reversesPromptlyWhenTheProviderReportsAReturn(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('never force-fails a payout the provider reports settled, even past the max age', () =>
    neverForceFailsAPayoutTheProviderReportsSettled(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('defers the timeout while the provider still reports the payout pending', () =>
    defersTheTimeoutWhileTheProviderReportsPending(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('probes on the SLA cadence while the provider reports pending within the window', () =>
    probesOnTheSlaCadenceWhilePendingWithinTheWindow(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('falls back to the timeout when the probe answers unknown or fails', () =>
    fallsBackToTheTimeoutWhenTheProbeCannotAnswer());
});

// A rail that disburses before it answers, then loses the response on its first call. The USD is
// gone and the caller learns nothing, which is the one case a thrown error cannot distinguish from
// "nothing happened". A second call under the same idempotency key is the retry the port documents
// as safe: it reports the same reference and disburses nothing further.
function railThatLosesItsFirstResponse(
  disbursed: string[],
  asked: string[],
  answer: PayoutProviderStatus['state'] = 'SETTLED',
): Processor {
  let calls = 0;
  return {
    submitPayout: async (input) => {
      calls += 1;
      if (!disbursed.includes(input.key)) {
        disbursed.push(input.key);
      }
      if (calls === 1) {
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'response lost', {
          retryable: true,
        });
      }
      return { providerRef: `prov_${input.key}` };
    },
    payoutStatus: async (input) => {
      asked.push(input.providerRef);
      return { state: answer };
    },
  };
}

async function keepsTheReserveWhenTheSubmitResponseIsLost(
  store: Store,
): Promise<void> {
  const disbursed: string[] = [];
  const asked: string[] = [];
  const config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({
      processor: railThatLosesItsFirstResponse(disbursed, asked),
      config,
      clock: fixedClock(1_000),
    }),
    { now: 1_000, limit: 10 },
  );

  // The USD left the platform, so returning the reserve now pays the seller twice.
  assert.deepEqual(disbursed, ['pay_1']);
  assert.deepEqual(summary.deadLettered, []);
  const held = await store.sagas.load('pay_1');
  assert.equal(held!.state, 'SUBMITTED');
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function recoversTheProviderRefUnderTheSameKey(
  store: Store,
): Promise<void> {
  const disbursed: string[] = [];
  const asked: string[] = [];
  const processor = railThatLosesItsFirstResponse(disbursed, asked);
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));
  const sla = testConfig().payoutSla.SUBMITTED!;

  const run1 = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000) }),
    { now: 1_000, limit: 10 },
  );
  assert.deepEqual(run1.retrying, [{ id: 'pay_1', code: 'PROVIDER.FAILURE' }]);
  assert.equal((await store.sagas.load('pay_1'))!.providerRef, null);

  // The lost reference is what the probe joins on, so recovering it is what makes the evidence
  // path reachable at all.
  const run2 = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000 + sla) }),
    { now: 1_000 + sla, limit: 10 },
  );
  assert.deepEqual(run2.submitted, ['pay_1']);
  assert.equal((await store.sagas.load('pay_1'))!.providerRef, 'prov_pay_1');

  const run3 = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000 + 2 * sla) }),
    { now: 1_000 + 2 * sla, limit: 10 },
  );
  assert.deepEqual(run3.deadLettered, []);

  assert.deepEqual(disbursed, ['pay_1']);
  assert.deepEqual(asked, ['prov_pay_1']);
  const held = await store.sagas.load('pay_1');
  assert.equal(held!.state, 'SUBMITTED');
  // The age clock still runs from the hand-off, so a rail that never settles still times out.
  assert.equal(held!.updatedAt, 1_000);
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
}

async function stillReturnsTheReserveAtTheTimeout(store: Store): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  const ctx = (at: number) =>
    makeWorkerCtx({
      processor: failingProcessor(),
      config,
      clock: fixedClock(at),
    });
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));
  const sla = testConfig().payoutSla.SUBMITTED!;

  await advanceDuePayouts(store, ctx(1_000), { now: 1_000, limit: 10 });
  const later = 1_000 + sla;
  const timed = await advanceDuePayouts(store, ctx(later), {
    now: later,
    limit: 10,
  });

  // A rail that never answers must not strand the reserve: the settlement window bounds it.
  assert.deepEqual(timed.deadLettered, [
    { id: 'pay_1', reason: 'payout.timeout' },
  ]);
  assert.equal((await store.sagas.load('pay_1'))!.state, 'FAILED');
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
}

describe('advanceDuePayouts Lost Submit Response', () => {
  test('keeps the reserve when the submit response is lost after the rail disbursed', () =>
    keepsTheReserveWhenTheSubmitResponseIsLost(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('recovers the provider reference on a later sweep under the same key', () =>
    recoversTheProviderRefUnderTheSameKey(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('still returns the reserve at the timeout when the rail never answers', () =>
    stillReturnsTheReserveAtTheTimeout(
      memoryStore({ digest: seededDigest(1) }),
    ));
});

// The fault shape @pwngh/economy-edge throws — a namespaced code and a retry verdict assigned
// onto a plain Error — built by hand so this file stays free of the edge package. A verdict of
// false is the rail refusing outright: this disbursement is never going to happen.
function railRefusal(code: string, retryable: boolean): Error {
  return Object.assign(new Error(`the rail refused: ${code}`), {
    code,
    retryable,
    detail: {},
  });
}

async function failsANonRetryableRefusalOnTheFirstHandOff(
  store: Store,
): Promise<void> {
  let railCalls = 0;
  const processor: Processor = {
    submitPayout: async () => {
      railCalls += 1;
      throw railRefusal('TILIA.AUTH_REJECTED', false);
    },
  };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000) }),
    { now: 1_000, limit: 10 },
  );

  // One call, one answer: the refusal ends the payout this sweep, not five calls and a
  // settlement window later.
  assert.equal(railCalls, 1);
  assert.deepEqual(summary.deadLettered, [
    { id: 'pay_1', reason: 'PROVIDER.FAILURE' },
  ]);
  assert.deepEqual(summary.retrying, []);
  assert.deepEqual(summary.submitted, []);
  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  assert.equal(failed!.reason, 'PROVIDER.FAILURE');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );

  // Dead is dead: the next sweep neither re-claims the saga nor calls the rail again.
  const sla = testConfig().payoutSla.SUBMITTED!;
  const next = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000 + sla) }),
    { now: 1_000 + sla, limit: 10 },
  );
  assert.equal(railCalls, 1);
  assert.deepEqual(next.deadLettered, []);
}

async function failsARefusalTheAdapterClassifiedItself(
  store: Store,
): Promise<void> {
  // The shape edgeTiliaProcessor throws for a resolved rejection: an EconomyError whose
  // retryable defaulted to false. It passes through normalization unchanged, so the verdict
  // arrives here whichever side classified it.
  const processor: Processor = {
    submitPayout: async () => {
      throw fault(
        ERROR_CODES.PROVIDER_FAILURE,
        'The payout rail rejected the submit.',
      );
    },
  };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000) }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, [
    { id: 'pay_1', reason: 'PROVIDER.FAILURE' },
  ]);
  assert.deepEqual(summary.retrying, []);
  assert.equal((await store.sagas.load('pay_1'))!.state, 'FAILED');
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('20000.00'),
  );
}

async function retriesARetryableRefusalTheFullAttemptBudget(
  store: Store,
): Promise<void> {
  // The direction that loses money if over-corrected: a retryable refusal (rate limit, brief
  // outage) keeps every attempt the budget grants, and the reserve stays put throughout.
  let railCalls = 0;
  const processor: Processor = {
    submitPayout: async () => {
      railCalls += 1;
      throw railRefusal('TILIA.RATE_LIMITED', true);
    },
  };
  const config: Config = { ...testConfig(), maxPayoutAttempts: 5 };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));
  const sla = testConfig().payoutSla.SUBMITTED!;

  for (const step of [0, 1, 2, 3, 4]) {
    const at = 1_000 + step * sla;
    const run = await advanceDuePayouts(
      store,
      makeWorkerCtx({ processor, config, clock: fixedClock(at) }),
      { now: at, limit: 10 },
    );
    assert.deepEqual(run.deadLettered, [], `sweep ${step}`);
    assert.deepEqual(
      run.retrying,
      [{ id: 'pay_1', code: 'PROVIDER.FAILURE' }],
      `sweep ${step}`,
    );
  }
  assert.equal(railCalls, 5);

  // Past the budget the sweep stops asking; the settlement window owns the payout from here.
  const at = 1_000 + 5 * sla;
  const run = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, config, clock: fixedClock(at) }),
    { now: at, limit: 10 },
  );
  assert.equal(railCalls, 5);
  assert.deepEqual(run.deadLettered, []);
  const held = await store.sagas.load('pay_1');
  assert.equal(held!.state, 'SUBMITTED');
  assert.equal(held!.attempts, 5);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
}

async function keepsTheSubmittedProtocolForAThrowCarryingNoVerdict(
  store: Store,
): Promise<void> {
  // A dropped connection mid-call: the transfer may have happened, so the refusal path must not
  // fire — the SUBMITTED protocol (probe, webhook, timeout) owns the outcome.
  const processor: Processor = {
    submitPayout: async () => {
      throw new Error('connection reset mid-call');
    },
  };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, clock: fixedClock(1_000) }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, [
    { id: 'pay_1', code: 'PROVIDER.FAILURE' },
  ]);
  const held = await store.sagas.load('pay_1');
  assert.equal(held!.state, 'SUBMITTED');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
}

async function logsTheHandOffFailureUnderTheRailsCode(
  store: Store,
): Promise<void> {
  // The rail failed, so the line an operator greps must page the rail's owner: PROVIDER.FAILURE,
  // never the STORE.FAILURE that sends them to a healthy database.
  const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const logger = {
    log: (
      _level: string,
      message: string,
      fields?: Record<string, unknown>,
    ) => {
      lines.push({ message, fields: fields ?? {} });
    },
  };
  const processor: Processor = {
    submitPayout: async () => {
      throw new Error('connection reset mid-call');
    },
  };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor, logger, clock: fixedClock(1_000) }),
    { now: 1_000, limit: 10 },
  );

  const unresolved = lines.filter(
    (line) => line.message === 'worker.payouts.handoff_unresolved',
  );
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]!.fields.code, 'PROVIDER.FAILURE');
}

describe('advanceDuePayouts Classified Rail Refusal', () => {
  test('fails a non-retryable rail refusal on the first hand-off and returns the reserve', () =>
    failsANonRetryableRefusalOnTheFirstHandOff(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('fails a refusal the adapter classified itself as a non-retryable fault', () =>
    failsARefusalTheAdapterClassifiedItself(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('retries a retryable refusal for the full attempt budget and keeps the reserve', () =>
    retriesARetryableRefusalTheFullAttemptBudget(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('keeps the submitted protocol for a throw carrying no verdict', () =>
    keepsTheSubmittedProtocolForAThrowCarryingNoVerdict(
      memoryStore({ digest: seededDigest(1) }),
    ));
  test('logs a hand-off failure under the rail-facing code, not the store one', () =>
    logsTheHandOffFailureUnderTheRailsCode(
      memoryStore({ digest: seededDigest(1) }),
    ));
});

describe('advanceDuePayouts Pricing At Request', () => {
  test('submits the stored quote, not a re-fetched rate', async () => {
    const store = memoryStore({ digest: seededDigest(1) });
    const recorded: Array<{ key: string; userId: string; amount: Amount }> = [];
    const processor: Processor = {
      submitPayout: async (input) => {
        recorded.push(input);
        return { providerRef: `prov_${input.key}` };
      },
    };
    await openSaga(
      store,
      saga({
        id: 'pay_quote',
        state: 'RESERVED',
        reserve: credit('20000.00'),
        payoutUsd: usd('90.00'),
      }),
    );

    await advanceDuePayouts(store, makeWorkerCtx({ processor }), {
      now: 1_000,
      limit: 10,
    });

    // The current rate would price the reserve at $100.00; the stored quote wins.
    assert.deepEqual(recorded[0]!.amount, usd('90.00'));
  });
});
