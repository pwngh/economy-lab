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

import { grantPromo } from '#src/operations/promo.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  seededDigest,
  makeCtx,
} from '#test/support/capabilities.ts';
import {
  grantPromo as grantPromoOp,
  credit,
  usd,
} from '#test/support/builders.ts';
import { promo, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

function makeStore(): Store {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  return memoryStore({ digest, clock });
}

function fixture(): { store: Store; ctx: Ctx } {
  return { store: makeStore(), ctx: makeCtx() };
}

async function applyGrantPromo(
  store: Store,
  ctx: Ctx,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => grantPromo(operation, unit, ctx));
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}

describe('grantPromo Issuance', () => {
  test('mints promo credits against the PROMO_FLOAT offset account', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(promo('usr_buyer')),
      credit('5.00'),
    );
  });

  test('offsets the grant by debiting the PROMO_FLOAT account', async () => {
    const { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    // PROMO_FLOAT is debit-normal and balance() reads in the account's own direction, so the 5.00
    // debit reads +5.00.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PROMO_FLOAT),
      credit('5.00'),
    );
  });

  test('keeps the promo credit and PROMO_FLOAT debit canceling to zero', async () => {
    const { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    const promoBalance = await store.ledger.balance(promo('usr_buyer'));
    const floatBalance = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
    assert.equal(promoBalance.minor - floatBalance.minor, 0n);
  });

  test('returns the grant transaction crediting the promo account', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(
      outcome.status === 'committed' &&
        outcome.transaction.legs.some(
          (leg) => leg.account === promo('usr_buyer'),
        ),
      true,
    );
  });

  test('records expiresAt on the posting for the background expiry job', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 172_800_000,
      }),
    );

    assert.equal(outcome.status, 'committed');
    const statement = await store.ledger.statement(promo('usr_buyer'), {
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(statement.entries.length, 1);
  });
});

describe('grantPromo Recording For The Expiry Background Job', () => {
  test('records a recoverable grant the expiry job can claim once it is due', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 172_800_000,
      }),
    );

    assert.equal(outcome.status, 'committed');
    const txnId =
      outcome.status === 'committed' ? outcome.transaction.id : 'unreachable';
    const due = await store.promos.claimDue(172_800_000, 10);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.id, txnId);
    assert.equal(due[0]!.userId, 'usr_buyer');
    assert.deepEqual(due[0]!.amount, credit('5.00'));
    assert.equal(due[0]!.expiresAt, 172_800_000);
    assert.equal(due[0]!.reversed, false);
  });

  test('does not surface the grant before it is due', async () => {
    const { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 172_800_000,
      }),
    );

    // claimDue is inclusive: only grants with `expiresAt <= now`.
    assert.deepEqual(await store.promos.claimDue(172_799_999, 10), []);
  });
});

describe('grantPromo Backing', () => {
  test('never raises the USD the platform must hold — spendable credits untouched', async () => {
    const { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    // A grant touches only promo and PROMO_FLOAT. It never adds to USD held in trust (TRUST_CASH) or
    // to spendable credits in circulation (STORED_VALUE), so both stay zero. A free grant cannot
    // raise required reserves.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      toAmount('USD', 0n),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.STORED_VALUE),
      toAmount('CREDIT', 0n),
    );
  });
});

describe('grantPromo Validation', () => {
  test('throws MALFORMED_OPERATION when the amount is USD', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyGrantPromo(
        store,
        ctx,
        grantPromoOp({ userId: 'usr_buyer', amount: usd('5.00') }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws INVALID_AMOUNT when the amount is not positive', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyGrantPromo(
        store,
        ctx,
        grantPromoOp({ userId: 'usr_buyer', amount: credit('0.00') }),
      ),
      hasCode('MONEY.INVALID_AMOUNT'),
    );
  });

  test('throws MALFORMED_OPERATION when expiresAt is in the past', async () => {
    const { store, ctx } = fixture();

    // The clock reads 0, so -1 is already in the past.
    await assert.rejects(
      applyGrantPromo(
        store,
        ctx,
        grantPromoOp({
          userId: 'usr_buyer',
          amount: credit('5.00'),
          expiresAt: -1,
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED_OPERATION when expiresAt is NaN', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyGrantPromo(
        store,
        ctx,
        grantPromoOp({
          userId: 'usr_buyer',
          amount: credit('5.00'),
          expiresAt: Number.NaN,
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED_OPERATION when expiresAt is Infinity', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyGrantPromo(
        store,
        ctx,
        grantPromoOp({
          userId: 'usr_buyer',
          amount: credit('5.00'),
          expiresAt: Number.POSITIVE_INFINITY,
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('commits when expiresAt is a normal future timestamp', async () => {
    const { store, ctx } = fixture();

    const outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 86_400_000,
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(promo('usr_buyer')),
      credit('5.00'),
    );
  });

  test('throws MALFORMED_OPERATION when expiresAt is absurdly far in the future', async () => {
    const { store, ctx } = fixture();

    await assert.rejects(
      applyGrantPromo(
        store,
        ctx,
        grantPromoOp({
          userId: 'usr_buyer',
          amount: credit('5.00'),
          expiresAt: Number.MAX_SAFE_INTEGER,
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED_OPERATION on the wrong operation kind', async () => {
    const { store, ctx } = fixture();
    const wrongKind: Operation = {
      kind: 'refund',
      idempotencyKey: 'idem_wrong',
      actor: { kind: 'system', service: 'test' },
      orderId: 'ord_1',
    };

    await assert.rejects(
      applyGrantPromo(store, ctx, wrongKind),
      hasCode('OP.MALFORMED'),
    );
  });
});
