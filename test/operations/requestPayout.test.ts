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

import { requestPayout } from '#src/operations/requestPayout.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';
import {
  requestPayout as buildRequestPayout,
  credit,
  usd,
} from '#test/support/builders.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store, Unit } from '#src/ports.ts';
import type { Amount } from '#src/money.ts';

// requestPayout is not wired to the public `economy.submit` entry point yet. Each test calls it
// directly inside one `store.transaction`, the way the entry point would run it as its final step.
// Every test gets a fresh store and Ctx, so no state is shared between tests.
function newStore(): Store {
  return memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
}

function newCtx(): Ctx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
}

// Gives a seller a starting earned balance to pay out from. Posts one balanced CREDIT pair that
// raises the seller's earned account and debits the platform's REVENUE account, like a real sale.
// REVENUE is a platform account and may go negative. The no-negative-balance guard covers only
// user accounts, so it does not trip here.
async function fundEarned(
  store: Store,
  userId: string,
  amount: Amount,
): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.ledger.append({
      txnId: 'txn_seed',
      legs: [
        debitLeg(SYSTEM.REVENUE, amount),
        creditLeg(earned(userId), amount),
      ],
      meta: { kind: 'seed' },
    });
  });
}

// Like fundEarned, but tags the posting with a funding `source` (such as 'card') so the credit
// must wait to settle before it can be paid out. The posting is recorded at the store's
// fixed-clock time of 0. Config gives each source a settlement wait in milliseconds, so with a
// `horizonMs` wait the credit becomes payable at t=horizonMs. This lets a test place a request
// before the credit is payable (rejected FUNDS_IMMATURE) or after (allowed). Each call uses a
// unique txnId so repeated fundings are not deduplicated into one posting.
async function fundEarnedFromSource(
  store: Store,
  userId: string,
  amount: Amount,
  source: string,
): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.ledger.append({
      txnId: `txn_seed_${userId}_${source}`,
      legs: [
        debitLeg(SYSTEM.REVENUE, amount),
        creditLeg(earned(userId), amount),
      ],
      meta: { kind: 'seed', source },
    });
  });
}

// Builds a Ctx with an advanceable clock and a fixed maturity horizon for every source, so a
// payout can be placed before or after the earned credit settles. The clock is shared with the
// store so that the maturity calculation and ctx.clock.now() agree.
function maturityCtx(
  clock: ReturnType<typeof fixedClock>,
  horizonMs: number,
): Ctx {
  return {
    ...newCtx(),
    clock,
    config: {
      ...testConfig(),
      maturityHorizonMs: {
        card: horizonMs,
        crypto: horizonMs,
        default: horizonMs,
      },
    },
  };
}

function run(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => requestPayout(operation, unit, ctx));
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as { code?: string }).code : undefined;
}

// A bad amount, whether the wrong currency or not strictly positive, is a programming error.
// requestPayout throws instead of returning `rejected`. Both cases share the act-and-assert below.
const faultCases = [
  { name: 'a non-CREDIT amount', amount: usd('10.00'), code: 'OP.MALFORMED' },
  {
    name: 'a non-positive amount',
    amount: credit('0.00'),
    code: 'MONEY.INVALID_AMOUNT',
  },
];

// --- The cases --------------------------------------------------------------------

async function reservesEarnedCreditIntoPayoutReserve(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('30.00'));

  const outcome = await run(
    store,
    newCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('12.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('18.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('12.00'),
  );
}

async function reservesFullEarnedBalanceIntoReserve(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('20.00'));

  await run(
    store,
    newCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20.00') }),
  );

  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20.00'),
  );
}

async function opensPayoutSagaInReservedPinningRate(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('10.00'));

  await run(
    store,
    newCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  const saga = await store.sagas.load('pay_2');
  assert.equal(saga?.state, 'RESERVED');
  assert.deepEqual(saga?.reserve, credit('10.00'));
  assert.equal(saga?.rateId, 'payout:CREDIT->USD:5/3');
}

