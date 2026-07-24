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
  hasCode,
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
import type { Rates, Store, Unit } from '#src/ports.ts';
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

const faultCases = [
  { name: 'a non-CREDIT amount', amount: usd('100.00'), code: 'OP.MALFORMED' },
  {
    name: 'a non-positive amount',
    amount: credit('0.00'),
    code: 'MONEY.INVALID_AMOUNT',
  },
];

async function reservesEarnedCreditIntoPayoutReserve(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('50000.00'));

  const outcome = await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('30000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function reservesFullEarnedBalanceIntoReserve(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('25000.00'));

  await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('25000.00') }),
  );

  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('25000.00'),
  );
}

async function opensPayoutSagaInReservedPinningRate(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('20000.00'));

  await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  const saga = await store.sagas.load('pay_1');
  assert.equal(saga?.state, 'RESERVED');
  assert.deepEqual(saga?.reserve, credit('20000.00'));
  assert.equal(saga?.rateId, 'payout:CREDIT->USD:5/3');
}

async function carriesTheSagaIdInTheTransactionMeta(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('20000.00'));

  const outcome = await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'committed');
  const committed = outcome as Extract<Outcome, { status: 'committed' }>;
  const sagaId = committed.transaction.meta.sagaId;
  assert.equal(typeof sagaId, 'string');
  const saga = await store.sagas.load(sagaId as string);
  assert.equal(saga?.state, 'RESERVED');
}

async function rejectsAndLeavesEarnedUntouchedWhenInsufficient(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('15000.00'));

  const outcome = await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  assert.deepEqual(
    (outcome as Extract<Outcome, { status: 'rejected' }>).detail,
    {
      reason: 'INSUFFICIENT_FUNDS',
      account: earned('usr_seller'),
      need: credit('20000.00'),
      have: credit('15000.00'),
    },
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('15000.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
}

async function rejectsPayoutBelowConfiguredEarnedMinimum(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('30000.00'));
  const ctx = makeCtx({
    config: { ...testConfig(), payoutMinimumEarnedMinor: 2_000_000n },
  });

  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('15000.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  assert.deepEqual(
    (outcome as Extract<Outcome, { status: 'rejected' }>).detail,
    {
      reason: 'BELOW_MINIMUM',
      minimum: credit('20000.00'),
      amount: credit('15000.00'),
    },
  );
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
}

async function rejectsPayoutAgainstImmatureEarnedCredit(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('50000.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'rejected');
  const rejection = outcome as Extract<Outcome, { status: 'rejected' }>;
  // Funded at time 0 with a 60s horizon: the refusal says exactly when a retry clears.
  assert.deepEqual(rejection.detail, {
    reason: 'FUNDS_IMMATURE',
    source: 'card',
    availableAt: 60_000,
  });
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('0.00'),
  );
  assert.deepEqual(
    await store.ledger.balance(earned('usr_seller')),
    credit('50000.00'),
  );
}

// The maturity boundary is inclusive: the credit matures at the exact moment its wait ends.
async function allowsPayoutOnceEarnedCreditHasMatured(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('50000.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  clock.advance(60_000);
  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function allowsPayoutUpToTheMaturedPortion(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarnedFromSource(store, 'usr_seller', credit('20000.00'), 'card');
  const ctx = maturityCtx(clock, 60_000);

  clock.advance(30_000);
  await store.transaction(async (unit) => {
    await unit.ledger.append({
      txnId: 'txn_seed_late',
      legs: [
        debitLeg(SYSTEM.REVENUE, credit('20000.00')),
        creditLeg(earned('usr_seller'), credit('20000.00')),
      ],
      meta: { kind: 'seed', source: 'card' },
    });
  });

  // At t=60_000 only the first lot has matured.
  clock.advance(30_000);
  const ok = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );
  assert.equal(ok.status, 'committed');
}

async function faultsOn(amount: Amount, code: string): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('20000.00'));

  await assert.rejects(
    run(store, makeCtx(), buildRequestPayout({ userId: 'usr_seller', amount })),
    hasCode(code),
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
  await fundEarned(store, 'usr_seller', credit('50000.00'));
  const ctx = intervalCtx(clock, 60_000);

  const first = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );
  assert.equal(first.status, 'committed');

  clock.advance(59_999);
  const second = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(second.status, 'rejected');
  const rejection = second as Extract<Outcome, { status: 'rejected' }>;
  assert.deepEqual(rejection.detail, {
    reason: 'PAYOUT_TOO_SOON',
    retryAt: 60_000,
  });
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function allowsPayoutOnceTheIntervalHasElapsed(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarned(store, 'usr_seller', credit('50000.00'));
  const ctx = intervalCtx(clock, 60_000);

  const first = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );
  assert.equal(first.status, 'committed');

  // The boundary is strict `<`, so a request exactly `payoutMinIntervalMs` later is allowed.
  clock.advance(60_000);
  const second = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(second.status, 'committed');
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('40000.00'),
  );
}

