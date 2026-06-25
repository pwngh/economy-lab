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

// Deps for the background payout job. `rates` is here because settling converts the
// seller's credits to USD at the current rate. Defaults are inert stand-ins; pass
// `overrides` to swap in a real processor or a different attempt limit.
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

// Put money into `account` as a balanced ledger entry. The matching half goes to
// STORED_VALUE, a house account allowed to go negative that settlement never reads, so
// seeding doesn't trip the overdraft check or disturb the REVENUE balance under test.
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

// Build a payout record (a saga: one payout tracked across several steps) as the request
// handler would leave it: given state, credits already reserved. Defaults fill the rest so
// a test states only what it cares about (step and reserved amount).
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

// Store the saga; from RESERVED onward, seed PAYOUT_RESERVE with the same amount the way
// requestPayout leaves it after moving the seller's earned credits in. Both the settlement
// and dead-letter steps debit that account, and seeding first keeps either from overdrawing
// the guarded reserve balance.
async function openSaga(store: Store, row: Saga): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    if (row.state === 'RESERVED' || row.state === 'SUBMITTED') {
      await fund(unit, SYSTEM.PAYOUT_RESERVE, row.reserve);
    }
  });
}

// A provider that rejects every payout with a retryable error (like a real outage), so the
// job's per-payout error handling treats it as something to retry.
function failingProcessor(): Processor {
  return {
    submitPayout: async () => {
      throw fault(ERROR_CODES.PROVIDER_FAILURE, 'provider down', {
        retryable: true,
      });
    },
  };
}

// --- The cases (one behaviour each) ---

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
  // The provider is asked to pay in USD: the reserved credits converted at the payout
  // rate, rounded down.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.key, 'pay_1');
  assert.deepEqual(recorded[0]!.amount, usd('0.02'));
  // Submitting writes nothing to the ledger; the credits moved into the reserve account at
  // request time.
  let advanced = await store.sagas.load('pay_1');
  assert.equal(advanced!.state, 'SUBMITTED');
  assert.equal(advanced!.providerRef, 'prov_pay_1');
}

async function leavesAWithinWindowSubmittedSagaForTheWebhook(
  store: Store,
): Promise<void> {
  // The worker no longer self-settles a SUBMITTED payout; settlement arrives through the provider's
  // settlement webhook (src/operations/settlePayout.ts), not the sweep. A SUBMITTED saga still inside
  // the timeout window is therefore left untouched this run: no state change, no ledger postings.
  await openSaga(
    store,
    saga({ id: 'pay_1', state: 'SUBMITTED', reserve: credit('4.00') }),
  );

  let summary = await settleDuePayouts(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Nothing submitted (already SUBMITTED), nothing dead-lettered (within the window), nothing
  // retried.
  assert.deepEqual(summary.submitted, []);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
  // No settle posting ran: the reserve is untouched and no cash left custody. The reserve waits for
  // the webhook to empty it into REVENUE.
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
  // The saga stays SUBMITTED, waiting on the settlement webhook.
  let stillSubmitted = await store.sagas.load('pay_1');
  assert.equal(stillSubmitted!.state, 'SUBMITTED');
}

async function forceFailsASubmittedSagaPastTheMaxAgeAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  // A payout that submitted but never settled would otherwise sit in SUBMITTED forever. Cap
  // the wait at one minute, enter SUBMITTED at time 0 (updatedAt: 0), then sweep with the
  // clock two minutes later (past the cap) so the age check force-fails it instead of
  // settling. dueAt is in the past, so the sweep still selects it.
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

  // Force-failed; reported under deadLettered with the timeout reason.
  assert.equal(summary.deadLettered.length, 1);
  assert.equal(summary.deadLettered[0]!.id, 'pay_1');
  assert.equal(summary.deadLettered[0]!.reason, 'payout.timeout');
  let failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  // The terminal failure reason is persisted on the saga record itself (read straight from it by the
  // console, no posting-meta harvest), and the settle never ran so payoutUsd stays null.
  assert.equal(failed!.reason, 'payout.timeout');
  assert.equal(failed!.payoutUsd, null);
  // Force-failing posts the exact reverse of the request-time reservation in the same
  // transaction as the FAILED flip: reserve drains to zero, seller's earned credits restored,
  // so a timed-out payout never strands the escrowed reserve. No USD left custody, since the
  // provider never reported a settlement.
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
  // Mirror of the timeout case at the inclusive boundary: same saga, checked at exactly the cap (age
  // 60_000, not strictly greater than maxPayoutAgeMs), so it is NOT force-failed. The worker no
  // longer self-settles either, so at the boundary the saga is simply left untouched for the
  // settlement webhook. Only a strictly-past-cap age (the timeout test) force-fails it.
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

  // Not force-failed (boundary is inclusive) and not settled (the webhook does that): left untouched.
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.submitted, []);
  let stillSubmitted = await store.sagas.load('pay_1');
  assert.equal(stillSubmitted!.state, 'SUBMITTED');
  // No settle posting ran, so the reserve is intact and REVENUE is still empty.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('4.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
}

