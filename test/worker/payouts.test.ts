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

import { settleDuePayouts } from '#src/worker/payouts.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { credit, usd } from '#test/support/builders.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fakeProcessor,
  fixedRates,
  testLogger,
  noopMeter,
  testConfig,
} from '#test/support/capabilities.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Config } from '#src/config.ts';
import type { Options, Processor, Saga, Store, Unit } from '#src/ports.ts';

// Build the set of dependencies the background payout job runs against. It includes
// `rates` because settling a payout converts the seller's credits to USD at the current
// rate. The defaults are inert stand-ins; a test passes `overrides` to swap in a real
// processor or a different attempt limit without rebuilding the rest.
function workerCtx(overrides?: {
  processor?: Processor;
  config?: Config;
  clock?: WorkerCtx['clock'];
}): WorkerCtx {
  return {
    clock: overrides?.clock ?? fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: overrides?.processor ?? fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: overrides?.config ?? testConfig(),
  };
}

// Put money into `account` for a test, recording it as a balanced ledger entry. The
// matching half goes to STORED_VALUE, a house account that is allowed to go negative and
// that the settlement step never reads, so seeding here doesn't trip the overdraft check
// and doesn't disturb the REVENUE balance the settlement tests assert on.
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

// Build a payout record (a "saga": one payout tracked across several steps) as the
// request handler would have left it — in the given state, with its credits already
// reserved. The boring fields get defaults so a test only has to state the one or two it
// cares about (the step and the reserved amount).
function saga(overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>): Saga {
  return {
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// Store the saga, and once its credits have been reserved (RESERVED onward), seed the
// reserve account with the same amount — the way requestPayout leaves it when it moves the
// seller's earned credits into PAYOUT_RESERVE. Both the settlement step and the dead-letter
// step debit that account, and seeding it first keeps either debit from overdrawing the
// guarded reserve balance.
async function openSaga(store: Store, row: Saga): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    if (row.state === 'RESERVED' || row.state === 'SUBMITTED') {
      await fund(unit, SYSTEM.PAYOUT_RESERVE, row.reserve);
    }
  });
}

// A payment provider that rejects every payout with a temporary, retryable error, the
// same way a real provider outage would, so the job's per-payout error handling treats it
// as something to retry.
function failingProcessor(): Processor {
  return {
    submitPayout: async () => {
      throw fault(ERROR_CODES.PROVIDER_FAILURE, 'provider down', {
        retryable: true,
      });
    },
  };
}

// Wrap a store so that, the first time the job opens a transaction, another worker is
// simulated settling this saga out from under it. The job advances the saga with a guarded
// move that only succeeds if the saga is still in the state it expected (here SUBMITTED);
// by the time that move runs, the saga has already left SUBMITTED, so it matches no row,
// reports nothing updated, and returns false. This is the race the settle path must roll
// back from instead of paying the seller twice.
function raceSettleOnce(store: Store, id: string): Store {
  let raced = false;
  return {
    ...store,
    transaction: async (work, options) => {
      if (!raced) {
        raced = true;
        await store.sagas.advance(id, 'SUBMITTED', 'SETTLED', { updatedAt: 0 });
      }
      return store.transaction(work, options);
    },
  };
}

// --- The cases (one behaviour each) -----------------------------------------------

async function submitsAReservedSagaToTheProvider(store: Store): Promise<void> {
  let recorded: Array<{ key: string; userId: string; amount: Amount }> = [];
  let processor: Processor = {
    submitPayout: async (input) => {
      recorded.push(input);
      return { providerRef: `prov_${input.key}` };
    },
  };
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'RESERVED', reserve: credit('4.00') }),
  );

  let summary = await settleDuePayouts(store, workerCtx({ processor }), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.submitted, ['pay_1']);
  assert.deepEqual(summary.settled, []);
  // The provider is asked to pay in USD: the reserved credits converted at the payout
  // rate, rounded down.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.key, 'pay_1');
  assert.deepEqual(recorded[0]!.amount, usd('0.02'));
  // Submitting writes nothing to the ledger: the credits were already moved into the
  // reserve account when the payout was requested.
  let advanced = await store.sagas.load('pay_1');
  assert.equal(advanced!.state, 'SUBMITTED');
  assert.equal(advanced!.providerRef, 'prov_pay_1');
}

