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
 * reversePayout: operator-run reversal of a payout that has not sent real money — it returns the
 * reserve to earned and drives the saga to FAILED. State, posting, and replay tests call the
 * handler directly inside one `store.transaction`; the permission check and the
 * `economy.payout.reversed` event go through the full `economy.submit` entry point.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOf } from '#test/support/economy.ts';
import { hasCode } from '#test/support/capabilities.ts';

import { reversePayout } from '#src/operations/reversePayout.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { AccountRef } from '#src/accounts.ts';
import { credit, sagaAnchor, usd } from '#test/support/builders.ts';
import { reversePayout as makeReversePayout } from '#src/operation.ts';
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
import type { Amount } from '#src/money.ts';
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

// Opens a saga with its reserve already in escrow, as a payout request leaves it.
async function openReservedSaga(
  store: Store,
  overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>,
): Promise<Saga> {
  const row: Saga = {
    userId: 'usr_seller',
    reserve: credit('20000.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: usd('100.00'),
    txnId: `txn_anchor_${overrides.id}`,
    ...overrides,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    if (row.state !== 'FAILED') {
      // Fund earned, then post the row's anchor (see sagaAnchor); the reverse guard re-proves
      // the row against it.
      await unit.ledger.append({
        txnId: `txn_seed_${row.id}`,
        legs: [
          creditLeg(earned(row.userId), row.reserve),
          debitLeg(SYSTEM.STORED_VALUE, row.reserve),
        ],
        meta: { kind: 'seed' },
      });
      await unit.ledger.append(sagaAnchor(row));
    }
  });
  return row;
}

function buildReversePayout(o: {
  sagaId: string;
  userId?: string;
  reason?: string;
  actor?: Operation['actor'];
  providerReported?: boolean;
}): Operation {
  // Keeps its own deterministic idempotencyKey (idem_<sagaId>) so the duplicate-key idempotency
  // cases here stay stable; delegates to the public constructor so the Operation shape is single-sourced.
  return makeReversePayout({
    idempotencyKey: `idem_${o.sagaId}`,
    actor: o.actor ?? { kind: 'operator', operatorId: 'op_test' },
    userId: o.userId ?? 'usr_seller',
    sagaId: o.sagaId,
    reason: o.reason ?? 'fraud hold',
    ...(o.providerReported === undefined
      ? {}
      : { providerReported: o.providerReported }),
  });
}

function run(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => reversePayout(operation, unit, ctx));
}

async function stateOf(
  store: Store,
  sagaId: string,
): Promise<SagaState | undefined> {
  const saga = await store.sagas.load(sagaId);
  return saga?.state;
}

async function balanceOf(store: Store, account: AccountRef): Promise<Amount> {
  return store.transaction((unit) => unit.ledger.balance(account));
}