async function deadLettersAProviderFaultPastTheAttemptCeiling(
  store: Store,
): Promise<void> {
  // Attempt limit 1, so this single failure reaches it and the saga is set aside rather than
  // retried. openSaga seeds PAYOUT_RESERVE the way requestPayout would, so the dead-letter has
  // the reserved credits to hand back.
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
  // The failure reason is persisted on the saga's own terminal-outcome field, payoutUsd left null.
  assert.equal(failed!.reason, 'PROVIDER.FAILURE');
  assert.equal(failed!.payoutUsd, null);
  // Dead-lettering posts the exact reverse of the request-time reservation in the same
  // transaction as the FAILED flip: PAYOUT_RESERVE drains to zero, seller's earned credits
  // restored, nothing stranded in the reserve account.
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
  // Attempt limit high enough (5) that this one failure stays below it, so a temporary error
  // is left for the next run instead of being set aside. Only payouts that can never make
  // progress leave the queue.
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
  // Saga stays RESERVED for the next run, but the failed try is recorded: attempts rose from
  // 0 to 1. The rising count is what lets a provider that stays down eventually reach the
  // limit instead of retrying forever.
  let pending = await store.sagas.load('pay_1');
  assert.equal(pending!.state, 'RESERVED');
  assert.equal(pending!.attempts, 1);
}

// Regression: a provider that stays down must not retry forever. Each failed run records one
// more attempt; at the limit the payout is given up on and its reserve returned. Before the
// fix a failed submit never raised the count, so the saga retried every run with the count
// stuck at zero, never dead-lettered, and stranded the seller's reserve.
async function climbsAttemptsEachRunThenDeadLettersAndReturnsTheReserve(
  store: Store,
): Promise<void> {
  let config: Config = { ...testConfig(), maxPayoutAttempts: 3 };
  let ctx = workerCtx({ processor: failingProcessor(), config });
  await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED', attempts: 0 }));

  // Runs 1 and 2 each fail under the limit, raising attempts (to 1, then 2) and leaving the
  // saga RESERVED. dueAt is unchanged, so it is picked up again every run.
  let run1 = await settleDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.equal(run1.retrying.length, 1);
  assert.equal((await store.sagas.load('pay_1'))!.attempts, 1);

  let run2 = await settleDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.equal(run2.retrying.length, 1);
  assert.equal((await store.sagas.load('pay_1'))!.attempts, 2);

  // Run 3 reaches the limit, so the payout is dead-lettered instead of retried.
  let run3 = await settleDuePayouts(store, ctx, { now: 1_000, limit: 10 });
  assert.deepEqual(run3.retrying, []);
  assert.equal(run3.deadLettered.length, 1);
  assert.equal(run3.deadLettered[0]!.id, 'pay_1');

  let failed = await store.sagas.load('pay_1');
  assert.equal(failed!.state, 'FAILED');
  // Giving up returns the reserve: PAYOUT_RESERVE drains to zero and the seller's earned
  // credits come back, so an undeliverable payout never strands the escrowed credits.
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
  // payout must not stop the rest of the batch.
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
  // reservation, so a dead-lettered payout leaves exactly one such event, carrying the
  // failure reason.
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

describe('settleDuePayouts', () => {
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
});
