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
  grantPromo as grantPromoOp,
  credit,
  usd,
} from '#test/support/builders.ts';
import { promo, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// The grantPromo handler expects a Ctx: the bag of dependencies (clock, id generator,
// hashing, pricing, etc.) it reads from while running. This builds one from the
// deterministic test fakes so every run behaves identically. These tests call the handler
// directly instead of going through the code that would normally route an operation to it,
// because that routing layer isn't built yet.
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

// A brand-new store and Ctx for each test, so no test can see state left behind by another.
function fixture(): { store: Store; ctx: Ctx } {
  return { store: makeStore(), ctx: makeCtx() };
}

// Run the handler inside a database transaction that commits on success, and return its
// result (an Outcome: either a committed transaction or a declined operation).
async function applyGrantPromo(
  store: Store,
  ctx: Ctx,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => grantPromo(operation, unit, ctx));
}

// Build a matcher for assert.rejects that passes only when the thrown error carries a given
// `code` string. Tests use it to check which specific error a bad operation raised.
function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}

describe('grantPromo Issuance', () => {
  test('mints promo credits against the PROMO_FLOAT offset account', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyGrantPromo(
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
    let { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    // PROMO_FLOAT is the platform's matching account for promo grants: it grows when debited,
    // and the grant debits it by 5.00. balance() always reports an account as a positive
    // magnitude in its own direction, so this debited account reads as +5.00 — the same size
    // as the credit the user received.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PROMO_FLOAT),
      credit('5.00'),
    );
  });

  test('keeps the promo credit and PROMO_FLOAT debit canceling to zero', async () => {
    let { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    // The grant is one balanced entry: the user's promo account is credited 5.00 and
    // PROMO_FLOAT is debited 5.00. Each grows in its own direction, so balance() reports both
    // as +5.00 (in minor units, 500 cents). Subtracting one from the other gives zero, which
    // confirms the two halves of the entry are equal and opposite.
    let promoBalance = await store.ledger.balance(promo('usr_buyer'));
    let floatBalance = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
    assert.equal(promoBalance.minor - floatBalance.minor, 0n);
  });

  test('returns the grant transaction crediting the promo account', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyGrantPromo(
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
    let { store, ctx } = fixture();

    let outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 172_800_000,
      }),
    );

    // The grant shows up as one entry in the account's statement (its list of postings).
    // The grant carries an `expiresAt`, which is stored on that entry so the background job
    // that later reverses any unspent grants can find when this one expires.
    assert.equal(outcome.status, 'committed');
    let statement = await store.ledger.statement(promo('usr_buyer'), {
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(statement.entries.length, 1);
  });
});

describe('grantPromo Recording For The Expiry Background Job', () => {
  test('records a recoverable grant the expiry job can claim once it is due', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 172_800_000,
      }),
    );

    // The grant was written to the promo store inside the same unit of work as the posting,
    // so a sweep run at or after `expiresAt` can claim it. The stored grant reuses the
    // posting's id, carries the full granted amount and the same expiry, and starts unreversed.
    assert.equal(outcome.status, 'committed');
    let txnId =
      outcome.status === 'committed' ? outcome.transaction.id : 'unreachable';
    let due = await store.promos.claimDue(172_800_000, 10);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.id, txnId);
    assert.equal(due[0]!.userId, 'usr_buyer');
    assert.deepEqual(due[0]!.amount, credit('5.00'));
    assert.equal(due[0]!.expiresAt, 172_800_000);
    assert.equal(due[0]!.reversed, false);
  });

  test('does not surface the grant before it is due', async () => {
    let { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({
        userId: 'usr_buyer',
        amount: credit('5.00'),
        expiresAt: 172_800_000,
      }),
    );

    // claimDue only returns grants whose `expiresAt` has passed (`expiresAt <= now`); one
    // millisecond before expiry the grant is not yet claimable.
    assert.deepEqual(await store.promos.claimDue(172_799_999, 10), []);
  });
});

describe('grantPromo Backing', () => {
  test('never raises the USD the platform must hold — spendable credits untouched', async () => {
    let { store, ctx } = fixture();

    await applyGrantPromo(
      store,
      ctx,
      grantPromoOp({ userId: 'usr_buyer', amount: credit('5.00') }),
    );

    // A promo grant only touches the promo and PROMO_FLOAT accounts. It never adds to the real
    // USD the platform holds in trust (TRUST_CASH) or to the count of spendable credits in
    // circulation (STORED_VALUE), so both stay at zero. That is why a free marketing grant can
    // never raise how much real cash the platform is required to keep on hand.
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
    let { store, ctx } = fixture();

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
    let { store, ctx } = fixture();

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
    let { store, ctx } = fixture();

    // The clock reads now = 0, so any non-positive timestamp is at or before now: a dead-on-
    // arrival expiry that would let the promo-expiry sweep reclaim the grant immediately.
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
    let { store, ctx } = fixture();

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
    let { store, ctx } = fixture();

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
    let { store, ctx } = fixture();

    let outcome = await applyGrantPromo(
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
    let { store, ctx } = fixture();

    // Beyond the sane ceiling (years out): refusing it stops a non-expiring grant the
    // promo-expiry sweep would never reclaim.
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
    let { store, ctx } = fixture();
    let wrongKind: Operation = {
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
