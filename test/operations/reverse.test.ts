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

// The `reverse` handler is not registered with the main economy engine, so these tests call it
// directly. Each call runs inside `store.transaction(...)`, which hands the handler a `unit`
// (one open database transaction) — the same thing the engine would normally pass it. This
// fixture wires up a fresh in-memory ledger plus the small helpers each test needs, so a test
// only has to spell out the one thing it is checking.
type Fixture = {
  // Post a real top-up entry crediting the user and returning its transaction id. Tests reverse
  // exactly that transaction by passing the returned id back in.
  issue(userId: string, amount: Amount): Promise<string>;

  // Run the `reverse` handler for one operation and return its outcome.
  rev(operation: Operation): Promise<Outcome>;

  // Read the current balance of one account.
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
  let post = (
    legs: Leg[],
    meta: Record<string, unknown>,
  ): Promise<{ id: string }> =>
    store.transaction((unit) =>
      postEntry(unit.ledger, { txnId: ctx.ids.next('txn'), legs, meta }),
    );
  return {
    // Post the two-line entry a top-up makes: it debits the platform's stored-value account and
    // credits the user's spendable balance by the same amount, so the two lines cancel to zero.
    // This is the entry a later `reverse` will undo. Returns the transaction id so a test can
    // name exactly this entry when reversing.
    issue: async (userId, amount) => {
      let transaction = await post(
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

// Build a matcher that `assert.rejects` accepts: it returns true only when the thrown error is
// an Error carrying a `code` field equal to the given string. The tests use it to confirm a
// rejection failed for the specific reason they expect, not just that it failed.
function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

describe('Reverse', () => {
  test('posts the exact inverse of the named posting, unwinding it to zero', async () => {
    let fx = setup();
    let txnId = await fx.issue('usr_buyer', creditOf('10.00'));

    let outcome = await fx.rev(
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
    let fx = setup();
    let txnId = await fx.issue('usr_buyer', creditOf('4.00'));

    let outcome = await fx.rev(reverseOp({ txnId, reason: 'reconciliation' }));

    assert.equal(outcome.status, 'committed');
    if (outcome.status !== 'committed') return;
    let signed = outcome.transaction.legs.reduce(
      (sum, leg) => sum + leg.amount.minor,
      0n,
    );
    assert.equal(signed, 0n);
    // The reversal must touch the same two accounts the top-up did — the user's spendable
    // balance and the platform's stored-value account — just with each line's sign flipped, so
    // the set of accounts is unchanged.
    assert.deepEqual(
      [...outcome.transaction.legs.map((leg) => leg.account)].sort(),
      [SYSTEM.STORED_VALUE, spendable('usr_buyer')].sort(),
    );
  });

  test('reversing the same transaction twice moves money only once', async () => {
    let fx = setup();
    let txnId = await fx.issue('usr_buyer', creditOf('10.00'));

    let first = await fx.rev(reverseOp({ txnId, reason: 'duplicate posting' }));
    assert.equal(first.status, 'committed');
    // After one reversal the top-up is fully unwound: both accounts are back to zero.
    assert.deepEqual(
      await fx.balanceOf(spendable('usr_buyer')),
      creditOf('0.00'),
    );

    let second = await fx.rev(
      reverseOp({ txnId, reason: 'duplicate posting' }),
    );
    // The second reverse of the same transaction is a no-op duplicate, not another money
    // movement, and replays the first reversal's transaction.
    assert.equal(second.status, 'duplicate');
    if (second.status === 'duplicate' && first.status === 'committed') {
      assert.equal(second.transaction.id, first.transaction.id);
    }
    // Balances are unchanged by the duplicate: if it had moved money again, the user's
    // spendable balance would now be negative (or the stored-value account would be off).
    assert.deepEqual(
      await fx.balanceOf(spendable('usr_buyer')),
      creditOf('0.00'),
    );
    assert.deepEqual(await fx.balanceOf(SYSTEM.STORED_VALUE), creditOf('0.00'));
  });

  test('refuses to reverse a reversal', async () => {
    let fx = setup();
    let txnId = await fx.issue('usr_buyer', creditOf('5.00'));

    let first = await fx.rev(reverseOp({ txnId, reason: 'duplicate posting' }));
    assert.equal(first.status, 'committed');
    if (first.status !== 'committed') return;

    // The reversing transaction is itself a reversal, so naming it as the thing to reverse is
    // refused with a malformed fault rather than looping the same money back out and in.
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
    let fx = setup();

    await assert.rejects(
      fx.rev(reverseOp({ txnId: 'txn_missing', reason: 'no such posting' })),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws a malformed fault when the actor is not an operator', async () => {
    let fx = setup();
    let txnId = await fx.issue('usr_buyer', creditOf('1.00'));

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
    let fx = setup();
    let txnId = await fx.issue('usr_buyer', creditOf('1.00'));

    await assert.rejects(
      fx.rev(reverseOp({ txnId, reason: '   ' })),
      isCode('OP.MALFORMED'),
    );
  });

  test('throws a malformed fault when handed the wrong operation kind', async () => {
    let fx = setup();

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
