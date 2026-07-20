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

/**
 * settlePayout: the SUBMITTED -> SETTLED step of a payout saga, driven by the provider's
 * settlement webhook. Ledger, state, and rollback tests call the handler directly inside one
 * `store.transaction` — settlePayout enqueues its own event in that transaction; the clean-settle
 * event and the privileged-actor gate go through the full `economy.submit` entry point.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from '#test/support/capabilities.ts';

import { settlePayout } from '#src/operations/settlePayout.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { SYSTEM } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';
import {
  credit,
  usd,
  settlePayout as buildSettlePayout,
} from '#test/support/builders.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  silentMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';

import type { Ctx, Economy, Operation, Outcome } from '#src/contract.ts';
import type { Saga, SagaState, Store, Unit } from '#src/ports.ts';

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
    meter: silentMeter(),
  };
}

// Opens a saga with its reserve already in escrow, as the worker leaves a SUBMITTED payout. The
// seed balances against STORED_VALUE, a platform account exempt from the overdraft rule.
async function openSubmittedSaga(
  store: Store,
  overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>,
): Promise<Saga> {
  const row: Saga = {
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: 'prov_pay_1',
    reason: null,
    attempts: 1,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
    ...overrides,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    await unit.ledger.append({
      txnId: `txn_seed_${row.id}`,
      legs: [
        creditLeg(SYSTEM.PAYOUT_RESERVE, row.reserve),
        debitLeg(SYSTEM.STORED_VALUE, row.reserve),
      ],
      meta: { kind: 'seed' },
    });
  });
  return row;
}

function run(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => settlePayout(operation, unit, ctx));
}

async function stateOf(
  store: Store,
  id: string,
): Promise<SagaState | undefined> {
  return (await store.sagas.load(id))?.state;
}

// Before the settle's first transaction, another settle flips the saga out of SUBMITTED, so the
// guarded advance matches no row. The flip changes only the state and posts nothing.
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

describe('settlePayout', () => {
  test('settles a submitted saga with both the credit-side and USD-side postings', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    const outcome = await run(
      store,
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_1' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('4.00'),
    );
    // TRUST_CASH is debit-normal, so cash leaving custody reads negative; the reserved 4.00 CREDIT
    // converts at the payout rate to $0.02.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('-0.02'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      usd('0.02'),
    );
    const settled = await store.sagas.load('pay_1');
    assert.equal(settled!.state, 'SETTLED');
    assert.deepEqual(settled!.payoutUsd, usd('0.02'));
    assert.equal(settled!.reason, null);
  });

  test('emits exactly one economy.payout.settled event carrying the money detail', async () => {
    const store = newStore();
    const economy: Economy = makeEconomy(1, store);
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    const outcome = await economy.submit(
      buildSettlePayout({ sagaId: 'pay_1' }),
    );
    assert.equal(outcome.status, 'committed');

    const messages = await store.outbox.claimBatch(10);
    const settled = messages.filter(
      (m) => m.event.type === 'economy.payout.settled',
    );
    assert.equal(settled.length, 1);
    const event = settled[0]!.event;
    assert.equal(event.audience, 'internal');
    assert.equal(event.subject, 'usr_seller');
    assert.equal(event.data.sagaId, 'pay_1');
    assert.equal(event.data.usd, encodeAmount(usd('0.02')));
  });

  test('answers duplicate on a lost race rather than double-paying', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    // The rival flipped the saga to SETTLED before this settle's transaction, so the load
    // finds the work already done and answers duplicate with nothing posted.
    const outcome = await run(
      raceSettleOnce(store, 'pay_1'),
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_1' }),
    );
    assert.equal(outcome.status, 'duplicate');

    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      usd('0.00'),
    );
  });

  test('a raced settle emits no settled event', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    const outcome = await run(
      raceSettleOnce(store, 'pay_1'),
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_1' }),
    );
    assert.equal(outcome.status, 'duplicate');

    assert.deepEqual(
      (await store.outbox.claimBatch(10)).filter(
        (m) => m.event.type === 'economy.payout.settled',
      ),
      [],
    );
  });

  test('a settle redelivered after settlement answers duplicate, not a fault', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });
    await run(store, newCtx(), buildSettlePayout({ sagaId: 'pay_1' }));

    // The rail re-sends the settlement under a fresh event id (the builder mints a fresh
    // key per call): past the event-id dedupe, straight into the operation, and still
    // applied at most once.
    const redelivered = await run(
      store,
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_1' }),
    );
    assert.equal(redelivered.status, 'duplicate');
    assert.deepEqual(redelivered.transaction.legs, []);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
  });

  test('refuses a pre-submit saga retryably and posts nothing', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_resv', state: 'RESERVED' });

    // The webhook raced the submit sweep; once the sweep submits, a retry settles cleanly.
    await assert.rejects(
      () => run(store, newCtx(), buildSettlePayout({ sagaId: 'pay_resv' })),
      (error) =>
        hasCode('SAGA.INVALID_TRANSITION')(error) &&
        (error as { retryable?: boolean }).retryable === true,
    );

    assert.equal(await stateOf(store, 'pay_resv'), 'RESERVED');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
  });

  test('a settle claim against a failed payout is a hard fault, never a retry', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_f', state: 'FAILED' });

    // The reserve was already returned; a provider claiming this payout settled is a real
    // money conflict for an operator, so it must not resolve quietly or burn retries.
    await assert.rejects(
      () => run(store, newCtx(), buildSettlePayout({ sagaId: 'pay_f' })),
      (error) =>
        hasCode('SAGA.INVALID_TRANSITION')(error) &&
        (error as { retryable?: boolean }).retryable === false,
    );
  });

  test('throws a mapping fault for an unknown saga id', async () => {
    const store = newStore();

    await assert.rejects(
      () => run(store, newCtx(), buildSettlePayout({ sagaId: 'pay_missing' })),
      hasCode('OP.MALFORMED'),
    );
  });

  test('an end user may not settle their own payout (UNAUTHORIZED)', async () => {
    const store = newStore();
    const economy: Economy = makeEconomy(1, store);
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    await assert.rejects(
      () =>
        economy.submit(
          buildSettlePayout({
            sagaId: 'pay_1',
            actor: { kind: 'user', userId: 'usr_seller' },
          }),
        ),
      hasCode('AUTH.UNAUTHORIZED'),
    );

    assert.equal(await stateOf(store, 'pay_1'), 'SUBMITTED');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
  });
});

describe('settlePayout Pricing At Request', () => {
  test('settles at the stored quote even when the current rate has moved', async () => {
    const store = newStore();
    const row = await openSubmittedSaga(store, {
      id: 'pay_quote',
      state: 'SUBMITTED',
      payoutUsd: usd('0.09'),
    });

    const outcome = await run(
      store,
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_quote' }),
    );

    assert.equal(outcome.status, 'committed');
    // The current fixed rate would convert the 4.00 reserve to $0.02; the stored quote wins.
    const settled = await store.sagas.load('pay_quote');
    assert.deepEqual(settled?.payoutUsd, usd('0.09'));
    const trust = await store.ledger.balance(SYSTEM.TRUST_CASH);
    assert.equal(trust.minor, -9n);
    assert.equal(
      (outcome as { transaction: { meta: Record<string, unknown> } })
        .transaction.meta.rateId,
      row.rateId,
    );
  });

  test('a row opened before pricing-at-request settles at the current rate', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_legacy', state: 'SUBMITTED' });

    const outcome = await run(
      store,
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_legacy' }),
    );

    assert.equal(outcome.status, 'committed');
    const settled = await store.sagas.load('pay_legacy');
    assert.deepEqual(settled?.payoutUsd, usd('0.02'));
  });
});
