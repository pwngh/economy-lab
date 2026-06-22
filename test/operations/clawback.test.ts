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

// In production the clawback handler is reached through the full request pipeline, but that
// pipeline does not yet wire it up, so these tests call the handler directly. Each test wraps
// the call in a real `store.transaction`, the same single-database-transaction unit the
// pipeline would hand it. This Fixture bundles a fresh store and context plus five short
// helpers (set up a balance, drain it, run a clawback, reverse an order the way a refund would,
// read a balance) so each test only has to spell out the one thing it is checking.
type Fixture = {
  issue(userId: string, amount: Amount): Promise<void>;
  burn(userId: string, amount: Amount): Promise<void>;
  claw(operation: Operation): Promise<Outcome>;
  reverseOrder(orderId: string): Promise<Transaction>;
  balanceOf(account: AccountRef): Promise<Amount>;
};

function setup(): Fixture {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  let ctx: Ctx = {
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
  let store: Store = memoryStore({ digest, clock });
  let post = (legs: Leg[], meta: Record<string, unknown>): Promise<unknown> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
    // Post the same entry a top-up would: add `amount` to the user's spendable balance, and
    // record the matching debit against the platform's STORED_VALUE account (the running count
    // of all credits in circulation, which rises every time credits are issued). This gives the
    // user a real balance for a later clawback to pull back out.
    issue: async (userId, amount) => {
      await post(
        [debit(SYSTEM.STORED_VALUE, amount), credit(spendable(userId), amount)],
        { kind: 'topUp', source: 'card' },
      );
    },
    // Move money out of the user's spendable balance into REVENUE, standing in for the buyer
    // having already spent it. A later clawback then finds less there than it wants to reclaim,
    // i.e. a shortfall.
    burn: async (userId, amount) => {
      await post(
        [debit(spendable(userId), amount), credit(SYSTEM.REVENUE, amount)],
        { kind: 'spend' },
      );
    },
    claw: (operation) =>
      store.transaction((unit: Unit) => handleClawback(operation, unit, ctx)),
    // Stand in for a refund of `orderId`. A refund and a clawback of the same order both stake
    // the same one-time marker, `reversed:${orderId}`, so only one of them can ever reverse a
    // given order. This helper takes that marker, posts a balanced reversing entry (all CREDIT,
    // summing to zero), and files the entry under the marker — the same steps a clawback of this
    // order would race against and lose. Returns the reversing transaction so a later test can
    // confirm a duplicate clawback hands back this exact transaction.
    reverseOrder: (orderId) =>
      store.transaction(async (unit: Unit) => {
        await unit.idempotency.claim(`reversed:${orderId}`);
        let txn = await postEntry(unit.ledger, {
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
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  let outcome = await fx.claw(
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
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  await fx.burn('usr_buyer', creditOf('7.00'));

  let outcome = await fx.claw(
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
  let fx = setup();

  await fx.claw(clawback({ userId: 'usr_buyer', amount: creditOf('3.00') }));

  assert.deepEqual(await fx.balanceOf(SYSTEM.RECEIVABLE), creditOf('3.00'));
}

async function neverOverdrawsSpendable(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('2.00'));

  await fx.claw(clawback({ userId: 'usr_buyer', amount: creditOf('9.00') }));

  let balance = await fx.balanceOf(spendable('usr_buyer'));
  assert.equal(balance.minor >= 0n, true);
  assert.deepEqual(balance, creditOf('0.00'));
}

async function balancesPostingRetiringToStoredValue(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  // The top-up in `issue` debited STORED_VALUE by 10.00. STORED_VALUE goes up when it is debited,
  // so its balance now reads +10.00 — it counts the 10.00 of credits currently in circulation.
  // Reclaiming 4.00 of those credits later un-issues them, bringing the count back down to +6.00.
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('10.00'));

  let outcome = await fx.claw(
    clawback({ userId: 'usr_buyer', amount: creditOf('4.00') }),
  );

  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  // Single balanced CREDIT entry: every line is CREDIT and the signed sum is zero.
  let signed = outcome.transaction.legs.reduce(
    (s, leg) => s + leg.amount.minor,
    0n,
  );
  assert.equal(signed, 0n);
  for (let leg of outcome.transaction.legs) {
    assert.equal(leg.amount.currency, 'CREDIT');
  }
  // The reclaimed credits are un-issued by crediting them back to STORED_VALUE (the same account
  // the top-up raised when it issued them), not recorded as platform earnings in REVENUE:
  // STORED_VALUE moves from +10.00 to +6.00 and REVENUE is never touched.
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('6.00'));
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

// A refund and a clawback of the same order both stake the same one-time marker, so the order
// can be reversed only once. Here the refund runs first and takes the marker. The later clawback
// of that order must then find the marker already taken, post nothing, and hand back the refund's
// transaction as a duplicate, leaving the buyer's balance untouched.
async function duplicateWhenOrderAlreadyRefunded(): Promise<void> {
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));
  let priorReversal = await fx.reverseOrder('ord_1');

  // Snapshot the balances the reversal left behind; a duplicate clawback must move none of them.
  let buyerBefore = await fx.balanceOf(spendable('usr_buyer'));
  let storedBefore = await fx.balanceOf(SYSTEM.STORED_VALUE);
  let outcome = await fx.claw(
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
  // No second reversal posted: balances are exactly what the refund left them.
  assert.deepEqual(await fx.balanceOf(spendable('usr_buyer')), buyerBefore);
  assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), storedBefore);
  assert.deepEqual(await fx.balanceOf(SYSTEM.REVENUE), creditOf('0.00'));
}

async function throwsMalformedForNonPositiveAmount(): Promise<void> {
  let fx = setup();

  await assert.rejects(
    fx.claw(clawback({ userId: 'usr_buyer', amount: creditOf('0.00') })),
    isCode('MONEY.INVALID_AMOUNT'),
  );
}

// A present-but-blank `orderId` is malformed: every blank id collapses onto the single shared
// `reversed:` marker, which would falsely tie unrelated chargebacks together, so it is thrown
// rather than claimed.
async function throwsMalformedForBlankOrderId(): Promise<void> {
  let fx = setup();
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
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  let outcome = await fx.claw(
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
  let fx = setup();
  await fx.issue('usr_buyer', creditOf('10.00'));

  let outcome = await fx.claw(
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
  let fx = setup();

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
