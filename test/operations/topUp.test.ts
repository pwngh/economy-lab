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

import { topUp } from '#src/operations/topUp.ts';
import { makeCtx, hasCode } from '#test/support/capabilities.ts';
import { seededStore as makeStore } from '#test/support/economy.ts';
import { topUp as topUpOp, credit, usd } from '#test/support/builders.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

function fixture(): { store: Store; ctx: Ctx } {
  return { store: makeStore(), ctx: makeCtx() };
}

async function applyTopUp(
  store: Store,
  ctx: Ctx,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => topUp(operation, unit, ctx));
}

describe('topUp Issuance', () => {
  test('issues spendable credits against STORED_VALUE', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.STORED_VALUE),
      credit('10.00'),
    );
  });

  test('splits the buyer cash into trust backing and purchase-fee revenue', async () => {
    const { store, ctx } = fixture();

    await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    // At the test rates: $0.10 gross at the $0.01 buy rate, $0.05 backing at the $0.005 par rate,
    // $0.05 spread to REVENUE_USD. USD_CLEARING is debit-normal, so the gross credit reads -0.10.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.05'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE_USD),
      usd('0.05'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      usd('-0.10'),
    );
  });

  test('never debits REVENUE — issuance is not house revenue', async () => {
    const { store, ctx } = fixture();

    await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      toAmount('CREDIT', 0n),
    );
  });

  test('returns the CREDIT issuance transaction, not the cash posting', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(
      outcome.status === 'committed' &&
        outcome.transaction.legs.some(
          (leg) => leg.account === spendable('usr_buyer'),
        ),
      true,
    );
  });
});

describe('topUp Validation', () => {
  test('throws OP.MALFORMED when the amount is USD', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyTopUp(
        store,
        ctx,
        topUpOp({ userId: 'usr_buyer', amount: usd('10.00') }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws MONEY.INVALID_AMOUNT when the amount is not positive', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyTopUp(
        store,
        ctx,
        topUpOp({ userId: 'usr_buyer', amount: credit('0.00') }),
      ),
      hasCode('MONEY.INVALID_AMOUNT'),
    );
  });

  test('rounds a sub-cent purchase up so the issued credits are always backed', async () => {
    const { store, ctx } = fixture();

    // backing = ceil(50 minor × $0.005) = $0.01.
    const outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('0.50') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.50'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.01'),
    );
  });

  test('commits a normal top-up whose backing is at least one cent', async () => {
    const { store, ctx } = fixture();

    // 2.00 credits back at exactly $0.01, just above the zero-backing floor.
    const outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('2.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('2.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.01'),
    );
  });

  test('throws OP.MALFORMED when the source is blank', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyTopUp(
        store,
        ctx,
        topUpOp({
          userId: 'usr_buyer',
          amount: credit('10.00'),
          source: '   ',
        }),
      ),
      hasCode('OP.MALFORMED'),
    );

    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.00'),
    );
  });

  test('commits a top-up with a normal funding source', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00'), source: 'card' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
  });

  test('throws OP.MALFORMED on the wrong operation kind', async () => {
    const { store, ctx } = fixture();
    const wrongKind: Operation = {
      kind: 'refund',
      idempotencyKey: 'idem_wrong',
      actor: { kind: 'system', service: 'test' },
      orderId: 'ord_1',
    };

    await assert.rejects(
      applyTopUp(store, ctx, wrongKind),
      hasCode('OP.MALFORMED'),
    );
  });
});
