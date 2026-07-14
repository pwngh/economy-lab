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

import { sweepDueSubscriptions } from '#src/worker/subscriptions.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import { credit } from '#test/support/builders.ts';
import { fixedClock, makeWorkerCtx } from '#test/support/capabilities.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { Options, Store, Subscription, Unit } from '#src/ports.ts';

// The matching debit goes to STORED_VALUE, which may go negative, keeping the seed balanced
// and REVENUE at zero for the assertions.
async function fund(
  unit: Unit,
  account: AccountRef,
  amount: Amount,
  options?: Options,
): Promise<void> {
  await postEntry(
    unit.ledger,
    {
      txnId: `txn_seed_${account}`,
      legs: [creditLeg(account, amount), debit(SYSTEM.STORED_VALUE, amount)],
      meta: { kind: 'test.fund' },
    },
    options,
  );
}

// ACTIVE with the next charge due, as after a first month; defaults fill the rest.
function subscription(
  overrides: Partial<Subscription> & Pick<Subscription, 'id'>,
): Subscription {
  return {
    userId: 'usr_buyer',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: credit('100.00'),
    periodMs: 2_592_000_000,
    state: 'ACTIVE',
    period: 1,
    attempts: 0,
    nextDueAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// Without funding, a charge would be rejected as an overdraft.
async function openSub(
  store: Store,
  row: Subscription,
  funded: Amount,
): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.subscriptions.open(row);
    if (funded.minor > 0n) {
      await fund(unit, spendable(row.userId), funded);
    }
  });
}

// --- The cases (one behavior each) -----------------------------------------------

async function chargesAFundedRenewalAndAdvancesTheDueTime(
  store: Store,
): Promise<void> {
  const sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  await openSub(store, sub, credit('100.00'));

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_1']);
  assert.deepEqual(summary.lapsed, []);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('0.00'),
  );
  // Test config fee is 30%; 30% of 100.00 is exactly 30.00, so the seller keeps 70.00.
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('70.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('30.00'));
  const billed = await store.subscriptions.load('sub_1');
  assert.equal(billed!.state, 'ACTIVE');
  assert.equal(billed!.nextDueAt, sub.nextDueAt + sub.periodMs);
  assert.equal(billed!.period, 2);
}

async function roundsTheFeeUpToAWholeCreditTowardThePlatform(
  store: Store,
): Promise<void> {
  // 100.01 makes the fee fractional in minor units (3000.3): a path that floored before rounding
  // up would take 30.00, not 31.00. Pins the renewal to the same feeForPrice rounding as pricing.ts.
  const sub = subscription({ id: 'sub_1', price: credit('100.01') });
  await openSub(store, sub, credit('100.01'));

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_1']);
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('31.00'));
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('69.01'),
  );
}

async function lapsesAnUnderfundedRenewalWithNoPosting(
  store: Store,
): Promise<void> {
  const sub = subscription({ id: 'sub_1', price: credit('100.00') });
  await openSub(store, sub, credit('99.99'));

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.lapsed, ['sub_1']);
  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('99.99'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
  const lapsed = await store.subscriptions.load('sub_1');
  assert.equal(lapsed!.state, 'LAPSED');
}

async function leavesANotYetDueSubscriptionAlone(store: Store): Promise<void> {
  const sub = subscription({ id: 'sub_1', nextDueAt: 5_000 });
  await openSub(store, sub, credit('100.00'));

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.lapsed, []);
  const pending = await store.subscriptions.load('sub_1');
  assert.equal(pending!.state, 'ACTIVE');
  assert.equal(pending!.nextDueAt, 5_000);
}

async function billsAndLapsesAcrossOneBatchIndependently(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_funded' }), credit('100.00'));
  await openSub(store, subscription({ id: 'sub_broke' }), credit('0.00'));

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_funded']);
  assert.deepEqual(summary.lapsed, ['sub_broke']);
  assert.deepEqual(summary.deadLettered, []);
  await store.close();
}

