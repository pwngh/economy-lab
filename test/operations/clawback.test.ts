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

import { clawback } from '#src/operations/clawback.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  seededDigest,
  makeCtx,
  hasCode as isCode,
} from '#test/support/capabilities.ts';
import {
  clawback as clawbackOp,
  credit as creditOf,
} from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Leg, Store, Unit } from '#src/ports.ts';

// The pipeline does not wire the clawback handler yet, so these tests call it directly, each
// inside a real `store.transaction`.
type Fixture = {
  issue(userId: string, amount: Amount): Promise<void>;
  burn(userId: string, amount: Amount): Promise<void>;
  claw(operation: Operation): Promise<Outcome>;
  reverseOrder(orderId: string): Promise<Transaction>;
  balanceOf(account: AccountRef): Promise<Amount>;
};

function setup(): Fixture {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const ctx: Ctx = makeCtx({ digest, clock });
  const store: Store = memoryStore({ digest, clock });
  const post = (legs: Leg[], meta: Record<string, unknown>): Promise<unknown> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
    issue: async (userId, amount) => {
      await post(
        [debit(SYSTEM.STORED_VALUE, amount), credit(spendable(userId), amount)],
        { kind: 'topUp', source: 'card' },
      );
    },
    burn: async (userId, amount) => {
      await post(
        [debit(spendable(userId), amount), credit(SYSTEM.REVENUE, amount)],
        { kind: 'spend' },
      );
    },
    claw: (operation) =>
      store.transaction((unit: Unit) => clawback(operation, unit, ctx)),
    // Stands in for a refund: claims the shared one-time `reversed:${orderId}` marker and files a
    // reversing entry under it, so a clawback of the same order sees it as already reversed.
    reverseOrder: (orderId) =>
      store.transaction(async (unit: Unit) => {
        await unit.idempotency.claim(`reversed:${orderId}`);
        const txn = await postEntry(unit.ledger, {
          txnId: ctx.ids.next('txn'),
          legs: [
            debit(SYSTEM.STORED_VALUE, creditOf('1.00')),
            credit(spendable('usr_buyer'), creditOf('1.00')),
          ],
          meta: { kind: 'refund', orderId },
        });
        await unit.idempotency.record(`reversed:${orderId}`, txn);
        return txn;
      }),
    balanceOf: (account) => store.ledger.balance(account),
  };
}

async function reclaimsFullAmountFromSpendable(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  const outcome = await fx.claw(
    clawbackOp({ userId: 'usr_buyer', amount: creditOf('4.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('6.00'),
  );
  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), creditOf('0.00'));
}

async function booksRemainderToReceivableWhenShort(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.burn('usr_buyer', creditOf('7.00'));

  const outcome = await fx.claw(
    clawbackOp({
      userId: 'usr_buyer',
      amount: creditOf('5.00'),
      reason: 'chargeback',
    }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('0.00'),
  );
  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), creditOf('2.00'));
}

async function booksEntireAmountToReceivableWhenEmpty(): Promise<void> {
  const fx = setup();

  await fx.claw(clawbackOp({ userId: 'usr_buyer', amount: creditOf('3.00') }));

  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), creditOf('3.00'));
}

async function neverOverdrawsSpendable(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('2.00'));

  await fx.claw(clawbackOp({ userId: 'usr_buyer', amount: creditOf('9.00') }));

  const balance = await fx.balanceOf(spendable('usr_buyer'));
  assert.equal(balance.minor >= 0n, true);
  assert.deepEqual(balance, creditOf('0.00'));
}

async function balancesPostingRetiringToStoredValue(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  // STORED_VALUE is debit-normal, so the 10.00 issue reads +10.00.
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('10.00'));

  const outcome = await fx.claw(
    clawbackOp({ userId: 'usr_buyer', amount: creditOf('4.00') }),
  );

  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  const signed = outcome.transaction.legs.reduce(
    (s, leg) => s + leg.amount.minor,
    0n,
  );
  assert.equal(signed, 0n);
  for (const leg of outcome.transaction.legs) {
    assert.equal(leg.amount.currency, 'CREDIT');
  }
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('6.00'));
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

async function duplicateWhenOrderAlreadyRefunded(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  const priorReversal = await fx.reverseOrder('ord_1');

  const buyerBefore = await fx.balanceOf(spendable('usr_buyer'));
  const storedBefore = await fx.balanceOf(SYSTEM.STORED_VALUE);
  const outcome = await fx.claw(
    clawbackOp({
      userId: 'usr_buyer',
      amount: creditOf('4.00'),
      orderId: 'ord_1',
    }),
  );

  assert.equal(outcome.status, 'duplicate');
  if (outcome.status !== 'duplicate') return;
  assert.equal(outcome.transaction.id, priorReversal.id);
  assert.deepEqual(await fx.balanceOf(spendable('usr_buyer')), buyerBefore);
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), storedBefore);
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

async function throwsMalformedForNonPositiveAmount(): Promise<void> {
  const fx = setup();

  await assert.rejects(
    fx.claw(clawbackOp({ userId: 'usr_buyer', amount: creditOf('0.00') })),
    isCode('MONEY.INVALID_AMOUNT'),
  );
}

async function throwsMalformedForBlankOrderId(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  await assert.rejects(
    fx.claw(
      clawbackOp({
        userId: 'usr_buyer',
        amount: creditOf('4.00'),
        orderId: '',
      }),
    ),
    isCode('OP.MALFORMED'),
  );
}

async function commitsWithNoOrderId(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  const outcome = await fx.claw(
    clawbackOp({ userId: 'usr_buyer', amount: creditOf('4.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('6.00'),
  );
}

async function commitsWithRealOrderId(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  const outcome = await fx.claw(
    clawbackOp({
      userId: 'usr_buyer',
      amount: creditOf('4.00'),
      orderId: 'ord_real',
    }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('6.00'),
  );
}

async function throwsMalformedForWrongOperationKind(): Promise<void> {
  const fx = setup();

  await assert.rejects(
    fx.claw({
      kind: 'topUp',
      idempotencyKey: 'idem_wrong',
      actor: { kind: 'system', service: 'test' },
      userId: 'usr_buyer',
      amount: creditOf('1.00'),
      source: 'card',
    }),
    isCode('OP.MALFORMED'),
  );
}

describe('Clawback', () => {
  test('reclaims the full amount from spendable when the buyer still holds it', () =>
    reclaimsFullAmountFromSpendable());
  test('books the unrecoverable remainder to receivable when spendable is short', () =>
    booksRemainderToReceivableWhenShort());
  test('books the entire amount to receivable when spendable is empty', () =>
    booksEntireAmountToReceivableWhenEmpty());
  test('never overdraws spendable, leaving the balance at zero rather than negative', () =>
    neverOverdrawsSpendable());
  test('balances the posting, retiring the full clawed-back amount to stored value and leaving revenue untouched', () =>
    balancesPostingRetiringToStoredValue());
  test('returns duplicate without re-reversing when the order was already refunded', () =>
    duplicateWhenOrderAlreadyRefunded());
  test('throws a malformed fault for a non-positive amount', () =>
    throwsMalformedForNonPositiveAmount());
  test('throws a malformed fault for a present-but-blank orderId', () =>
    throwsMalformedForBlankOrderId());
  test('commits an untied chargeback that omits orderId', () =>
    commitsWithNoOrderId());
  test('commits a chargeback tied to a real, non-blank orderId', () =>
    commitsWithRealOrderId());
  test('throws a malformed fault when handed the wrong operation kind', () =>
    throwsMalformedForWrongOperationKind());
});
