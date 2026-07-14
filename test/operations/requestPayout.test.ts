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
  seededDigest,
  testConfig,
  makeCtx,
} from '#test/support/capabilities.ts';
import {
  requestPayout as buildRequestPayout,
  credit,
  usd,
} from '#test/support/builders.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store, Unit } from '#src/ports.ts';
import type { Amount } from '#src/money.ts';

// requestPayout is not wired to `economy.submit` yet, so each test calls the handler directly
// inside one `store.transaction`.
function newStore(): Store {
  return memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
}

// Seeds earned against REVENUE. Platform accounts may go negative; the no-negative-balance guard
// covers only user accounts.
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

// Like fundEarned, but tags the posting with a funding `source`, so the credit must mature before
// it is payable. Each call uses a unique txnId so repeated fundings are not deduplicated.
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

// The clock must be the same instance the store uses, so the maturity calculation and
// ctx.clock.now() agree.
function maturityCtx(
  clock: ReturnType<typeof fixedClock>,
  horizonMs: number,
): Ctx {
  return makeCtx({
    clock,
    config: {
      ...testConfig(),
      maturityHorizonMs: {
        card: horizonMs,
        crypto: horizonMs,
        default: horizonMs,
      },
    },
  });
}

function run(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => requestPayout(operation, unit, ctx));
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as { code?: string }).code : undefined;
}

const faultCases = [
  { name: 'a non-CREDIT amount', amount: usd('10.00'), code: 'OP.MALFORMED' },
  {
    name: 'a non-positive amount',
    amount: credit('0.00'),
    code: 'MONEY.INVALID_AMOUNT',
  },
];

async function reservesEarnedCreditIntoPayoutReserve(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('30.00'));

  const outcome = await run(
    store,
    makeCtx(),
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
    makeCtx(),
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
    makeCtx(),
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
    makeCtx(),
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
  const ctx = makeCtx({
    config: { ...testConfig(), payoutMinimumEarnedMinor: 2_000_000n },
  });

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

async function rejectsPayoutAgainstImmatureEarnedCredit(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('30.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

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

// The maturity boundary is inclusive: the credit matures at the exact moment its wait ends.
async function allowsPayoutOnceEarnedCreditHasMatured(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('30.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

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

async function allowsPayoutUpToTheMaturedPortion(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('10.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

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

  // At t=60_000 only the first lot has matured.
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
    run(store, makeCtx(), buildRequestPayout({ userId: 'usr_seller', amount })),
    (error: unknown) => codeOf(error) === code,
  );
}

// The clock must be the same instance the store uses: the interval check reads the saga's
// `updatedAt`, which the store stamps with its clock.
function intervalCtx(
  clock: ReturnType<typeof fixedClock>,
  intervalMs: number,
): Ctx {
  return makeCtx({
    clock,
    config: { ...testConfig(), payoutMinIntervalMs: intervalMs },
  });
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

  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
  );

  assert.equal(outcome.status, 'committed');
}

async function allowsAPayoutForAClearedPayee(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('30.00'));
  const asked: string[] = [];
  const ctx = makeCtx({
    payees: {
      status: async (userId) => {
        asked.push(userId);
        return { state: 'CLEARED' };
      },
    },
  });

  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('12.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(asked, ['usr_seller']);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('12.00'),
  );
}

async function rejectsAPayoutForAnUnverifiedPayee(): Promise<void> {
  for (const state of ['PENDING', 'BLOCKED', 'NONE'] as const) {
    const store = newStore();
    await fundEarned(store, 'usr_seller', credit('30.00'));
    const ctx = makeCtx({
      payees: { status: async () => ({ state }) },
    });

    const outcome = await run(
      store,
      ctx,
      buildRequestPayout({ userId: 'usr_seller', amount: credit('12.00') }),
    );

    assert.equal(outcome.status, 'rejected', state);
    assert.equal(
      outcome.status === 'rejected' ? outcome.reason : undefined,
      'PAYEE_UNVERIFIED',
      state,
    );
    assert.equal(
      outcome.status === 'rejected' ? outcome.detail?.state : undefined,
      state,
    );
    assert.deepEqual(
      await store.ledger.balance(earned('usr_seller')),
      credit('30.00'),
      state,
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
      state,
    );
  }
}

async function skipsThePayeeGateWhenNoDirectoryIsWired(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('30.00'));

  const outcome = await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('12.00') }),
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
  test('allows a payout for a cleared payee when a directory is wired', () =>
    allowsAPayoutForAClearedPayee());
  test('rejects PAYEE_UNVERIFIED when the directory answers anything but cleared', () =>
    rejectsAPayoutForAnUnverifiedPayee());
  test('skips the payee gate entirely when no directory is wired', () =>
    skipsThePayeeGateWhenNoDirectoryIsWired());
  for (const { name, amount, code } of faultCases) {
    test(`faults on ${name}`, () => faultsOn(amount, code));
  }
});
