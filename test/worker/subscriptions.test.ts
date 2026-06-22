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
import type { Options, Store, Subscription, Unit } from '#src/ports.ts';

// Build the context object the sweep needs to run: a clock, id generator, logger, the
// fee config, and so on. Every piece is a do-nothing test stand-in except the ones a
// case cares about. The `overrides` lets a case swap in a different config (to change
// the fee rate) without rebuilding the rest by hand.
function workerCtx(overrides?: { config?: Config }): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: overrides?.config ?? testConfig(),
  };
}

// Put `amount` of money into a user's account, so a later charge has something to draw
// on. The matching debit goes to STORED_VALUE, a platform account that is allowed to go
// negative and tracks credits in circulation. Using it here keeps the seed entry
// balanced without needing its own funds, and leaves REVENUE untouched so that any
// later check of REVENUE starts from zero.
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

// Build a subscription record the way it looks right after the first month: ACTIVE,
// with its next charge already due. The defaults fill in the fields a case doesn't care
// about, so each case sets only what it is testing (the price, the due time, the
// funding).
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

// Save an ACTIVE subscription and give the buyer `funded` to spend, so the renewal
// charge has money to take. The buyer's account is guarded against going negative, so
// without this seeding a charge would be rejected as an overdraft.
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

// --- The cases (one behaviour each) -----------------------------------------------

async function chargesAFundedRenewalAndAdvancesTheDueTime(
  store: Store,
): Promise<void> {
  let sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  await openSub(store, sub, credit('100.00'));

  let summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_1']);
  assert.deepEqual(summary.lapsed, []);
  assert.deepEqual(summary.deadLettered, []);
  // The full price comes out of the buyer's account, leaving it at zero.
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('0.00'),
  );
  // The test config's fee is 30%. 30% of 100.00 is exactly 30.00, already a whole
  // number, so the seller keeps the remaining 70.00.
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('70.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('30.00'));
  // The record is still ACTIVE, and its next charge has moved one period into the future.
  let billed = await store.subscriptions.load('sub_1');
  assert.equal(billed!.state, 'ACTIVE');
  assert.equal(billed!.nextDueAt, sub.nextDueAt + sub.periodMs);
  assert.equal(billed!.period, 2);
}

async function roundsTheFeeUpToAWholeCreditTowardThePlatform(
  store: Store,
): Promise<void> {
  // 30% of 100.01 is 30.003 credits — a fee that lands BETWEEN whole credits. The fee always
  // rounds UP to a whole credit, so the platform takes 31.00 and the seller is left with 69.01.
  // 100.01 is chosen because the fee is fractional in minor units (3000.3): a renewal path that
  // floored to minor units before rounding up would drop the 0.3 and wrongly take only 30.00,
  // so this pins that renewal shares pricing.ts `feeForPrice`.
  let sub = subscription({ id: 'sub_1', price: credit('100.01') });
  await openSub(store, sub, credit('100.01'));

  let summary = await sweepDueSubscriptions(store, workerCtx(), {
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
  // The buyer has only 99.99 but the price is 100.00, so the charge can't be paid. The
  // subscription is marked LAPSED and no money moves at all.
  let sub = subscription({ id: 'sub_1', price: credit('100.00') });
  await openSub(store, sub, credit('99.99'));

  let summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.lapsed, ['sub_1']);
  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.deadLettered, []);
  // Nothing was charged: the buyer still has 99.99 and the seller earned nothing.
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('99.99'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
  // LAPSED is a final state, so a future sweep won't try to bill this record again.
  let lapsed = await store.subscriptions.load('sub_1');
  assert.equal(lapsed!.state, 'LAPSED');
}

async function leavesANotYetDueSubscriptionAlone(store: Store): Promise<void> {
  // This one's next charge isn't due until time 5_000, later than the sweep's `now` of
  // 1_000, so the sweep doesn't pick it up and does nothing to it.
  let sub = subscription({ id: 'sub_1', nextDueAt: 5_000 });
  await openSub(store, sub, credit('100.00'));

  let summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.lapsed, []);
  let pending = await store.subscriptions.load('sub_1');
  assert.equal(pending!.state, 'ACTIVE');
  assert.equal(pending!.nextDueAt, 5_000);
}

