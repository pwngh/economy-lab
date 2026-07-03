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

import { handleClawback } from '#src/operations/clawback.ts';
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
import { clawback, credit as creditOf } from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Leg, Store, Unit } from '#src/ports.ts';

// The pipeline does not wire up the clawback handler yet. These tests call it directly. Each call
// runs inside a real `store.transaction`, which is the same single-database-transaction unit the
// pipeline would hand it. The fixture bundles a fresh store and context with five helpers: issue a
// balance, drain it, run a clawback, reverse an order the way a refund would, and read a balance.
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
  const post = (legs: Leg[], meta: Record<string, unknown>): Promise<unknown> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
    // Post the same entry a top-up would. It credits `amount` to spendable and debits STORED_VALUE,
    // the running count of credits in circulation, which rises on each issue. This gives the user a
    // real balance for a later clawback to pull back.
    issue: async (userId, amount) => {
      await post(
        [debit(SYSTEM.STORED_VALUE, amount), credit(spendable(userId), amount)],
        { kind: 'topUp', source: 'card' },
      );
    },
    // Move money from spendable into REVENUE. This stands in for the buyer having already spent it,
    // so a later clawback finds a shortfall.
    burn: async (userId, amount) => {
      await post(
        [debit(spendable(userId), amount), credit(SYSTEM.REVENUE, amount)],
        { kind: 'spend' },
      );
    },
    claw: (operation) =>
      store.transaction((unit: Unit) => handleClawback(operation, unit, ctx)),
    // Stand in for a refund of `orderId`. A refund and a clawback of the same order both stake the
    // one-time marker `reversed:${orderId}`, so only one of them can reverse a given order. This
    // claims the marker, posts a balanced reversing entry that is all CREDIT and sums to zero, and
    // files it under the marker. It returns the reversing transaction so a later test can confirm
    // that a duplicate clawback hands back this exact transaction.
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

function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

// --- The cases --------------------------------------------------------------------

async function reclaimsFullAmountFromSpendable(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  const outcome = await fx.claw(
    clawback({ userId: 'usr_buyer', amount: creditOf('4.00') }),
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
    clawback({
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

  await fx.claw(clawback({ userId: 'usr_buyer', amount: creditOf('3.00') }));

  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), creditOf('3.00'));
}

async function neverOverdrawsSpendable(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('2.00'));

  await fx.claw(clawback({ userId: 'usr_buyer', amount: creditOf('9.00') }));

  const balance = await fx.balanceOf(spendable('usr_buyer'));
  assert.equal(balance.minor >= 0n, true);
  assert.deepEqual(balance, creditOf('0.00'));
}

async function balancesPostingRetiringToStoredValue(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  // `issue` debited STORED_VALUE by 10.00. STORED_VALUE rises when debited, so it now reads +10.00,
  // the credits in circulation. Reclaiming 4.00 later un-issues them and drops it to +6.00.
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('10.00'));

  const outcome = await fx.claw(
    clawback({ userId: 'usr_buyer', amount: creditOf('4.00') }),
  );

  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  // The posting is a single balanced CREDIT entry. Every line is CREDIT and the signed sum is zero.
  const signed = outcome.transaction.legs.reduce(
    (s, leg) => s + leg.amount.minor,
    0n,
  );
  assert.equal(signed, 0n);
  for (const leg of outcome.transaction.legs) {
    assert.equal(leg.amount.currency, 'CREDIT');
  }
  // Reclaimed credits are un-issued back to STORED_VALUE (the account the top-up raised), not
  // booked as REVENUE: STORED_VALUE goes +10.00 → +6.00 and REVENUE stays untouched.
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('6.00'));
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

// Refund and clawback of the same order share a one-time marker, so an order reverses only once.
// Refund runs first and takes the marker; the later clawback finds it taken, posts nothing, and
// hands back the refund's transaction as a duplicate, leaving the buyer's balance untouched.
async function duplicateWhenOrderAlreadyRefunded(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  const priorReversal = await fx.reverseOrder('ord_1');

  // Snapshot the balances the reversal left behind; a duplicate clawback must move none of them.
  const buyerBefore = await fx.balanceOf(spendable('usr_buyer'));
  const storedBefore = await fx.balanceOf(SYSTEM.STORED_VALUE);
  const outcome = await fx.claw(
    clawback({
      userId: 'usr_buyer',
      amount: creditOf('4.00'),
      orderId: 'ord_1',
    }),
  );

  assert.equal(outcome.status, 'duplicate');
  if (outcome.status !== 'duplicate') return;
  // The duplicate carries the original reversal's transaction, not a fresh posting.
  assert.equal(outcome.transaction.id, priorReversal.id);
  // No second reversal was posted, so the balances are exactly what the refund left them.
  assert.deepEqual(await fx.balanceOf(spendable('usr_buyer')), buyerBefore);
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), storedBefore);
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

async function throwsMalformedForNonPositiveAmount(): Promise<void> {
  const fx = setup();

  await assert.rejects(
    fx.claw(clawback({ userId: 'usr_buyer', amount: creditOf('0.00') })),
    isCode('MONEY.INVALID_AMOUNT'),
  );
}

// A present-but-blank `orderId` is malformed. Every blank id collapses onto the shared `reversed:`
// marker, which would falsely tie unrelated chargebacks together. So the handler throws instead of
// claiming the marker.
async function throwsMalformedForBlankOrderId(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  await assert.rejects(
    fx.claw(
      clawback({ userId: 'usr_buyer', amount: creditOf('4.00'), orderId: '' }),
    ),
    isCode('OP.MALFORMED'),
  );
}

// An untied chargeback omits `orderId` entirely; that is the common case and must still commit.
async function commitsWithNoOrderId(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  const outcome = await fx.claw(
    clawback({ userId: 'usr_buyer', amount: creditOf('4.00') }),
  );

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(
    await fx.balanceOf(spendable('usr_buyer')),
    creditOf('6.00'),
  );
}

// A real, non-blank `orderId` on a fresh order claims the marker and commits normally.
async function commitsWithRealOrderId(): Promise<void> {
  const fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  const outcome = await fx.claw(
    clawback({
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
