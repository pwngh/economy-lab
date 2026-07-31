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

import { reverse } from '#src/operations/reverse.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { allInvariantsHold, proveEconomy } from '#src/integrity.ts';
import {
  fixedClock,
  seededDigest,
  hasCode as isCode,
  makeCtx,
  fixedRates,
} from '#test/support/capabilities.ts';
import {
  reverse as reverseOp,
  credit as creditOf,
  requestPayout as requestPayoutOp,
  reversePayout as reversePayoutOp,
} from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Economy, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Store, Unit } from '#src/ports.ts';

// `reverse` is not registered with the engine, so these tests call it directly, each inside
// `store.transaction`.
type Fixture = {
  issue(userId: string, amount: Amount): Promise<string>;

  rev(operation: Operation): Promise<Outcome>;

  balanceOf(account: AccountRef): Promise<Amount>;
};

function setup(): Fixture {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const ctx: Ctx = makeCtx({ digest, clock });
  const store: Store = memoryStore({ digest, clock });
  const post = (
    legs: Leg[],
    meta: Record<string, unknown>,
  ): Promise<{ id: string }> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
    issue: async (userId, amount) => {
      const transaction = await post(
        [debit(SYSTEM.STORED_VALUE, amount), credit(spendable(userId), amount)],
        { kind: 'topUp', source: 'card' },
      );
      return transaction.id;
    },
    rev: (operation) =>
      store.transaction((unit: Unit) => reverse(operation, unit, ctx)),
    balanceOf: (account) => store.ledger.balance(account),
  };
}