async function billsAndLapsesAcrossOneBatchIndependently(): Promise<void> {
  let store = memoryStore();
  await openSub(store, subscription({ id: 'sub_funded' }), credit('100.00'));
  await openSub(store, subscription({ id: 'sub_broke' }), credit('0.00'));

  // One sweep handles both due records on their own: the funded one is charged and the
  // broke one lapses. An unpayable record never stops a payable one in the same batch.
  let summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_funded']);
  assert.deepEqual(summary.lapsed, ['sub_broke']);
  assert.deepEqual(summary.deadLettered, []);
  await store.close();
}

async function isolatesAPerItemFaultAndDeadLettersWhileTheBatchContinues(): Promise<void> {
  let store = memoryStore();
  // Two due subscriptions, each owned by a different buyer, so a failure tied to one
  // buyer's account read affects only that buyer's record.
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

  // Wrap the store so that reading the bad buyer's balance throws an error the sweep won't retry.
  // That record is dead-lettered — set aside as failed-for-good, with the reason recorded, and
  // marked LAPSED — while the good record still charges normally. One broken record can never
  // block the batch.
  let faulting = faultOnBuyerBalance(store, 'usr_bad');

  let summary = await sweepDueSubscriptions(faulting, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_good']);
  assert.deepEqual(
    summary.deadLettered.map((d) => d.id),
    ['sub_bad'],
  );
  // The broken record is LAPSED so the next sweep stops retrying it; the good one billed.
  let bad = await store.subscriptions.load('sub_bad');
  assert.equal(bad!.state, 'LAPSED');
  let good = await store.subscriptions.load('sub_good');
  assert.equal(good!.state, 'ACTIVE');
  await store.close();
}

// Wrap a real store so that any read of `badUser`'s spendable balance throws a STORE.FAILURE
// error; every other store method passes straight through to the real one. That error is treated
// as permanent (not worth retrying), so the sweep gives up on that record and dead-letters it
// rather than leaving it for the next run to hit the same error again.
function faultOnBuyerBalance(store: Store, badUser: string): Store {
  return {
    ...store,
    transaction: (work, options) =>
      store.transaction((unit) => {
        let guarded: Unit = {
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

// Wrap a real store so that reading `badUser`'s spendable balance throws a plain JavaScript Error
// rather than one of the project's own typed errors. The sweep treats any error it doesn't
// recognize as a temporary infrastructure failure worth retrying, so this drives it down the
// retry-and-count path instead of the give-up-immediately path the permanent-error wrapper above
// triggers. Every other store method passes straight through, so the row can still be picked up
// and re-billed, and stays ACTIVE for the next sweep until the retry count hits its cap.
function retryableFaultOnBuyerBalance(store: Store, badUser: string): Store {
  return {
    ...store,
    transaction: (work, options) =>
      store.transaction((unit) => {
        let guarded: Unit = {
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

// One retryable failure under the cap leaves the subscription ACTIVE and untouched except for
// its bumped attempt count: nothing is charged, nothing lapses, and `attempts` is persisted as
// 1 so the next sweep continues counting toward the ceiling rather than restarting at zero.
async function bumpsAttemptsAndKeepsRetryingBelowTheCap(): Promise<void> {
  let store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  let flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');

  let summary = await sweepDueSubscriptions(flaky, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // The failure is retryable and well under the cap, so the row is recorded for a retry, not
  // charged, lapsed, or dead-lettered.
  assert.deepEqual(
    summary.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.lapsed, []);
  assert.deepEqual(summary.deadLettered, []);
  // The bumped attempt is persisted so it survives to the next sweep, and the row stays
  // ACTIVE and due so that next sweep picks it up again.
  let row = await store.subscriptions.load('sub_flaky');
  assert.equal(row!.state, 'ACTIVE');
  assert.equal(row!.attempts, 1);
  await store.close();
}

// A subscription that keeps hitting a retryable failure does NOT retry forever: each sweep
// bumps `attempts`, and the sweep whose bump reaches the configured cap lapses the row instead
// of re-billing it. The test config caps at 3, so the third consecutive failure is the one
// that lapses — the first two only bump-and-retry.
async function lapsesAPersistentlyFailingSubscriptionAtTheCap(): Promise<void> {
  let store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  let flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');
  let ctx = workerCtx(); // testConfig().maxSubscriptionAttempts === 3

  // Sweep 1: attempts 0 -> 1, retrying.
  let first = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(
    first.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 1);
  assert.equal((await store.subscriptions.load('sub_flaky'))!.state, 'ACTIVE');

  // Sweep 2: attempts 1 -> 2, still under the cap of 3, still retrying.
  let second = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(
    second.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 2);
  assert.equal((await store.subscriptions.load('sub_flaky'))!.state, 'ACTIVE');

  // Sweep 3: the bump would make attempts 3, which reaches the cap, so the row LAPSES instead
  // of retrying — proving a broken subscription is given up on rather than re-billed forever.
  let third = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(third.lapsed, ['sub_flaky']);
  assert.deepEqual(third.retrying, []);
  assert.deepEqual(third.charged, []);
  let lapsed = await store.subscriptions.load('sub_flaky');
  assert.equal(lapsed!.state, 'LAPSED');

  // A LAPSED row is no longer ACTIVE, so a fourth sweep won't even claim it: the retrying has
  // genuinely stopped.
  let fourth = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(fourth.retrying, []);
  assert.deepEqual(fourth.lapsed, []);
  await store.close();
}

// A renewal that finally succeeds clears earlier strikes: after some retryable failures bump
// `attempts`, a healthy sweep charges the renewal and `markBilled` resets `attempts` to 0, so
// the cap only ever counts *consecutive* failures and a recovered subscription starts fresh.
async function resetsAttemptsToZeroOnASuccessfulRenewal(): Promise<void> {
  let store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  let ctx = workerCtx();

  // Two sweeps against a flaky store push attempts up to 2 without lapsing (cap is 3).
  let flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');
  await sweepDueSubscriptions(flaky, ctx, { now: 1_000, limit: 10 });
  await sweepDueSubscriptions(flaky, ctx, { now: 1_000, limit: 10 });
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 2);

  // The store recovers; the next sweep charges the renewal normally and resets the counter.
  let healed = await sweepDueSubscriptions(store, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(healed.charged, ['sub_flaky']);
  let billed = await store.subscriptions.load('sub_flaky');
  assert.equal(billed!.state, 'ACTIVE');
  assert.equal(billed!.attempts, 0);
  assert.equal(billed!.period, 2);
  await store.close();
}

// Wrap a store so `subscriptions.claimDue` always hands back the SAME stale snapshot of one
// subscription, regardless of what the underlying row now says. This models two overlapping
// renewal sweepers that both claimed the row (period 1, due at 0) before either billed it: the
// second sweep still believes the row is due for period 2 even though the first already
// advanced it. Every other store method passes straight through to the real one, so the real
// row's state (nextDueAt, period, balance) updates normally — only the claim is frozen.
//
// This is the harness for the two guards that stop a double charge. First, the renewal reserves
// a one-time key naming this exact period before posting, so the second sweep finds the period
// already taken and posts nothing. Second, the advance of the due date only succeeds if the row
// still has the due date this sweep started from (a compare-and-set: read the stored due date,
// move it forward only if it hasn't already moved), so the second sweep's advance fails. Either
// way the second sweep must do nothing — neither charge nor emit a second event.
function staleClaimDue(store: Store, snapshot: Subscription): Store {
  return {
    ...store,
    subscriptions: {
      ...store.subscriptions,
      claimDue: async () => [{ ...snapshot }],
    },
  };
}

// Two overlapping sweeps over the same due subscription bill exactly once and emit exactly one
// renewed event. The second sweep reads the same stale snapshot the first did, so it must
// short-circuit instead of double-charging: it finds the period's one-time key already taken,
// and its attempt to advance the due date fails because the first sweep already moved it.
async function billsExactlyOnceAcrossTwoOverlappingSweeps(): Promise<void> {
  let store = memoryStore();
  let sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  // Fund TWO periods up front so the balance check can't accidentally be what stops the second
  // sweep — if both sweeps charged, the buyer could afford it. The guards under test are the
  // one-time per-period key and the conditional due-date advance, not the funds check.
  await openSub(store, sub, credit('200.00'));
  // Both sweepers claimed this exact snapshot (period 1, due at 0) before either billed.
  let frozen = staleClaimDue(store, sub);

  let first = await sweepDueSubscriptions(frozen, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  let second = await sweepDueSubscriptions(frozen, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Only the first sweep charges; the second finds the period's one-time key already taken and
  // the due date already advanced, so it does nothing — even though the buyer could have
  // afforded a second charge.
  assert.deepEqual(first.charged, ['sub_1']);
  assert.deepEqual(second.charged, []);
  assert.deepEqual(second.lapsed, []);
  assert.deepEqual(second.deadLettered, []);
  assert.deepEqual(second.retrying, []);

  // Exactly one renewal posting: the buyer is debited the price once (200.00 -> 100.00) and the
  // seller/platform are credited a single split, not two.
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('100.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('70.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('30.00'));

  // The row advanced exactly one period despite two sweeps reading the same snapshot.
  let billed = await store.subscriptions.load('sub_1');
  assert.equal(billed!.period, 2);
  assert.equal(billed!.nextDueAt, sub.nextDueAt + sub.periodMs);

  // Exactly one renewed event was enqueued across both sweeps.
  let renewed = (await store.outbox.claimBatch(10)).filter(
    (m) => m.event.type === 'economy.subscription.renewed',
  );
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0]!.event.subject, 'usr_buyer');
  await store.close();
}

// A successful renewal re-grants the perk (the thing the subscription buys, here the 'club_pass'
// sku) out to the new period end: after billing, the buyer owns the sku, and the grant's expiry
// has advanced one full period forward — owning is live up to and including the new period end
// and gone the instant after. The store's clock is injected so the test can move time past the
// new expiry and watch the perk lapse.
async function reGrantsThePerkWithAdvancedExpiryOnRenewal(): Promise<void> {
  let clock = fixedClock(0);
  let store = memoryStore({ clock });
  let sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  await openSub(store, sub, credit('100.00'));

  // No live grant before the sweep (the worker is what re-grants on renewal).
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);

  let summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(summary.charged, ['sub_1']);

  // The renewal re-granted the perk, expiring at the new period end (the advanced next-due-at =
  // 0 + periodMs). owns() is evaluated against the store's clock and is inclusive of expiresAt.
  let newPeriodEnd = sub.nextDueAt + sub.periodMs;
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);

  // At exactly the new period end the perk is still owned (inclusive boundary)...
  clock.advance(newPeriodEnd);
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);
  // ...and one millisecond past it, the grant has lapsed: the expiry genuinely advanced.
  clock.advance(1);
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);
  await store.close();
}

// An underfunded renewal lapses the subscription, revokes the perk, and emits exactly one lapsed
// event — the buyer stops owning what they stopped paying for.
async function lapseRevokesThePerkAndEmitsOneLapsedEvent(): Promise<void> {
  let store = memoryStore();
  let sub = subscription({
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

  let summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.lapsed, ['sub_1']);
  assert.deepEqual(summary.charged, []);
  let lapsed = await store.subscriptions.load('sub_1');
  assert.equal(lapsed!.state, 'LAPSED');

  // The perk was revoked in the lapse transaction: the buyer no longer owns it.
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);

  // Exactly one lapsed event, addressed to the buyer.
  let events = (await store.outbox.claimBatch(10)).filter(
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
