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

// `reverse` is not registered with the engine, so these tests call it directly. Each call runs
// inside `store.transaction(...)`, which hands the handler a `unit` (one open db transaction). That
// `unit` is the same thing the engine would pass. The fixture wires a fresh in-memory ledger plus
// per-test helpers.
type Fixture = {
  // Posts a top-up entry that credits the user. A test reverses that transaction by passing the
  // returned id back in.
  issue(userId: string, amount: Amount): Promise<string>;

  // Runs the `reverse` handler for one operation and returns its outcome.
  rev(operation: Operation): Promise<Outcome>;

  // Reads the current balance of one account.
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
    // Posts the two-line top-up entry. It debits platform stored-value and credits user spendable by
    // the same amount, so the two lines sum to zero. A later `reverse` undoes this entry. Returns the
    // transaction id.
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

// Builds a matcher for `assert.rejects`. The matcher returns true only when the thrown value is an
// Error whose `code` equals the given string. This confirms a rejection failed for the expected
// reason, not merely that it failed.
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
    // Reversal touches the same two accounts as the top-up (user spendable, platform stored-value),
    // just with each line's sign flipped, so the account set is unchanged.
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
    // The second reverse of the same transaction is a no-op duplicate, not another money movement. It
    // replays the first reversal's transaction.
    assert.equal(second.status, 'duplicate');
    if (second.status === 'duplicate' && first.status === 'committed') {
      assert.equal(second.transaction.id, first.transaction.id);
    }
    // The duplicate leaves balances unchanged. A second money movement would push spendable negative
    // and throw stored-value off zero.
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

    // Naming a reversal as the thing to reverse is refused with a malformed fault, rather than
    // looping the same money back out and in.
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