async function firstPayoutPassesWhenAnIntervalIsConfigured(): Promise<void> {
  const clock = fixedClock(0);
  const store = memoryStore({ digest: seededDigest(1), clock });
  await fundEarned(store, 'usr_seller', credit('20000.00'));
  const ctx = intervalCtx(clock, 60_000);

  const outcome = await run(
    store,
    ctx,
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'committed');
}

async function allowsAPayoutForAClearedPayee(): Promise<void> {
  const store = newStore();
  await fundEarned(store, 'usr_seller', credit('50000.00'));
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
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(asked, ['usr_seller']);
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
    credit('20000.00'),
  );
}

async function rejectsAPayoutForAnUnverifiedPayee(): Promise<void> {
  for (const state of ['PENDING', 'BLOCKED', 'NONE'] as const) {
    const store = newStore();
    await fundEarned(store, 'usr_seller', credit('50000.00'));
    const ctx = makeCtx({
      payees: { status: async () => ({ state }) },
    });

    const outcome = await run(
      store,
      ctx,
      buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
    );

    assert.equal(outcome.status, 'rejected', state);
    assert.deepEqual(
      outcome.status === 'rejected' ? outcome.detail : undefined,
      { reason: 'PAYEE_UNVERIFIED', userId: 'usr_seller' },
      state,
    );
    assert.deepEqual(
      await store.ledger.balance(earned('usr_seller')),
      credit('50000.00'),
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
  await fundEarned(store, 'usr_seller', credit('50000.00'));

  const outcome = await run(
    store,
    makeCtx(),
    buildRequestPayout({ userId: 'usr_seller', amount: credit('20000.00') }),
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
  test('carries the opened saga id in the transaction meta', () =>
    carriesTheSagaIdInTheTransactionMeta());
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

describe('requestPayout Pricing At Request', () => {
  test('stores the USD quote on the saga at the request-time rate', async () => {
    const store = newStore();
    await fundEarned(store, 'usr_quote', credit('20000.00'));

    const outcome = await store.transaction((unit) =>
      requestPayout(
        buildRequestPayout({ userId: 'usr_quote', amount: credit('20000.00') }),
        unit,
        makeCtx(),
      ),
    );

    assert.equal(outcome.status, 'committed');
    const sagaId = (
      outcome as { transaction: { meta: Record<string, unknown> } }
    ).transaction.meta.sagaId as string;
    const saga = await store.sagas.load(sagaId);
    // 20000.00 CREDIT at the fixed payout rate 5/10^3, floored: $100.00.
    assert.deepEqual(saga?.payoutUsd, usd('100.00'));
  });

  test('rejects a payout rate above par by name', async () => {
    const store = newStore();
    await fundEarned(store, 'usr_over', credit('20000.00'));
    const rates: Rates = {
      buy: () => ({ rate: 1n, scale: 2, rateId: 'r_buy' }),
      par: () => ({ rate: 5n, scale: 3, rateId: 'r_par' }),
      payout: async () => ({ rate: 6n, scale: 3, rateId: 'r_payout_high' }),
    };

    await assert.rejects(
      store.transaction((unit) =>
        requestPayout(
          buildRequestPayout({
            userId: 'usr_over',
            amount: credit('20000.00'),
          }),
          unit,
          makeCtx({ rates }),
        ),
      ),
      hasCode('CONFIG.INVALID'),
    );
  });
});