async function isolatesAPerItemFaultAndDeadLettersWhileTheBatchContinues(): Promise<void> {
  const store = memoryStore();
  // Different buyers, so the fault targets only one record's balance read.
  await openSub(
    store,
    subscription({ id: 'sub_bad', userId: 'usr_bad' }),
    credit('100.00'),
  );
  await openSub(
    store,
    subscription({ id: 'sub_good', userId: 'usr_good' }),
    credit('100.00'),
  );

  const faulting = faultOnBuyerBalance(store, 'usr_bad');

  const summary = await sweepDueSubscriptions(faulting, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_good']);
  assert.deepEqual(
    summary.deadLettered.map((d) => d.id),
    ['sub_bad'],
  );
  // Broken record LAPSED so the next sweep stops retrying it; good one billed.
  const bad = await store.subscriptions.load('sub_bad');
  assert.equal(bad!.state, 'LAPSED');
  const good = await store.subscriptions.load('sub_good');
  assert.equal(good!.state, 'ACTIVE');
  await store.close();
}

// Throws a non-retryable typed fault on the bad buyer's balance read, driving the give-up
// path; every other method passes through.
function faultOnBuyerBalance(store: Store, badUser: string): Store {
  return {
    ...store,
    transaction: (work, options) =>
      store.transaction((unit) => {
        const guarded: Unit = {
          ...unit,
          ledger: {
            ...unit.ledger,
            balance: (account, balanceOptions) => {
              if (account === spendable(badUser)) {
                throw fault(
                  ERROR_CODES.STORE_FAILURE,
                  'store down for the bad row',
                );
              }
              return unit.ledger.balance(account, balanceOptions);
            },
          },
        };
        return work(guarded);
      }, options),
  };
}

// Throws a plain Error, which the sweep treats as transient: drives the retry-and-count path,
// not the give-up path of the typed wrapper above.
function retryableFaultOnBuyerBalance(store: Store, badUser: string): Store {
  return {
    ...store,
    transaction: (work, options) =>
      store.transaction((unit) => {
        const guarded: Unit = {
          ...unit,
          ledger: {
            ...unit.ledger,
            balance: (account, balanceOptions) => {
              if (account === spendable(badUser)) {
                throw new Error('transient store blip for the flaky row');
              }
              return unit.ledger.balance(account, balanceOptions);
            },
          },
        };
        return work(guarded);
      }, options),
  };
}

async function bumpsAttemptsAndKeepsRetryingBelowTheCap(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  const flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');

  const summary = await sweepDueSubscriptions(flaky, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(
    summary.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.lapsed, []);
  assert.deepEqual(summary.deadLettered, []);
  const row = await store.subscriptions.load('sub_flaky');
  assert.equal(row!.state, 'ACTIVE');
  assert.equal(row!.attempts, 1);
  await store.close();
}

async function lapsesAPersistentlyFailingSubscriptionAtTheCap(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  const flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');
  const ctx = makeWorkerCtx(); // testConfig().maxSubscriptionAttempts === 3

  const first = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(
    first.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 1);
  assert.equal((await store.subscriptions.load('sub_flaky'))!.state, 'ACTIVE');

  const second = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(
    second.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 2);
  assert.equal((await store.subscriptions.load('sub_flaky'))!.state, 'ACTIVE');

  // The third bump reaches the cap of 3: lapse instead of retry.
  const third = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(third.lapsed, ['sub_flaky']);
  assert.deepEqual(third.retrying, []);
  assert.deepEqual(third.charged, []);
  const lapsed = await store.subscriptions.load('sub_flaky');
  assert.equal(lapsed!.state, 'LAPSED');

  const fourth = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(fourth.retrying, []);
  assert.deepEqual(fourth.lapsed, []);
  await store.close();
}

// The cap counts only consecutive failures: `markBilled` resets attempts on success.
async function resetsAttemptsToZeroOnASuccessfulRenewal(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  const ctx = makeWorkerCtx();

  const flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');
  await sweepDueSubscriptions(flaky, ctx, { now: 1_000, limit: 10 });
  await sweepDueSubscriptions(flaky, ctx, { now: 1_000, limit: 10 });
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 2);

  const healed = await sweepDueSubscriptions(store, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(healed.charged, ['sub_flaky']);
  const billed = await store.subscriptions.load('sub_flaky');
  assert.equal(billed!.state, 'ACTIVE');
  assert.equal(billed!.attempts, 0);
  assert.equal(billed!.period, 2);
  await store.close();
}

// claimDue always returns the same stale snapshot, modeling two overlapping sweepers that both
// claimed the row before either billed; only the claim is frozen. Two guards stop the double
// charge: the per-period one-time key, and the compare-and-set due-date advance, which fails
// once the first sweep moved the date.
function staleClaimDue(store: Store, snapshot: Subscription): Store {
  return {
    ...store,
    subscriptions: {
      ...store.subscriptions,
      claimDue: async () => [{ ...snapshot }],
    },
  };
}

async function billsExactlyOnceAcrossTwoOverlappingSweeps(): Promise<void> {
  const store = memoryStore();
  const sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  // Fund two periods so the balance check cannot be what stops the second sweep.
  await openSub(store, sub, credit('200.00'));
  const frozen = staleClaimDue(store, sub);

  const first = await sweepDueSubscriptions(frozen, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  const second = await sweepDueSubscriptions(frozen, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(first.charged, ['sub_1']);
  assert.deepEqual(second.charged, []);
  assert.deepEqual(second.lapsed, []);
  assert.deepEqual(second.deadLettered, []);
  assert.deepEqual(second.retrying, []);

  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('100.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('70.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('30.00'));

  const billed = await store.subscriptions.load('sub_1');
  assert.equal(billed!.period, 2);
  assert.equal(billed!.nextDueAt, sub.nextDueAt + sub.periodMs);

  const renewed = (await store.outbox.claimBatch(10)).filter(
    (m) => m.event.type === 'economy.subscription.renewed',
  );
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0]!.event.subject, 'usr_buyer');
  await store.close();
}

// The clock is injected so the test can step past the new expiry and watch the perk lapse.
async function reGrantsThePerkWithAdvancedExpiryOnRenewal(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ clock });
  const sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  await openSub(store, sub, credit('100.00'));

  // No live grant before the sweep (the worker is what re-grants on renewal).
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(summary.charged, ['sub_1']);

  // owns() evaluates against the store's clock and is inclusive of expiresAt.
  const newPeriodEnd = sub.nextDueAt + sub.periodMs;
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);

  clock.advance(newPeriodEnd);
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);
  clock.advance(1);
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);
  await store.close();
}

