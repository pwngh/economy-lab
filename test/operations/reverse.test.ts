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
import { spendable, SYSTEM } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
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
  reverse as reverseOp,
  credit as creditOf,
} from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
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
  const ctx: Ctx = {
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
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

function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
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
