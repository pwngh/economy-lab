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

// Builds the context the sweep needs: clock, ids, logger, fee config, and so on. Every field is a
// no-op test stand-in. `overrides` swaps in a different config (for example a different fee rate)
// without rebuilding the rest.
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

// Puts `amount` into a user's account so a later charge has something to draw on. The matching
// debit goes to STORED_VALUE, a platform account that is allowed to go negative and tracks credits
// in circulation. Routing the debit there keeps the seed entry balanced and leaves REVENUE at zero
// for the later assertions.
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

// Builds a subscription record as it looks right after the first month: ACTIVE, with the next
// charge due. The defaults fill the fields a case does not care about. Each case overrides only
// what it tests, such as price, due time, or funding.
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

// Saves an ACTIVE subscription and gives the buyer `funded` to spend. The buyer's account cannot
// go negative, so without this seeding a charge would be rejected as an overdraft.
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

  const summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.charged, ['sub_1']);
  assert.deepEqual(summary.lapsed, []);
  assert.deepEqual(summary.deadLettered, []);
  // Full price leaves the buyer at zero.
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
  // 30% of 100.01 is 30.003 credits, which falls between whole credits. The fee rounds up to a
  // whole credit, so the platform takes 31.00 and the seller keeps 69.01. The 100.01 price makes
  // the fee fractional in minor units (3000.3). A path that floored to minor units before rounding
  // up would drop the 0.3 and take only 30.00. This pins that the renewal shares the same
  // `feeForPrice` rounding as the rest of pricing.ts.
  const sub = subscription({ id: 'sub_1', price: credit('100.01') });
  await openSub(store, sub, credit('100.01'));

  const summary = await sweepDueSubscriptions(store, workerCtx(), {
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
  // Buyer has 99.99, price is 100.00, so the charge can't be paid: LAPSED, no money moves.
  const sub = subscription({ id: 'sub_1', price: credit('100.00') });
  await openSub(store, sub, credit('99.99'));

  const summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.lapsed, ['sub_1']);
  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.deadLettered, []);
  // Nothing charged: buyer still has 99.99, seller earned nothing.
  assert.deepEqual(
    await store.ledger.balance(spendable('usr_buyer')),
    credit('99.99'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('0.00'),
  );
  assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), credit('0.00'));
  // LAPSED is final, so a future sweep won't bill this record again.
  const lapsed = await store.subscriptions.load('sub_1');
  assert.equal(lapsed!.state, 'LAPSED');
}

