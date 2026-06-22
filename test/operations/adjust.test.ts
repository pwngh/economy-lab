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
  adjust as adjustOp,
  topUp as topUpOp,
  credit,
  usd,
} from '#test/support/builders.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// Build the per-call dependencies the adjust handler reads from (clock, id generator,
// hasher, signer, config, pricing, exchange rates, and so on). Every dependency here is a
// fake or fixed-seed test double, so each run produces the same ids, timestamps, and hashes.
// We hand these to adjust directly; the production routing that would dispatch to it is not
// built yet and is out of scope for these tests.
function makeCtx(): Ctx {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  return {
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
}

function makeStore(): Store {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  return memoryStore({ digest, clock });
}

// A brand-new store and context for one test. Nothing is shared between tests, so one
// test's writes can never leak into another.
function fixture(): { store: Store; ctx: Ctx } {
  return { store: makeStore(), ctx: makeCtx() };
}

// Run adjust inside a database transaction that commits, and return its result (the
// Outcome object the handler produces, which says whether it committed and carries the
// ledger entry it posted).
async function applyAdjust(
  store: Store,
  ctx: Ctx,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => adjust(operation, unit, ctx));
}

// Give a user a real starting balance by running a top-up (the operation that adds credits
// to a spendable account in exchange for money paid in). Tests that lower a balance need
// some balance there first; without it, the downward correction would push the account
// below zero and be rejected as an overdraft.
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

// Make a check that a test passes to assert.rejects: it returns true when the thrown error
// is an Error carrying the given `code` string. Tests match on this stable code rather than
// on the error's message or stack, which are not guaranteed to stay the same.
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

    // RECEIVABLE is an account that goes up when debited, so a positive adjustment raises
    // its balance, and OPENING_EQUITY (the account adjust balances every change against)
    // takes the equal and opposite amount so the two cancel out.
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