async function settlesASubmittedSagaWithBothCoupledPostings(
  store: Store,
): Promise<void> {
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
  );

  let summary = await settleDuePayouts(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.settled, ['pay_1']);
  assert.deepEqual(summary.deadLettered, []);
  // The credit-side entry empties the reserve account into the platform's REVENUE: the
  // seller's set-aside credits become platform earnings, since the platform now owes the
  // seller real money instead.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('4.00'));
  // The USD-side entry records the cash leaving custody through USD_CLEARING. TRUST_CASH
  // (the real cash held for users) grows on a debit, so crediting it LOWERS it — and that
  // drop is the cash the buyer already gave up back when they spent these credits.
  assert.deepEqual(await store.ledger.balance(SYSTEM.TRUST_CASH), usd('-0.02'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.USD_CLEARING),
    usd('0.02'),
  );
  let settled = await store.sagas.load('pay_1');
  assert.equal(settled!.state, 'SETTLED');
}

async function forceFailsASubmittedSagaPastTheMaxAgeAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  // A payout that submitted to the provider but never settled would otherwise sit in
  // SUBMITTED forever. Cap the wait at one minute and stand the saga up as if it entered
  // SUBMITTED at time 0 (updatedAt: 0), then run the sweep with the clock two minutes later —
  // well past the cap — so the age check force-fails it instead of trying to settle. Its due
  // time is in the past, so the sweep's "pick up everything due" step still selects it.
  let config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
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

  let summary = await settleDuePayouts(
    store,
    workerCtx({ config, clock: fixedClock(120_000) }),
    { now: 120_000, limit: 10 },
  );

  // It is force-failed, not settled, and reported under deadLettered with the timeout reason.
  assert.deepEqual(summary.settled, []);
  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.id, 'pay_1');
  assert.equal(summary.deadLettered[0]!.reason, 'payout.timeout');
  let failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  // Force-failing posts the exact reverse of the request-time reservation in the same
  // transaction as the FAILED flip: the reserve drains back to zero and the seller's earned
  // credits are restored, so a timed-out payout never strands the escrowed reserve. No USD
  // ever left custody, since the provider never reported a settlement.
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

async function settlesASubmittedSagaStillWithinTheMaxAge(
  store: Store,
): Promise<void> {
  // The mirror of the timeout case: the same saga, but checked while still inside the age
  // window, settles normally. With the cap at one minute and the clock at exactly the cap
  // (age 60_000, not strictly greater than 60_000), the boundary is inclusive — it settles.
  let config: Config = { ...testConfig(), maxPayoutAgeMs: 60_000 };
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

  let summary = await settleDuePayouts(
    store,
    workerCtx({ config, clock: fixedClock(60_000) }),
    { now: 60_000, limit: 10 },
  );

  assert.deepEqual(summary.settled, ['pay_1']);
  assert.deepEqual(summary.deadLettered, []);
  let settled = await store.sagas.load('pay_1');
  assert.equal(settled!.state, 'SETTLED');
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('4.00'));
}

async function deadLettersAProviderFaultPastTheAttemptCeiling(
  store: Store,
): Promise<void> {
  // Set the attempt limit to 1 so this single failure reaches it, and the saga is set
  // aside permanently rather than left for another retry. openSaga seeds PAYOUT_RESERVE the
  // way requestPayout would have, so the dead-letter has the reserved credits to hand back.
  let config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'RESERVED',
      attempts: 0,
      reserve: credit('4.00'),
    }),
  );

  let summary = await settleDuePayouts(
    store,
    workerCtx({ processor: failingProcessor(), config }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.submitted, []);
  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.id, 'pay_1');
  assert.equal(summary.deadLettered[0]!.reason, 'PROVIDER.FAILURE');
  let failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  // Dead-lettering posts the exact reverse of the request-time reservation in the same
  // transaction as the FAILED flip: PAYOUT_RESERVE drains back to zero and the seller's
  // earned credits are restored, so nothing is stranded in the reserve account.
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
  // Set the attempt limit high enough (5) that this one failure stays below it, so a
  // temporary error is left for the next run instead of being set aside. Only payouts
  // that can never make progress leave the queue.
  let config: Config = { ...testConfig(), maxPayoutAttempts: 5 };
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  let summary = await settleDuePayouts(
    store,
    workerCtx({ processor: failingProcessor(), config }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.deadLettered, []);
  assert.equal(summary.retrying.length, 1);
  assert.equal(summary.retrying[0]!.id, 'pay_1');
  assert.equal(summary.retrying[0]!.code, 'PROVIDER.FAILURE');
  // The saga stays RESERVED for the next run, but the failed try is now recorded: its attempt
  // count has risen from 0 to 1. That rising count is what lets a provider that stays down
  // eventually reach the limit instead of being retried forever.
  let pending = await store.sagas.load('pay_1');
  assert.equal(pending!.state, 'RESERVED');
  assert.equal(pending!.attempts, 1);
}