async function lapseRevokesThePerkAndEmitsOneLapsedEvent(): Promise<void> {
  const store = memoryStore();
  const sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  await openSub(store, sub, credit('50.00'));
  // Pre-grant the perk so the lapse has something to revoke (mirrors a prior funded period).
  await store.transaction(async (unit) => {
    await unit.entitlements.grant('usr_buyer', 'club_pass', {
      expiresAt: null,
      source: 'sub_1',
    });
  });
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);

  const summary = await sweepDueSubscriptions(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.lapsed, ['sub_1']);
  assert.deepEqual(summary.charged, []);
  const lapsed = await store.subscriptions.load('sub_1');
  assert.equal(lapsed!.state, 'LAPSED');

  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);

  const events = (await store.outbox.claimBatch(10)).filter(
    (m) => m.event.type === 'economy.subscription.lapsed',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event.subject, 'usr_buyer');
  await store.close();
}

describe('sweepDueSubscriptions', () => {
  test('charges a funded renewal and advances the due time', () =>
    chargesAFundedRenewalAndAdvancesTheDueTime(memoryStore()));
  test('rounds the renewal fee up to a whole credit toward the platform', () =>
    roundsTheFeeUpToAWholeCreditTowardThePlatform(memoryStore()));
  test('lapses an underfunded renewal with no posting', () =>
    lapsesAnUnderfundedRenewalWithNoPosting(memoryStore()));
  test('leaves a not-yet-due subscription alone', () =>
    leavesANotYetDueSubscriptionAlone(memoryStore()));
  test('bills and lapses across one batch independently', () =>
    billsAndLapsesAcrossOneBatchIndependently());
  test('isolates a per-item fault and dead-letters while the batch continues', () =>
    isolatesAPerItemFaultAndDeadLettersWhileTheBatchContinues());
  test('bumps attempts and keeps retrying below the cap', () =>
    bumpsAttemptsAndKeepsRetryingBelowTheCap());
  test('lapses a persistently-failing subscription at the cap', () =>
    lapsesAPersistentlyFailingSubscriptionAtTheCap());
  test('resets attempts to zero on a successful renewal', () =>
    resetsAttemptsToZeroOnASuccessfulRenewal());
  test('bills exactly once across two overlapping sweeps and emits one renewed event', () =>
    billsExactlyOnceAcrossTwoOverlappingSweeps());
  test('re-grants the perk with advanced expiry on renewal', () =>
    reGrantsThePerkWithAdvancedExpiryOnRenewal());
  test('lapse revokes the perk and emits one lapsed event', () =>
    lapseRevokesThePerkAndEmitsOneLapsedEvent());
});
