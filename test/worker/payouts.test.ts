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
import { credit, usd } from '#test/support/builders.ts';
import {
  fixedClock,
  makeWorkerCtx,
  testConfig,
} from '#test/support/capabilities.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { Config } from '#src/config.ts';
import type {
  Options,
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
  options?: Options,
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
function saga(overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>): Saga {
  return {
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
    ...overrides,
  };
}

// From RESERVED onward, seeds PAYOUT_RESERVE as requestPayout would, so a settle or
// dead-letter step can debit it without overdrawing the guarded reserve.
async function openSaga(store: Store, row: Saga): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    if (row.state === 'RESERVED' || row.state === 'SUBMITTED') {
      await fund(unit, SYSTEM.PAYOUT_RESERVE, row.reserve);
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
    saga({ id: 'pay_1', state: 'RESERVED', reserve: credit('4.00') }),
  );

  const summary = await advanceDuePayouts(store, makeWorkerCtx({ processor }), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.submitted, ['pay_1']);
  // The provider is paid USD: the reserved credits at the payout rate, rounded down.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.key, 'pay_1');
  assert.deepEqual(recorded[0]!.amount, usd('0.02'));
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
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
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
    credit('4.00'),
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
      reserve: credit('4.00'),
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
  assert.equal(failed!.payoutUsd, null);
  // The reversal posts in the same transaction as the FAILED flip, so a timed-out payout never
  // strands the escrowed reserve.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('4.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.TRUST_CASH), usd('0.00'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.USD_CLEARING),
    usd('0.00'),
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
      reserve: credit('4.00'),
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
    credit('4.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
}

async function deadLettersAProviderFaultPastTheAttemptCeiling(
  store: Store,
): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'RESERVED',
      attempts: 0,
      reserve: credit('4.00'),
    }),
  );

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor: failingProcessor(), config }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.submitted, []);
  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.id, 'pay_1');
  assert.equal(summary.deadLettered[0]!.reason, 'PROVIDER.FAILURE');
  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  assert.equal(failed!.reason, 'PROVIDER.FAILURE');
  assert.equal(failed!.payoutUsd, null);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('4.00'),
  );
}

async function leavesARetryableFaultUnderTheCeilingForTheNextSweep(
  store: Store,
): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAttempts: 5 };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  const summary = await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor: failingProcessor(), config }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  assert.equal(summary.retrying.length, 1);
  assert.equal(summary.retrying[0]!.id, 'pay_1');
  assert.equal(summary.retrying[0]!.code, 'PROVIDER.FAILURE');
  const pending = await store.sagas.load('pay_1');
  assert.equal(pending!.state, 'RESERVED');
  assert.equal(pending!.attempts, 1);
}

// Regression: a failed submit once never raised the attempt count, so a downed provider
// retried forever and stranded the seller's reserve.
async function climbsAttemptsEachRunThenDeadLettersAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAttempts: 3 };
  const ctx = makeWorkerCtx({ processor: failingProcessor(), config });
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  // dueAt is unchanged, so every run re-selects the saga.
  const run1 = await advanceDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.equal(run1.retrying.length, 1);
  assert.equal((await store.sagas.load('pay_1'))!.attempts, 1);

  const run2 = await advanceDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.equal(run2.retrying.length, 1);
  assert.equal((await store.sagas.load('pay_1'))!.attempts, 2);

  const run3 = await advanceDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.deepEqual(run3.retrying, []);
  assert.equal(run3.deadLettered.length, 1);
  assert.equal(run3.deadLettered[0]!.id, 'pay_1');

  const failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('4.00'),
  );
}

async function isolatesAPerItemFaultAndContinuesTheBatch(): Promise<void> {
  const store = memoryStore();
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
    summary.deadLettered.map((d) => d.id),
    ['pay_bad'],
  );
  await store.close();
}

async function deadLetteringEmitsOnePayoutReversedEvent(
  store: Store,
): Promise<void> {
  const config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'RESERVED',
      attempts: 0,
      reserve: credit('4.00'),
    }),
  );

  await advanceDuePayouts(
    store,
    makeWorkerCtx({ processor: failingProcessor(), config }),
    { now: 1_000, limit: 10 },
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
  assert.equal(event.data.reason, 'PROVIDER.FAILURE');
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
      reserve: credit('4.00'),
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
    credit('4.00'),
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
      reserve: credit('4.00'),
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
    credit('4.00'),
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
      reserve: credit('4.00'),
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
    credit('4.00'),
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
      reserve: credit('4.00'),
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
    credit('4.00'),
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
      reserve: credit('4.00'),
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
    credit('4.00'),
  );
}

async function fallsBackToTheTimeoutWhenTheProbeCannotAnswer(): Promise<void> {
  // UNKNOWN and a probe fault are both "no evidence": the timeout stands as if there were no
  // probe, and the fault is not counted against the saga.
  const config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
  for (const answer of ['UNKNOWN', 'throw'] as const) {
    const scoped = memoryStore();
    await openSaga(
      scoped,
      saga({
        id: 'pay_1',
        state: 'SUBMITTED',
        reserve: credit('4.00'),
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
      credit('4.00'),
      `answer ${answer}`,
    );
  }
}

describe('advanceDuePayouts', () => {
  test('submits a reserved saga to the provider as USD with no ledger posting', () =>
    submitsAReservedSagaToTheProvider(memoryStore()));
  test('leaves a within-window submitted saga untouched for the settlement webhook', () =>
    leavesAWithinWindowSubmittedSagaForTheWebhook(memoryStore()));
  test('force-fails a submitted saga past the max age and returns the reserve', () =>
    forceFailsASubmittedSagaPastTheMaxAgeAndReturnsTheReserve(memoryStore()));
  test('leaves a submitted saga at the age boundary untouched for the settlement webhook', () =>
    leavesASubmittedSagaAtTheAgeBoundaryForTheWebhook(memoryStore()));
  test('dead-letters a provider fault past the attempt limit', () =>
    deadLettersAProviderFaultPastTheAttemptCeiling(memoryStore()));
  test('leaves a retryable fault under the limit for the next run', () =>
    leavesARetryableFaultUnderTheCeilingForTheNextSweep(memoryStore()));
  test('climbs the attempt count each run, then dead-letters a stuck payout and returns the reserve', () =>
    climbsAttemptsEachRunThenDeadLettersAndReturnsTheReserve(memoryStore()));
  test('isolates a per-item fault and continues the batch', () =>
    isolatesAPerItemFaultAndContinuesTheBatch());
  test('a dead-lettered payout holds one economy.payout.reversed event with the reason', () =>
    deadLetteringEmitsOnePayoutReversedEvent(memoryStore()));
  test('reverses promptly when the provider reports a submitted payout failed', () =>
    reversesPromptlyWhenTheProviderReportsFailure(memoryStore()));
  test('reverses promptly under its own reason when the provider reports a return', () =>
    reversesPromptlyWhenTheProviderReportsAReturn(memoryStore()));
  test('never force-fails a payout the provider reports settled, even past the max age', () =>
    neverForceFailsAPayoutTheProviderReportsSettled(memoryStore()));
  test('defers the timeout while the provider still reports the payout pending', () =>
    defersTheTimeoutWhileTheProviderReportsPending(memoryStore()));
  test('probes on the SLA cadence while the provider reports pending within the window', () =>
    probesOnTheSlaCadenceWhilePendingWithinTheWindow(memoryStore()));
  test('falls back to the timeout when the probe answers unknown or fails', () =>
    fallsBackToTheTimeoutWhenTheProbeCannotAnswer());
});