describe('reversePayout', () => {
  test('a RESERVED payout returns the reserve to earned and fails the saga', async () => {
    const store = newStore();
    const saga = await openReservedSaga(store, {
      id: 'pay_1',
      state: 'RESERVED',
    });

    const outcome = await run(
      store,
      newCtx(),
      buildReversePayout({ sagaId: 'pay_1' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await stateOf(store, 'pay_1'), 'FAILED');
    const earnedBalance = await balanceOf(store, earned(saga.userId));
    assert.deepEqual(earnedBalance, credit('20000.00'));
    const reserveBalance = await balanceOf(store, SYSTEM.PAYOUT_RESERVE);
    assert.deepEqual(reserveBalance, credit('0.00'));
  });

  test('a SUBMITTED payout aged past maxPayoutAgeMs is reversible', async () => {
    const store = newStore();
    const ctx = newCtx();
    // The age gate reads `updatedAt` as when the payout entered SUBMITTED; set it past
    // maxPayoutAgeMs so the provider is presumed never to have paid.
    await openReservedSaga(store, {
      id: 'pay_2',
      state: 'SUBMITTED',
      updatedAt: ctx.clock.now() - ctx.config.maxPayoutAgeMs - 1,
    });

    const outcome = await run(
      store,
      ctx,
      buildReversePayout({ sagaId: 'pay_2' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await stateOf(store, 'pay_2'), 'FAILED');
    assert.deepEqual(
      await balanceOf(store, earned('usr_seller')),
      credit('20000.00'),
    );
  });

  test('a freshly-SUBMITTED payout still within maxPayoutAgeMs is refused and posts nothing', async () => {
    const store = newStore();
    const ctx = newCtx();
    await openReservedSaga(store, {
      id: 'pay_live',
      state: 'SUBMITTED',
      updatedAt: ctx.clock.now(),
    });

    await assert.rejects(
      run(store, ctx, buildReversePayout({ sagaId: 'pay_live' })),
      hasCode('SAGA.INVALID_TRANSITION'),
    );

    assert.equal(await stateOf(store, 'pay_live'), 'SUBMITTED');
    assert.deepEqual(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      credit('20000.00'),
    );
    assert.deepEqual(
      await balanceOf(store, earned('usr_seller')),
      credit('0.00'),
    );
  });

  test('a provider-reported failure reverses a still-live SUBMITTED payout', async () => {
    const store = newStore();
    const ctx = newCtx();
    await openReservedSaga(store, {
      id: 'pay_rail',
      state: 'SUBMITTED',
      updatedAt: ctx.clock.now(),
    });

    const outcome = await run(
      store,
      ctx,
      buildReversePayout({
        sagaId: 'pay_rail',
        reason: 'payout.provider_failed',
        actor: { kind: 'system', service: 'webhook:payouts' },
        providerReported: true,
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await stateOf(store, 'pay_rail'), 'FAILED');
    assert.deepEqual(
      await balanceOf(store, earned('usr_seller')),
      credit('20000.00'),
    );
    assert.deepEqual(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
  });

  test('replay (a saga already FAILED) is a duplicate no-op that posts nothing', async () => {
    const store = newStore();
    await openReservedSaga(store, { id: 'pay_3', state: 'RESERVED' });
    const ctx = newCtx();

    const first = await run(
      store,
      ctx,
      buildReversePayout({ sagaId: 'pay_3' }),
    );
    assert.equal(first.status, 'committed');
    const afterFirst = await balanceOf(store, earned('usr_seller'));

    const second = await run(
      store,
      ctx,
      buildReversePayout({ sagaId: 'pay_3' }),
    );
    assert.equal(second.status, 'duplicate');
    const afterSecond = await balanceOf(store, earned('usr_seller'));
    assert.deepEqual(afterSecond, afterFirst);
    assert.deepEqual(afterSecond, credit('20000.00'));
  });
});

describe('reversePayout — Refusals & Validation', () => {
  test('a SETTLED payout throws INVALID_TRANSITION and posts nothing', async () => {
    const store = newStore();
    await openReservedSaga(store, { id: 'pay_4', state: 'SETTLED' });

    await assert.rejects(
      run(store, newCtx(), buildReversePayout({ sagaId: 'pay_4' })),
      hasCode('SAGA.INVALID_TRANSITION'),
    );

    assert.equal(await stateOf(store, 'pay_4'), 'SETTLED');
    const earnedBalance = await balanceOf(store, earned('usr_seller'));
    assert.deepEqual(earnedBalance, credit('0.00'));
  });

  test('an unknown sagaId is operator error (a thrown fault)', async () => {
    const store = newStore();
    await assert.rejects(
      run(store, newCtx(), buildReversePayout({ sagaId: 'pay_missing' })),
      hasCode('OP.MALFORMED'),
    );
  });

  test('a blank reason is rejected', async () => {
    const store = newStore();
    await openReservedSaga(store, { id: 'pay_5', state: 'RESERVED' });
    await assert.rejects(
      run(
        store,
        newCtx(),
        buildReversePayout({ sagaId: 'pay_5', reason: '   ' }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('a userId that does not match the saga is rejected and posts nothing', async () => {
    const store = newStore();
    await openReservedSaga(store, { id: 'pay_8', state: 'RESERVED' });

    // The framework locks the account named by the operation's userId, but the reversal credits
    // the seller named on the payout; a mismatch would credit an account that was never locked.
    await assert.rejects(
      run(
        store,
        newCtx(),
        buildReversePayout({ sagaId: 'pay_8', userId: 'usr_other' }),
      ),
      hasCode('OP.MALFORMED'),
    );

    assert.equal(await stateOf(store, 'pay_8'), 'RESERVED');
    assert.deepEqual(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      credit('20000.00'),
    );
  });
});

describe('reversePayout Through Submit', () => {
  test('an operator reversal emits one economy.payout.reversed', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy: Economy = makeEconomy(1, store);
    await openReservedSaga(store, { id: 'pay_6', state: 'RESERVED' });

    const outcome = await economy.submit(
      buildReversePayout({ sagaId: 'pay_6', reason: 'chargeback' }),
    );
    assert.equal(outcome.status, 'committed');

    const events = await eventsOf(store);
    const reversed = events.filter((e) => e.type === 'economy.payout.reversed');
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0]!.audience, 'internal');
    assert.equal(reversed[0]!.subject, 'usr_seller');
    assert.deepEqual(reversed[0]!.data, {
      sagaId: 'pay_6',
      reason: 'chargeback',
    });
  });

  test('a non-privileged user actor is UNAUTHORIZED', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy: Economy = makeEconomy(1, store);
    await openReservedSaga(store, { id: 'pay_7', state: 'RESERVED' });

    await assert.rejects(
      economy.submit(
        buildReversePayout({
          sagaId: 'pay_7',
          actor: { kind: 'user', userId: 'usr_seller' },
        }),
      ),
      hasCode('AUTH.UNAUTHORIZED'),
    );

    assert.equal(await stateOf(store, 'pay_7'), 'RESERVED');
  });
});
