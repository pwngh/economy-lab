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

import { adjust } from '#src/operations/adjust.ts';
import { topUp } from '#src/operations/topUp.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  seededDigest,
  makeCtx,
} from '#test/support/capabilities.ts';
import {
  adjust as adjustOp,
  topUp as topUpOp,
  credit,
  usd,
} from '#test/support/builders.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

function makeStore(): Store {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  return memoryStore({ digest, clock });
}

// Builds a fresh store and context for each test. Nothing is shared, so writes cannot leak
// between tests.
function fixture(): { store: Store; ctx: Ctx } {
  return { store: makeStore(), ctx: makeCtx() };
}

// Runs adjust inside a committing transaction. Returns the Outcome, which carries the
// commit status and the posted entry.
async function applyAdjust(
  store: Store,
  ctx: Ctx,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => adjust(operation, unit, ctx));
}

// Seeds a starting balance with a top-up. A test that lowers a balance must seed one first.
// Otherwise the downward correction drops below zero and is rejected as an overdraft.
async function issue(
  store: Store,
  ctx: Ctx,
  userId: string,
  amount: ReturnType<typeof credit>,
): Promise<void> {
  await store.transaction((unit) =>
    topUp(topUpOp({ userId, amount }), unit, ctx),
  );
}

// Builds a predicate for assert.rejects that matches an error by its code. The match uses the
// stable code rather than the message or stack, because those can change without notice.
function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}

describe('Adjust Direction', () => {
  test('raises a credit-side account by the signed amount', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyAdjust(
      store,
      ctx,
      adjustOp({
        account: spendable('usr_alice'),
        amount: credit('2.50'),
        reason: 'reconciliation: missing genesis lot',
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_alice')),
      credit('2.50'),
    );
  });

  test('lowers a credit-side account on a negative amount', async () => {
    let { store, ctx } = fixture();
    await issue(store, ctx, 'usr_alice', credit('10.00'));

    await applyAdjust(
      store,
      ctx,
      adjustOp({
        account: spendable('usr_alice'),
        amount: credit('-4.00'),
        reason: 'reconciliation: overcredited',
      }),
    );

    assert.deepEqual(
      await store.ledger.balance(spendable('usr_alice')),
      credit('6.00'),
    );
  });

  test('raises a debit-side house account by the signed amount', async () => {
    let { store, ctx } = fixture();

    await applyAdjust(
      store,
      ctx,
      adjustOp({
        account: SYSTEM.RECEIVABLE,
        amount: credit('3.00'),
        reason: 'book a known shortfall',
      }),
    );

    // RECEIVABLE rises when debited, so a positive adjustment raises it. OPENING_EQUITY is the
    // offset account that adjust balances against. It takes the opposite amount, so the two cancel.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.RECEIVABLE),
      credit('3.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.OPENING_EQUITY),
      credit('-3.00'),
    );
  });
});

describe('Adjust Conservation', () => {
  test('offsets the move against OPENING_EQUITY so the legs sum to zero', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyAdjust(
      store,
      ctx,
      adjustOp({
        account: spendable('usr_alice'),
        amount: credit('2.50'),
        reason: 'genesis import',
      }),
    );

    assert.equal(outcome.status, 'committed');
    if (outcome.status !== 'committed') return;
    let signed = outcome.transaction.legs.reduce(
      (sum, leg) => sum + leg.amount.minor,
      0n,
    );
    assert.equal(signed, 0n);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.OPENING_EQUITY),
      credit('2.50'),
    );
  });

  test('posts only against the account and OPENING_EQUITY', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyAdjust(
      store,
      ctx,
      adjustOp({
        account: spendable('usr_alice'),
        amount: credit('2.50'),
        reason: 'genesis import',
      }),
    );

    assert.equal(outcome.status, 'committed');
    if (outcome.status !== 'committed') return;
    let accounts = outcome.transaction.legs.map((leg) => leg.account);
    assert.deepEqual(
      [...accounts].sort(),
      [SYSTEM.OPENING_EQUITY, spendable('usr_alice')].sort(),
    );
  });
});

describe('Adjust Guards', () => {
  test('throws OVERDRAFT when correcting a user account below zero', async () => {
    let { store, ctx } = fixture();
    await issue(store, ctx, 'usr_alice', credit('3.00'));

    await assert.rejects(
      applyAdjust(
        store,
        ctx,
        adjustOp({
          account: spendable('usr_alice'),
          amount: credit('-5.00'),
          reason: 'over-correction',
        }),
      ),
      hasCode('LEDGER.OVERDRAFT'),
    );
  });
});

describe('Adjust Validation', () => {
  test('throws MALFORMED_OPERATION when the amount is USD', async () => {
    let { store, ctx } = fixture();

    await assert.rejects(
      applyAdjust(
        store,
        ctx,
        adjustOp({
          account: spendable('usr_alice'),
          amount: usd('2.50'),
          reason: 'wrong currency',
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws INVALID_AMOUNT when the amount is zero', async () => {
    let { store, ctx } = fixture();

    await assert.rejects(
      applyAdjust(
        store,
        ctx,
        adjustOp({
          account: spendable('usr_alice'),
          amount: credit('0.00'),
          reason: 'no-op',
        }),
      ),
      hasCode('MONEY.INVALID_AMOUNT'),
    );
  });

  test('throws MALFORMED_OPERATION when the reason is blank', async () => {
    let { store, ctx } = fixture();

    await assert.rejects(
      applyAdjust(
        store,
        ctx,
        adjustOp({
          account: spendable('usr_alice'),
          amount: credit('2.50'),
          reason: '   ',
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED_OPERATION for a non-operator principal', async () => {
    let { store, ctx } = fixture();

    await assert.rejects(
      applyAdjust(
        store,
        ctx,
        adjustOp({
          account: spendable('usr_alice'),
          amount: credit('2.50'),
          reason: 'genesis import',
          actor: { kind: 'system', service: 'test' },
        }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws MALFORMED_OPERATION on the wrong operation kind', async () => {
    let { store, ctx } = fixture();
    let wrongKind: Operation = {
      kind: 'refund',
      idempotencyKey: 'idem_wrong',
      actor: { kind: 'system', service: 'test' },
      orderId: 'ord_1',
    };

    await assert.rejects(
      applyAdjust(store, ctx, wrongKind),
      hasCode('OP.MALFORMED'),
    );
  });
});
