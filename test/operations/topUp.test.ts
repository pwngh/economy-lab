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
import { topUp as topUpOp, credit, usd } from '#test/support/builders.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { toAmount } from '#src/money.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// Builds the Ctx the topUp handler reads. Every outside service (clock, ids, rates, processor,
// and the rest) is a deterministic test double, so runs are reproducible. Production routes
// operations to the handler by kind, but that wiring isn't built yet, so tests call topUp directly.
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

// Fresh store and Ctx per test so nothing carries over between them.
function fixture(): { store: Store; ctx: Ctx } {
  return { store: makeStore(), ctx: makeCtx() };
}

// Run the topUp handler in a transaction (ledger writes commit together), return its result.
async function applyTopUp(
  store: Store,
  ctx: Ctx,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => topUp(operation, unit, ctx));
}

// Predicate for assert.rejects: true when the thrown value is an Error with the given `code`.
// Failure tests check the code only, not message or stack.
function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}

describe('topUp Issuance', () => {
  test('issues spendable credits against STORED_VALUE', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.STORED_VALUE),
      credit('10.00'),
    );
  });

  test('splits the buyer cash into trust backing and purchase-fee revenue', async () => {
    let { store, ctx } = fixture();

    await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    // The gross cash at the buy rate is $0.01/credit, so $0.10 here. That gross credits USD_CLEARING,
    // and USD_CLEARING grows on debits, so a credit posting reads -0.10. The debit side splits the
    // gross two ways. Par-rate backing of $0.005/credit ($0.05) is held in trust as TRUST_CASH. The
    // buy-vs-par spread, 50% at these test rates, becomes USD revenue ($0.05 in REVENUE_USD). The
    // three postings sum to zero.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.05'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE_USD),
      usd('0.05'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      usd('-0.10'),
    );
  });

  test('never debits REVENUE — issuance is not house revenue', async () => {
    let { store, ctx } = fixture();

    await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      toAmount('CREDIT', 0n),
    );
  });

  test('returns the CREDIT issuance transaction, not the cash posting', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(
      outcome.status === 'committed' &&
        outcome.transaction.legs.some(
          (leg) => leg.account === spendable('usr_buyer'),
        ),
      true,
    );
  });
});

describe('topUp Validation', () => {
  test('throws MALFORMED_OPERATION when the amount is USD', async () => {
    let { store, ctx } = fixture();

    await assert.rejects(
      applyTopUp(
        store,
        ctx,
        topUpOp({ userId: 'usr_buyer', amount: usd('10.00') }),
      ),
      hasCode('OP.MALFORMED'),
    );
  });

  test('throws INVALID_AMOUNT when the amount is not positive', async () => {
    let { store, ctx } = fixture();

    await assert.rejects(
      applyTopUp(
        store,
        ctx,
        topUpOp({ userId: 'usr_buyer', amount: credit('0.00') }),
      ),
      hasCode('MONEY.INVALID_AMOUNT'),
    );
  });

  test('rounds a sub-cent purchase up so the issued credits are always backed', async () => {
    let { store, ctx } = fixture();

    // Backing rounds up, so a sub-cent backing still holds at least one cent in trust; credits are
    // never issued unbacked. A 0.50-credit top-up is 50 minor; backing = ceil(50 × $0.005) =
    // ceil($0.0025) = $0.01.
    let outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('0.50') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.50'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.01'),
    );
  });

  test('commits a normal top-up whose backing is at least one cent', async () => {
    let { store, ctx } = fixture();

    // A 2.00-credit top-up backs at floor(200/200) = $0.01, which sits just above the zero-backing
    // floor. The top-up still issues credits and holds the matching cash in trust.
    let outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('2.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('2.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.01'),
    );
  });

  test('throws MALFORMED_OPERATION when the source is blank', async () => {
    let { store, ctx } = fixture();

    // The funding source selects the maturity horizon for the new credits, so a
    // whitespace-only source is malformed input, not a recoverable refusal.
    await assert.rejects(
      applyTopUp(
        store,
        ctx,
        topUpOp({
          userId: 'usr_buyer',
          amount: credit('10.00'),
          source: '   ',
        }),
      ),
      hasCode('OP.MALFORMED'),
    );

    // Nothing was issued: the rejection happened before any ledger write.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.00'),
    );
  });

  test('commits a top-up with a normal funding source', async () => {
    let { store, ctx } = fixture();

    let outcome = await applyTopUp(
      store,
      ctx,
      topUpOp({ userId: 'usr_buyer', amount: credit('10.00'), source: 'card' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('10.00'),
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
      applyTopUp(store, ctx, wrongKind),
      hasCode('OP.MALFORMED'),
    );
  });
});
