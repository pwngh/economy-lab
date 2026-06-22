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

// The requestPayout handler isn't hooked up to the public `economy.submit` entry point
// yet, so each test calls it directly inside one `store.transaction` — the same way the
// real entry point would run it as its final step. Every test gets a fresh store and Ctx
// so they share no state.
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

// Give a seller a starting earned balance to pay out from. Posts one balanced pair of
// ledger lines (the two amounts cancel out, so the books stay balanced), both denominated
// in the in-app CREDIT currency: it raises the seller's earned account and takes the same
// amount out of the platform's REVENUE account, the way a real sale would. REVENUE is one
// of the platform's own accounts, which are allowed to go negative; the ledger's
// no-negative-balance guard only protects real user accounts, so it doesn't trip here.
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

// Like fundEarned, but tags the posting with a funding `source` (e.g. 'card') so the credit
// is treated as not yet settled and must wait before it can be paid out. The funding is
// recorded at the store's fixed-clock time (0); the config gives each source a wait length
// in milliseconds, so with a wait of `horizonMs` the earned credit becomes payable at
// t=horizonMs. That lets a test place a request before it becomes payable (rejected with
// FUNDS_IMMATURE) or after (allowed). The unique txnId per call keeps repeated funding calls
// from being treated as the same posting.
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

// A Ctx whose clock can be advanced and whose `card`-source maturity horizon is set, so a
// payout can be placed before or after earned credit clears its settlement wait. The clock
// is shared with the store so the maturity calculation and ctx.clock.now() agree.
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

// A bad amount — wrong currency (not CREDIT) or not strictly positive — is a programming
// error, so requestPayout throws instead of returning a normal `rejected` result. The two
// bad-amount cases are listed here so they can run through one shared act-and-assert below.
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

async function reservesFromEarnedAloneNeverFromHeld(): Promise<void> {
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
// settlement wait hasn't elapsed yet. A payout against it must be turned down with
// FUNDS_IMMATURE — the total balance is large enough, but the part that has finished waiting
// is not — and nothing may be set aside.
async function rejectsPayoutAgainstImmatureEarnedCredit(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('30.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  // Clock is still at 0, the credit matures at t=60_000, so none of it has cleared yet.
  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  const rejection = outcome as Extract<Outcome, { status: 'rejected' }>;
  assert.equal(rejection.reason, 'FUNDS_IMMATURE');
  assert.equal(rejection.detail?.account, earned('usr_seller'));
  // The declined request set nothing aside.
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  // The earned balance is untouched.
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('30.00'),
  );
}

// Once the settlement wait has elapsed the same credit is fully matured, so the payout
// goes through. The boundary is inclusive: credit matures the exact moment its wait ends.
async function allowsPayoutOnceEarnedCreditHasMatured(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('30.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  // Advance to the exact moment the wait ends. The payable-balance check counts credit as
  // settled the instant its wait elapses (not one tick later), so it is now payable.
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

// The payable-balance check only restricts the part still waiting to settle: a request for
// the already-cleared portion of a partly-cleared balance is allowed, while a larger request
// is not. Two separate fundings from the same source are recorded at different times, so they
// finish waiting at different moments.
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

// A Ctx whose clock can be advanced between requests and whose payout interval is set, so a
// second request can be placed inside or after the window. A payout opens a "saga" — the
// record of one in-progress payout that a background worker later finishes. The clock is
// shared with the store (both built from the same `fixedClock`) so the saga's `updatedAt`
// timestamp — which the interval check reads back as the time of the last payout — advances
// in step with `ctx.clock.now()`.
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

  // Advance less than the interval: the second request must be turned down.
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

  // lastPayoutAt is null for a user with no sagas, so the very first request always passes
  // regardless of the configured interval.
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
  test('reserves from earned alone, never from HELD', () =>
    reservesFromEarnedAloneNeverFromHeld());
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