async function rejectsAndLeavesEarnedUntouchedWhenInsufficient(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('5.00'));

  const outcome = await run(
    store,
    newCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('8.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  assert.equal(
    (outcome as Extract<Outcome, { status: 'rejected' }>).reason,
    'INSUFFICIENT_FUNDS',
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('5.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
}

async function rejectsPayoutBelowConfiguredEarnedMinimum(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('300.00'));
  const ctx: Ctx = {
    ...newCtx(),
    config: { ...testConfig(), payoutMinimumEarnedMinor: 2_000_000n },
  };

  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('100.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  assert.equal(
    (outcome as Extract<Outcome, { status: 'rejected' }>).reason,
    'BELOW_MINIMUM',
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
}

// The seller has enough earned credit overall, but it was funded from a `card` source whose
// settlement wait has not elapsed. The total balance is large enough, yet the settled part is
// not, so the payout is rejected FUNDS_IMMATURE and nothing is reserved.
async function rejectsPayoutAgainstImmatureEarnedCredit(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('30.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  // The clock is still at 0 and the credit matures at t=60_000, so none of it has cleared yet.
  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  const rejection = outcome as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.reason, 'FUNDS_IMMATURE');
  assert.equal(rejection.detail?.account, earned('usr_seller'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('30.00'),
  );
}

// Once the settlement wait elapses the credit is fully matured and the payout goes through. The
// boundary is inclusive: the credit matures at the exact moment its wait ends.
async function allowsPayoutOnceEarnedCreditHasMatured(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('30.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  // Advance to the exact moment the wait ends. The payable-balance check counts the credit as
  // settled the instant its wait elapses, not one tick later, so it is now payable.
  clock.advance(60_000);
  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('10.00'),
  );
}

// The payable-balance check restricts only the part still waiting to settle. A request for the
// cleared portion of a partly-cleared balance is allowed, but a larger one is not. Two fundings
// from the same source recorded at different times finish waiting at different moments.
async function allowsPayoutUpToTheMaturedPortion(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  // First funding is recorded at t=0, finishes its wait at t=60_000.
  await fundEarnedFromSource(store, 'usr_seller', credit('10.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  // Second funding is recorded at t=30_000, so it finishes its wait at t=90_000.
  clock.advance(30_000);
  await store.transaction(async (unit) => {
    await unit.ledger.append({
      txnId: 'txn_seed_late',
      legs: [
        debitLeg(SYSTEM.REVENUE, credit('10.00')),
        creditLeg(earned('usr_seller'), credit('10.00')),
      ],
      meta: { kind: 'seed', source: 'card' },
    });
  });

  // At t=60_000 only the first lot (10.00) has cleared. A request for exactly that passes...
  clock.advance(30_000);
  const ok = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );
  assert.equal(ok.status, 'committed');
}

async function faultsOn(amount: Amount, code: string): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('10.00'));

  await assert.rejects(
    run(store, newCtx(), buildRequestPayout({ userId: 'usr_seller', amount })),
    (error: unknown) => codeOf(error) === code,
  );
}

// Builds a Ctx with an advanceable clock and a fixed payout interval, so a second request can be
// placed inside or after the window. A payout opens a saga, the record of one in-progress payout
// that a background worker later finishes. The clock is shared with the store via the same
// `fixedClock`. The interval check reads the saga's `updatedAt` as the last-payout time, so that
// time advances in step with `ctx.clock.now()`.
function intervalCtx(
  clock: ReturnType<typeof fixedClock>,
  intervalMs: number,
): Ctx {
  return {
    ...newCtx(),
    clock,
    config: { ...testConfig(), payoutMinIntervalMs: intervalMs },
  };
}

async function rejectsSecondPayoutInsideTheMinimumInterval(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarned(store, 'usr_seller', credit('30.00'));
  const ctx = intervalCtx(clock, 60_000);

  const first = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );
  assert.equal(first.status, 'committed');

  // Advance less than the interval, so the second request must be turned down.
  clock.advance(59_999);
  const second = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(second.status, 'rejected');
  const rejection = second as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.reason, 'PAYOUT_TOO_SOON');
  assert.equal(rejection.detail?.lastRequestedAt, 0);
  assert.equal(rejection.detail?.retryAfter, 60_000);
  // The declined request set nothing aside: only the first payout's reserve is held.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('10.00'),
  );
}

async function allowsPayoutOnceTheIntervalHasElapsed(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarned(store, 'usr_seller', credit('30.00'));
  const ctx = intervalCtx(clock, 60_000);

  const first = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );
  assert.equal(first.status, 'committed');

  // The boundary is strict `<`, so a request exactly `payoutMinIntervalMs` later is allowed.
  clock.advance(60_000);
  const second = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(second.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20.00'),
  );
}

async function firstPayoutPassesWhenAnIntervalIsConfigured(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarned(store, 'usr_seller', credit('10.00'));
  const ctx = intervalCtx(clock, 60_000);

  // lastPayoutAt is null for a user with no sagas, so the first request always passes regardless
  // of the configured interval.
  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(outcome.status, 'committed');
}

describe('requestPayout', () => {
  test('reserves earned credit into PAYOUT_RESERVE', () =>
    reservesEarnedCreditIntoPayoutReserve());
  test('reserves the full earned balance into PAYOUT_RESERVE, never from spendable', () =>
    reservesFullEarnedBalanceIntoReserve());
  test('opens a payout saga in RESERVED that locks in the payout rate', () =>
    opensPayoutSagaInReservedPinningRate());
  test('rejects and leaves earned untouched when earned is insufficient', () =>
    rejectsAndLeavesEarnedUntouchedWhenInsufficient());
  test('rejects a payout below the configured earned-credit minimum', () =>
    rejectsPayoutBelowConfiguredEarnedMinimum());
  test('rejects a second payout inside the minimum interval (PAYOUT_TOO_SOON)', () =>
    rejectsSecondPayoutInsideTheMinimumInterval());
  test('allows a payout once the minimum interval has elapsed', () =>
    allowsPayoutOnceTheIntervalHasElapsed());
  test('allows the first payout even when an interval is configured', () =>
    firstPayoutPassesWhenAnIntervalIsConfigured());
  test('rejects a payout against earned credit still in its settlement wait (FUNDS_IMMATURE)', () =>
    rejectsPayoutAgainstImmatureEarnedCredit());
  test('allows a payout once the earned credit has matured', () =>
    allowsPayoutOnceEarnedCreditHasMatured());
  test('allows a payout up to the matured portion of a partly-matured balance', () =>
    allowsPayoutUpToTheMaturedPortion());
  for (const { name, amount, code } of faultCases) {
    test(`faults on ${name}`, () => faultsOn(amount, code));
  }
});