// Regression: a provider that stays down must not retry forever. Each failed run records one
// more attempt; once the count reaches the limit the payout is given up on and its reserve is
// returned. Before the fix a failed submit never raised the count, so the saga retried on every
// run with the count stuck at zero, never dead-lettered, and stranded the seller's reserve.
async function climbsAttemptsEachRunThenDeadLettersAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  let config: Config = { ...testConfig(), maxPayoutAttempts: 3 };
  let ctx = workerCtx({ processor: failingProcessor(), config });
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  // Runs 1 and 2 each fail under the limit, so they raise the attempt count (to 1, then 2) and
  // leave the saga RESERVED. Its due time is unchanged, so it is picked up again every run.
  let run1 = await settleDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.equal(run1.retrying.length, 1);
  assert.equal((await store.sagas.load('pay_1'))!.attempts, 1);

  let run2 = await settleDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.equal(run2.retrying.length, 1);
  assert.equal((await store.sagas.load('pay_1'))!.attempts, 2);

  // Run 3 reaches the limit, so the payout is set aside (dead-lettered) instead of retried.
  let run3 = await settleDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.deepEqual(run3.retrying, []);
  assert.equal(run3.deadLettered.length, 1);
  assert.equal(run3.deadLettered[0]!.id, 'pay_1');

  let failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  // Giving up returns the reserve: PAYOUT_RESERVE drains to zero and the seller's earned credits
  // come back, so a payout that can never be delivered never strands the escrowed credits.
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
  let store = memoryStore();
  let config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(store, saga({ id: 'pay_bad', state: 'RESERVED' }));
  await openSaga(store, saga({ id: 'pay_good', state: 'RESERVED' }));

  // The bad payout's submit always fails; the good one must still go through. One broken
  // payout should not stop the rest of the batch.
  let processor: Processor = {
    submitPayout: async (input) => {
      if (input.key === 'pay_bad') {
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'provider down', {
          retryable: true,
        });
      }
      return { providerRef: `prov_${input.key}` };
    },
  };

  let summary = await settleDuePayouts(
    store,
    workerCtx({ processor, config }),
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

async function rollsBackTheSettlementOnALostCasRatherThanDoublePaying(): Promise<void> {
  let store = memoryStore();
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
  );

  // Another worker settles this saga first (see `raceSettleOnce`), so this run's guarded
  // state change finds nothing in SUBMITTED to advance and fails. That failure rolls back the
  // settlement ledger entries it had just written, in the same transaction.
  let summary = await settleDuePayouts(
    raceSettleOnce(store, 'pay_1'),
    workerCtx(),
    {
      now: 1_000,
      limit: 10,
    },
  );

  assert.deepEqual(summary.settled, []);
  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.reason, 'SAGA.INVALID_TRANSITION');
  // No double pay: because the entries rolled back, the books are untouched — the credits
  // are still in the reserve account and no USD left custody.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('4.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.TRUST_CASH), usd('0.00'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.USD_CLEARING),
    usd('0.00'),
  );
  await store.close();
}

async function settlingEmitsOnePayoutSettledEvent(store: Store): Promise<void> {
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
  );

  await settleDuePayouts(store, workerCtx(), { now: 1_000, limit: 10 });

  // The settled event is enqueued in the same transaction as the ledger postings and the
  // guarded state advance, so a settled payout always leaves exactly one such event on the
  // outbox (the table where events wait to be delivered), carrying the money amounts as
  // formatted strings rather than raw numbers.
  let messages = await store.outbox.claimBatch(10);
  let settled = messages.filter(
    (m) => m.event.type === 'economy.payout.settled',
  );
  assert.equal(settled.length, 1);
  let event = settled[0]!.event;
  assert.equal(event.audience, 'internal');
  assert.equal(event.subject, 'usr_seller');
  assert.equal(event.data.sagaId, 'pay_1');
  assert.equal(event.data.userId, 'usr_seller');
  assert.equal(event.data.reserve, 'CREDIT:4.00');
  assert.equal(event.data.usd, 'USD:0.02');
}