describe('Reverse', () => {
  test('posts the exact inverse of the named posting, unwinding it to zero', async () => {
    const fx = setup();
    const txnId = await fx.issue('usr_buyer', creditOf('10.00'));

    const outcome = await fx.rev(
      reverseOp({ txnId, reason: 'duplicate posting' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await fx.balanceOf(spendable('usr_buyer')),
      creditOf('0.00'),
    );
    assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('0.00'));
  });

  test('balances the reversing posting — every line sign flipped and all amounts sum to zero', async () => {
    const fx = setup();
    const txnId = await fx.issue('usr_buyer', creditOf('4.00'));

    const outcome = await fx.rev(
      reverseOp({ txnId, reason: 'reconciliation' }),
    );

    assert.equal(outcome.status, 'committed');
    if (outcome.status !== 'committed') return;
    const signed = outcome.transaction.legs.reduce(
      (sum, leg) => sum + leg.amount.minor,
      0n,
    );
    assert.equal(signed, 0n);
    assert.deepEqual(
      [...outcome.transaction.legs.map((leg) => leg.account)].sort(),
      [SYSTEM.STORED_VALUE, spendable('usr_buyer')].sort(),
    );
  });

  test('reversing the same transaction twice moves money only once', async () => {
    const fx = setup();
    const txnId = await fx.issue('usr_buyer', creditOf('10.00'));

    const first = await fx.rev(
      reverseOp({ txnId, reason: 'duplicate posting' }),
    );
    assert.equal(first.status, 'committed');
    assert.deepEqual(
      await fx.balanceOf(spendable('usr_buyer')),
      creditOf('0.00'),
    );

    const second = await fx.rev(
      reverseOp({ txnId, reason: 'duplicate posting' }),
    );
    assert.equal(second.status, 'duplicate');
    if (second.status === 'duplicate' && first.status === 'committed') {
      assert.equal(second.transaction.id, first.transaction.id);
    }
    assert.deepEqual(
      await fx.balanceOf(spendable('usr_buyer')),
      creditOf('0.00'),
    );
    assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('0.00'));
  });

  test('refuses to reverse a reversal', async () => {
    const fx = setup();
    const txnId = await fx.issue('usr_buyer', creditOf('5.00'));

    const first = await fx.rev(
      reverseOp({ txnId, reason: 'duplicate posting' }),
    );
    assert.equal(first.status, 'committed');
    if (first.status !== 'committed') return;

    await assert.rejects(
      fx.rev(
        reverseOp({
          txnId: first.transaction.id,
          reason: 'reverse of a reverse',
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws a malformed fault when the txnId names no posting', async () => {
    const fx = setup();

    await assert.rejects(
      fx.rev(reverseOp({ txnId: 'txn_missing', reason: 'no such posting' })),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws a malformed fault when the actor is not an operator', async () => {
    const fx = setup();
    const txnId = await fx.issue('usr_buyer', creditOf('1.00'));

    await assert.rejects(
      fx.rev(
        reverseOp({
          txnId,
          reason: 'unauthorized',
          actor: { kind: 'system', service: 'test' },
        }),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws a malformed fault when the reason is blank', async () => {
    const fx = setup();
    const txnId = await fx.issue('usr_buyer', creditOf('1.00'));

    await assert.rejects(
      fx.rev(reverseOp({ txnId, reason: '   ' })),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws a malformed fault when handed the wrong operation kind', async () => {
    const fx = setup();

    await assert.rejects(
      fx.rev({
        kind: 'topUp',
        idempotencyKey: 'idem_wrong',
        actor: { kind: 'system', service: 'test' },
        userId: 'usr_buyer',
        amount: creditOf('1.00'),
        source: 'card',
      }),
      isCode('OP.MALFORMED'),
    );
  });
});

// A payout reserve is a posting like any other, so `reverse` used to undo it while the saga
// stayed RESERVED — and `reversePayout` then returned the same reserve a second time out of the
// pooled PAYOUT_RESERVE, which is funded by every other seller waiting to be paid. Measured
// before the screen below existed: usr_a ended at 50,000 credits against 30,000 seeded, with
// every ledger invariant still holding, because usr_b's reserve had paid for it.
describe('Reverse Against A Saga Reserve', () => {
  test('reverse refuses a posting another door owns, and that door still pays once', async () => {
    const digest = seededDigest(1);
    const clock = fixedClock(0);
    const store: Store = memoryStore({ digest, clock });
    const economy: Economy = makeEconomy(1, store);
    const seeded = creditOf('30000.00');
    const reserve = creditOf('20000.00');

    for (const userId of ['usr_a', 'usr_b']) {
      await store.transaction((unit) =>
        unit.ledger.append({
          txnId: `txn_seed_${userId}`,
          legs: [
            credit(earned(userId), seeded),
            debit(SYSTEM.STORED_VALUE, seeded),
          ],
          meta: { kind: 'seed' },
        }),
      );
    }

    const requestA = await economy.submit(
      requestPayoutOp({ userId: 'usr_a', amount: reserve }),
    );
    await economy.submit(requestPayoutOp({ userId: 'usr_b', amount: reserve }));
    assert.equal(requestA.status, 'committed');
    const sagaA = String(requestA.transaction.meta.sagaId);

    await assert.rejects(
      economy.submit(
        reverseOp({ txnId: requestA.transaction.id, reason: 'ops' }),
      ),
      isCode('OP.MALFORMED'),
      'a leg-for-leg inverse leaves the saga row RESERVED behind it',
    );

    // The door that owns the reversal still works, and returns the reserve exactly once.
    const reversed = await economy.submit(
      reversePayoutOp({ userId: 'usr_a', sagaId: sagaA, reason: 'ops' }),
    );
    assert.equal(reversed.status, 'committed');
    assert.deepEqual(
      await economy.read.balance(earned('usr_a')),
      seeded,
      'usr_a is made whole, and no more than whole',
    );
    assert.deepEqual(
      await economy.read.balance(earned('usr_b')),
      creditOf('10000.00'),
      "usr_b's reserve is untouched: it never funded usr_a",
    );

    const report = await proveEconomy({ store, rates: fixedRates(), digest });
    assert.equal(allInvariantsHold(report), true);
  });
});