async function leavesANotYetDueSubscriptionAlone(store: Store): Promise<void> {
  // Next charge isn't due until 5_000, past the sweep's `now` of 1_000, so it's left alone.
  const sub = subscription({ id: 'sub_1', nextDueAt: 5_000 });
  await openSub(store, sub, credit('100.00'));

  const summary = await sweepDueSubscriptions(store, workerCtx(), {
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

  // One sweep handles both: funded one charged, broke one lapsed. An unpayable record
  // doesn't stop a payable one in the same batch.
  const summary = await sweepDueSubscriptions(store, workerCtx(), {
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
  // Two due subscriptions, different buyers, so a failure on one buyer's account read
  // affects only that record.
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

  // Wrap the store so reading the bad buyer's balance throws an error the sweep won't retry. That
  // record is dead-lettered (set aside as permanently failed, reason recorded) and marked LAPSED,
  // while the good record charges normally. One broken record doesn't block the batch.
  const faulting = faultOnBuyerBalance(store, 'usr_bad');

  const summary = await sweepDueSubscriptions(faulting, workerCtx(), {
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

// Wraps a store so any read of `badUser`'s spendable balance throws STORE.FAILURE, while every
// other method passes through. That error is treated as permanent, so the sweep gives up on the
// record and dead-letters it rather than leaving it for the next run to re-hit.
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

// Wraps a store so reading `badUser`'s spendable balance throws a plain Error rather than one of
// the project's typed errors. The sweep treats unrecognized errors as transient infra failures
// worth retrying, so this drives the retry-and-count path instead of the give-up path the
// permanent-error wrapper above triggers. Every other method passes through, so the row can still
// be picked up and re-billed. The row stays ACTIVE until the retry count hits its cap.
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

// One retryable failure under the cap leaves the subscription ACTIVE, only bumping its attempt
// count: nothing charged or lapsed, and `attempts` persists as 1 so the next sweep keeps counting
// toward the cap rather than restarting at zero.
async function bumpsAttemptsAndKeepsRetryingBelowTheCap(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  const flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');

  const summary = await sweepDueSubscriptions(flaky, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Retryable and under the cap, so the row is recorded for retry, not charged/lapsed/dead-lettered.
  assert.deepEqual(
    summary.retrying.map((r) => r.id),
    ['sub_flaky'],
  );
  assert.deepEqual(summary.charged, []);
  assert.deepEqual(summary.lapsed, []);
  assert.deepEqual(summary.deadLettered, []);
  // Bumped attempt persists to the next sweep; row stays ACTIVE and due so it's picked up again.
  const row = await store.subscriptions.load('sub_flaky');
  assert.equal(row!.state, 'ACTIVE');
  assert.equal(row!.attempts, 1);
  await store.close();
}

// A subscription hitting a retryable failure repeatedly doesn't retry forever: each sweep bumps
// `attempts`, and the sweep whose bump reaches the cap lapses the row instead of re-billing.
// Test config caps at 3, so the third consecutive failure lapses; the first two bump-and-retry.
async function lapsesAPersistentlyFailingSubscriptionAtTheCap(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  const flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');
  const ctx = workerCtx(); // testConfig().maxSubscriptionAttempts === 3

  // Sweep 1: attempts 0 -> 1, retrying.
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

  // Sweep 2: attempts 1 -> 2, still under the cap of 3, still retrying.
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

  // Sweep 3: the bump would make attempts 3, reaching the cap, so the row LAPSES instead of
  // retrying.
  const third = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(third.lapsed, ['sub_flaky']);
  assert.deepEqual(third.retrying, []);
  assert.deepEqual(third.charged, []);
  const lapsed = await store.subscriptions.load('sub_flaky');
  assert.equal(lapsed!.state, 'LAPSED');

  // A LAPSED row isn't ACTIVE, so a fourth sweep won't claim it: retrying has stopped.
  const fourth = await sweepDueSubscriptions(flaky, ctx, {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(fourth.retrying, []);
  assert.deepEqual(fourth.lapsed, []);
  await store.close();
}

// A renewal that finally succeeds clears earlier strikes: after retryable failures bump
// `attempts`, a healthy sweep charges the renewal and `markBilled` resets `attempts` to 0, so the
// cap counts only consecutive failures and a recovered subscription starts fresh.
async function resetsAttemptsToZeroOnASuccessfulRenewal(): Promise<void> {
  const store = memoryStore();
  await openSub(store, subscription({ id: 'sub_flaky' }), credit('100.00'));
  const ctx = workerCtx();

  // Two sweeps against a flaky store push attempts up to 2 without lapsing (cap is 3).
  const flaky = retryableFaultOnBuyerBalance(store, 'usr_buyer');
  await sweepDueSubscriptions(flaky, ctx, { now: 1_000, limit: 10 });
  await sweepDueSubscriptions(flaky, ctx, { now: 1_000, limit: 10 });
  assert.equal((await store.subscriptions.load('sub_flaky'))!.attempts, 2);

  // The store recovers; the next sweep charges the renewal normally and resets the counter.
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

// Wrap a store so `subscriptions.claimDue` always hands back the same stale snapshot of one
// subscription, regardless of the underlying row. This models two overlapping renewal sweepers
// that both claimed the row (period 1, due at 0) before either billed. The second sweep still
// believes the row is due for period 2 even though the first advanced it. Every other method
// passes through, so the real row's state (nextDueAt, period, balance) updates normally. Only the
// claim is frozen.
//
// This is the harness for the two guards against a double charge. First, the renewal reserves a
// one-time key naming this exact period before posting, so the second sweep finds the key taken
// and posts nothing. Second, the due-date advance is a compare-and-set: it moves the date forward
// only if the stored due date still matches the one this sweep started from, so the second sweep's
// advance fails. Either way the second sweep does nothing: no charge and no second event.
function staleClaimDue(store: Store, snapshot: Subscription): Store {
  return {
    ...store,
    subscriptions: {
      ...store.subscriptions,
      claimDue: async () => [{ ...snapshot }],
    },
  };
}

// Two overlapping sweeps over the same due subscription bill once and emit one renewed event. The
// second reads the same stale snapshot, so it short-circuits instead of double-charging: it finds
// the period's one-time key taken, and its due-date advance fails because the first already moved it.
async function billsExactlyOnceAcrossTwoOverlappingSweeps(): Promise<void> {
  const store = memoryStore();
  const sub = subscription({
    id: 'sub_1',
    price: credit('100.00'),
    nextDueAt: 0,
  });
  // Fund two periods up front so the balance check can't be what stops the second sweep (if both
  // charged, the buyer could afford it). The guards under test are the one-time per-period key and
  // the conditional due-date advance, not the funds check.
  await openSub(store, sub, credit('200.00'));
  // Both sweepers claimed this exact snapshot (period 1, due at 0) before either billed.
  const frozen = staleClaimDue(store, sub);

  const first = await sweepDueSubscriptions(frozen, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  const second = await sweepDueSubscriptions(frozen, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Only the first sweep charges; the second finds the one-time key taken and the due date already
  // advanced, so it does nothing, even though the buyer could afford a second charge.
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
  const billed = await store.subscriptions.load('sub_1');
  assert.equal(billed!.period, 2);
  assert.equal(billed!.nextDueAt, sub.nextDueAt + sub.periodMs);

  // Exactly one renewed event was enqueued across both sweeps.
  const renewed = (await store.outbox.claimBatch(10)).filter(
    (m) => m.event.type === 'economy.subscription.renewed',
  );
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0]!.event.subject, 'usr_buyer');
  await store.close();
}

// A successful renewal re-grants the perk (the subscription's sku, here 'club_pass') out to the
// new period end: after billing the buyer owns the sku, and the grant's expiry advanced one full
// period (live up to and including the new period end, gone the instant after). The clock is
// injected so the test can move time past the new expiry and watch the perk lapse.
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

  const summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(summary.charged, ['sub_1']);

  // Renewal re-granted the perk, expiring at the new period end (advanced next-due-at = 0 +
  // periodMs). owns() is evaluated against the store's clock and is inclusive of expiresAt.
  const newPeriodEnd = sub.nextDueAt + sub.periodMs;
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);

  // At exactly the new period end the perk is still owned (inclusive boundary)...
  clock.advance(newPeriodEnd);
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), true);
  // ...and one millisecond past it, the grant has lapsed: the expiry genuinely advanced.
  clock.advance(1);
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);
  await store.close();
}

// An underfunded renewal lapses the subscription, revokes the perk, and emits one lapsed event.
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

  const summary = await sweepDueSubscriptions(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.lapsed, ['sub_1']);
  assert.deepEqual(summary.charged, []);
  const lapsed = await store.subscriptions.load('sub_1');
  assert.equal(lapsed!.state, 'LAPSED');

  // The perk was revoked in the lapse transaction: the buyer no longer owns it.
  assert.equal(await store.entitlements.owns('usr_buyer', 'club_pass'), false);

  // Exactly one lapsed event, addressed to the buyer.
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
