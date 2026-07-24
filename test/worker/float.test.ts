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

import { sweepFloatCoverage } from '#src/worker/treasury.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit, usd } from '#test/support/builders.ts';
import { makeWorkerCtx } from '#test/support/capabilities.ts';

import type { Amount } from '#src/money.ts';
import type { Saga, SagaState, Store } from '#src/ports.ts';

async function openSaga(
  store: Store,
  id: string,
  state: SagaState,
): Promise<void> {
  const row: Saga = {
    id,
    userId: 'usr_seller',
    reserve: credit('20000.00'),
    rateId: 'payout:CREDIT->USD:1',
    txnId: 'txn_anchor_float',
    state,
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
  });
}

function feedOf(balance: Amount): { balance(): Promise<Amount> } {
  return { balance: async () => balance };
}

describe('sweepFloatCoverage', () => {
  test('reports covered when the float meets reserved and submitted obligations', async () => {
    const store = memoryStore();
    await openSaga(store, 'pay_1', 'RESERVED');
    await openSaga(store, 'pay_2', 'SUBMITTED');
    await openSaga(store, 'pay_3', 'SETTLED');

    const summary = await sweepFloatCoverage(
      store,
      makeWorkerCtx(),
      feedOf(usd('200.00')),
      { now: 0 },
    );

    assert.deepEqual(summary.breaches, []);
    assert.equal(summary.position!.covered, true);
    assert.deepEqual(summary.position!.obligations, usd('200.00'));
    assert.deepEqual(summary.position!.shortfall, usd('0.00'));
  });

  test('raises an alert-level breach when the float falls short of obligations', async () => {
    const store = memoryStore();
    await openSaga(store, 'pay_1', 'SUBMITTED');

    const summary = await sweepFloatCoverage(
      store,
      makeWorkerCtx(),
      feedOf(usd('50.00')),
      { now: 0 },
    );

    assert.equal(summary.position!.covered, false);
    assert.deepEqual(summary.breaches, [
      { shortfall: 'USD:50.00', obligations: 'USD:100.00', float: 'USD:50.00' },
    ]);
  });

  test('classifies a feed failure for retry instead of throwing', async () => {
    const store = memoryStore();
    await openSaga(store, 'pay_1', 'SUBMITTED');
    const failing = {
      balance: async (): Promise<Amount> => {
        throw fault(ERROR_CODES.PROVIDER_FAILURE, 'wallet endpoint down', {
          retryable: true,
        });
      },
    };

    const summary = await sweepFloatCoverage(store, makeWorkerCtx(), failing, {
      now: 0,
    });

    assert.equal(summary.position, null);
    assert.deepEqual(summary.retrying, [{ code: 'PROVIDER.FAILURE' }]);
    assert.deepEqual(summary.breaches, []);
  });

  test('a raw feed throw reads as the port failing, not storage', async () => {
    const store = memoryStore();
    await openSaga(store, 'pay_1', 'SUBMITTED');
    const failing = {
      balance: async (): Promise<Amount> => {
        throw new Error('wallet endpoint fell over');
      },
    };

    const summary = await sweepFloatCoverage(store, makeWorkerCtx(), failing, {
      now: 0,
    });

    assert.equal(summary.position, null);
    assert.deepEqual(summary.retrying, [{ code: 'PROVIDER.FAILURE' }]);
  });
});