async function aRolledBackSettleEmitsNoSettledEvent(): Promise<void> {
  let store = memoryStore();
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
  );

  // The settle whose guarded state change lost the race (see `raceSettleOnce`) throws,
  // rolling back its postings and the enqueued event together — so no settled event is left
  // behind for a settle that never took.
  await settleDuePayouts(raceSettleOnce(store, 'pay_1'), workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  let messages = await store.outbox.claimBatch(10);
  assert.deepEqual(
    messages.filter((m) => m.event.type === 'economy.payout.settled'),
    [],
  );
  await store.close();
}

async function deadLetteringEmitsOnePayoutReversedEvent(
  store: Store,
): Promise<void> {
  let config: Config = { ...testConfig(), maxPayoutAttempts: 1 };
  await openSaga(
    store,
    saga({
      id: 'pay_1',
      state: 'RESERVED',
      attempts: 0,
      reserve: credit('4.00'),
    }),
  );

  await settleDuePayouts(
    store,
    workerCtx({ processor: failingProcessor(), config }),
    { now: 1_000, limit: 10 },
  );

  // The reversed event is enqueued in the same transaction as the entry that undoes the
  // reservation, so a payout that was set aside (dead-lettered) always leaves exactly one
  // such event, carrying the failure reason.
  let messages = await store.outbox.claimBatch(10);
  let reversed = messages.filter(
    (m) => m.event.type === 'economy.payout.reversed',
  );
  assert.equal(reversed.length, 1);
  let event = reversed[0]!.event;
  assert.equal(event.audience, 'internal');
  assert.equal(event.subject, 'usr_seller');
  assert.equal(event.data.sagaId, 'pay_1');
  assert.equal(event.data.reason, 'PROVIDER.FAILURE');
}

async function aLostCasDeadLetterEmitsNoReversedEvent(): Promise<void> {
  let store = memoryStore();
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
  );

  // When the guarded state change loses the race, the saga is set aside (dead-lettered) with
  // an INVALID_TRANSITION reason and posts no reversing entry, because the reserve was already
  // consumed by the settle that won the race — so it must emit no reversed event.
  await settleDuePayouts(raceSettleOnce(store, 'pay_1'), workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  let messages = await store.outbox.claimBatch(10);
  assert.deepEqual(
    messages.filter((m) => m.event.type === 'economy.payout.reversed'),
    [],
  );
  await store.close();
}

describe('settleDuePayouts', () => {
  test('submits a reserved saga to the provider as USD with no ledger posting', () =>
    submitsAReservedSagaToTheProvider(memoryStore()));
  test('settles a submitted saga with both the credit-side and USD-side postings', () =>
    settlesASubmittedSagaWithBothCoupledPostings(memoryStore()));
  test('force-fails a submitted saga past the max age and returns the reserve', () =>
    forceFailsASubmittedSagaPastTheMaxAgeAndReturnsTheReserve(memoryStore()));
  test('settles a submitted saga still within the max age', () =>
    settlesASubmittedSagaStillWithinTheMaxAge(memoryStore()));
  test('dead-letters a provider fault past the attempt limit', () =>
    deadLettersAProviderFaultPastTheAttemptCeiling(memoryStore()));
  test('leaves a retryable fault under the limit for the next run', () =>
    leavesARetryableFaultUnderTheCeilingForTheNextSweep(memoryStore()));
  test('climbs the attempt count each run, then dead-letters a stuck payout and returns the reserve', () =>
    climbsAttemptsEachRunThenDeadLettersAndReturnsTheReserve(memoryStore()));
  test('isolates a per-item fault and continues the batch', () =>
    isolatesAPerItemFaultAndContinuesTheBatch());
  test('rolls back the settlement on a lost compare-and-set rather than double-paying', () =>
    rollsBackTheSettlementOnALostCasRatherThanDoublePaying());
  test('a settled payout holds one economy.payout.settled event', () =>
    settlingEmitsOnePayoutSettledEvent(memoryStore()));
  test('a rolled-back settle holds no economy.payout.settled event', () =>
    aRolledBackSettleEmitsNoSettledEvent());
  test('a dead-lettered payout holds one economy.payout.reversed event with the reason', () =>
    deadLetteringEmitsOnePayoutReversedEvent(memoryStore()));
  test('a lost compare-and-set dead-letter holds no economy.payout.reversed event', () =>
    aLostCasDeadLetterEmitsNoReversedEvent());
});
