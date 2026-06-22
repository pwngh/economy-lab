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

/**
 * Tests for reversePayout: the operation an operator runs by hand to pull back a single payout
 * that has not yet paid out real money. Each payout is tracked by a saga — a small state record
 * (RESERVED, SUBMITTED, SETTLED, FAILED) stepped forward by a background worker. Requesting a
 * payout moved the seller's earned credits (money the platform owes them) into PAYOUT_RESERVE,
 * the escrow holding pending payouts; reversing returns those credits and drives the saga to its
 * final FAILED state so the worker never pays it out.
 *
 * What these tests cover: a RESERVED or SUBMITTED payout returns the reserve to the seller's
 * earned account and fails the saga; a SETTLED payout (real money already sent) is refused with
 * INVALID_TRANSITION and posts nothing; only an operator may run it (a normal user is refused
 * with UNAUTHORIZED).
 *
 * Two ways the tests drive the code. State changes, ledger postings, and replay safety are
 * checked by calling the handler directly inside one `store.transaction` — the same way the
 * normal request pipeline runs it as its final step. The permission check and the
 * `economy.payout.reversed` event are checked through the full `economy.submit` entry point.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { reversePayout } from '#src/operations/reversePayout.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { AccountRef } from '#src/accounts.ts';
import { credit } from '#test/support/builders.ts';
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

import type { Ctx, Economy, Operation, Outcome } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';
import type { EconomyEvent, Saga, SagaState, Store, Unit } from '#src/ports.ts';

function newStore(): Store {
  return memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
}

function newCtx(): Ctx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
}

// Set up a payout in the given state with its credits already moved into escrow, exactly as a
// payout request leaves it: the seller's earned credits sitting in PAYOUT_RESERVE. Putting that
// amount into the reserve account up front means the reversal's debit on the reserve has a
// balance to draw from, instead of pushing the reserve negative.
async function openReservedSaga(
  store: Store,
  overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>,
): Promise<Saga> {
  let row: Saga = {
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    ...overrides,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    if (row.state !== 'FAILED') {
      // Put the reserved amount into PAYOUT_RESERVE, balanced against STORED_VALUE (a platform
      // account that the rule against spending more than an account holds does not apply to), so
      // the reversal's later debit on the reserve has a balance to draw down.
      await unit.ledger.append({
        txnId: `txn_seed_${row.id}`,
        legs: [
          creditLeg(SYSTEM.PAYOUT_RESERVE, row.reserve),
          debitLeg(SYSTEM.STORED_VALUE, row.reserve),
        ],
        meta: { kind: 'seed' },
      });
    }
  });
  return row;
}

function buildReversePayout(o: {
  sagaId: string;
  userId?: string;
  reason?: string;
  actor?: Operation['actor'];
}): Operation {
  return {
    kind: 'reversePayout',
    idempotencyKey: `idem_${o.sagaId}`,
    actor: o.actor ?? { kind: 'operator', operatorId: 'op_test' },
    userId: o.userId ?? 'usr_seller',
    sagaId: o.sagaId,
    reason: o.reason ?? 'fraud hold',
  };
}

function run(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => reversePayout(operation, unit, ctx));
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as { code?: string }).code : undefined;
}

async function stateOf(
  store: Store,
  sagaId: string,
): Promise<SagaState | undefined> {
  let saga = await store.sagas.load(sagaId);
  return saga?.state;
}

async function balanceOf(store: Store, account: AccountRef): Promise<Amount> {
  return store.transaction((unit) => unit.ledger.balance(account));
}

describe('reversePayout', () => {
  test('a RESERVED payout returns the reserve to earned and fails the saga', async () => {
    let store = newStore();
    let saga = await openReservedSaga(store, {
      id: 'pay_1',
      state: 'RESERVED',
    });

    let outcome = await run(
      store,
      newCtx(),
      buildReversePayout({ sagaId: 'pay_1' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await stateOf(store, 'pay_1'), 'FAILED');
    // The full reserved amount is back in the seller's earned account.
    let earnedBalance = await balanceOf(store, earned(saga.userId));
    assert.deepEqual(earnedBalance, credit('4.00'));
    // The reserve account was emptied back out.
    let reserveBalance = await balanceOf(store, SYSTEM.PAYOUT_RESERVE);
    assert.deepEqual(reserveBalance, credit('0.00'));
  });

  test('a SUBMITTED payout aged past maxPayoutAgeMs is reversible', async () => {
    let store = newStore();
    let ctx = newCtx();
    // A SUBMITTED payout is gated until it has been waiting longer than maxPayoutAgeMs (the same
    // cutoff the worker uses to give up on a stuck submission). Set `updatedAt` — the time it
    // entered SUBMITTED — far enough in the past that `now - updatedAt` is past the cutoff, so the
    // provider is presumed never to have paid and a manual reverse is allowed.
    await openReservedSaga(store, {
      id: 'pay_2',
      state: 'SUBMITTED',
      updatedAt: ctx.clock.now() - ctx.config.maxPayoutAgeMs - 1,
    });

    let outcome = await run(
      store,
      ctx,
      buildReversePayout({ sagaId: 'pay_2' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await stateOf(store, 'pay_2'), 'FAILED');
    // The full reserved amount is back in the seller's earned account.
    assert.deepEqual(
      await balanceOf(store, earned('usr_seller')),
      credit('4.00'),
    );
  });

  test('a freshly-SUBMITTED payout still within maxPayoutAgeMs is refused and posts nothing', async () => {
    let store = newStore();
    let ctx = newCtx();
    // A SUBMITTED payout the provider may still settle externally must not be reversed: handing
    // the reserve back now would double-pay the seller if the provider later pays out. Enter
    // SUBMITTED "just now" (updatedAt == now), so `now - updatedAt` is 0 — well inside the cutoff.
    await openReservedSaga(store, {
      id: 'pay_live',
      state: 'SUBMITTED',
      updatedAt: ctx.clock.now(),
    });

    await assert.rejects(
      run(store, ctx, buildReversePayout({ sagaId: 'pay_live' })),
      (error: unknown) => codeOf(error) === 'SAGA.INVALID_TRANSITION',
    );

    // Nothing moved: the saga is still SUBMITTED and the reserve is untouched.
    assert.equal(await stateOf(store, 'pay_live'), 'SUBMITTED');
    assert.deepEqual(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
    assert.deepEqual(
      await balanceOf(store, earned('usr_seller')),
      credit('0.00'),
    );
  });

  test('replay (a saga already FAILED) is a duplicate no-op that posts nothing', async () => {
    let store = newStore();
    await openReservedSaga(store, { id: 'pay_3', state: 'RESERVED' });
    let ctx = newCtx();

    let first = await run(store, ctx, buildReversePayout({ sagaId: 'pay_3' }));
    assert.equal(first.status, 'committed');
    let afterFirst = await balanceOf(store, earned('usr_seller'));

    // A second reversal of the same payout finds the saga already FAILED, so the guarded state
    // change refuses to move it again: the result is `duplicate`, the earned balance is
    // unchanged, and the reserve is returned exactly once.
    let second = await run(store, ctx, buildReversePayout({ sagaId: 'pay_3' }));
    assert.equal(second.status, 'duplicate');
    let afterSecond = await balanceOf(store, earned('usr_seller'));
    assert.deepEqual(afterSecond, afterFirst);
    assert.deepEqual(afterSecond, credit('4.00'));
  });
});

describe('reversePayout — Refusals & Validation', () => {
  test('a SETTLED payout throws INVALID_TRANSITION and posts nothing', async () => {
    let store = newStore();
    await openReservedSaga(store, { id: 'pay_4', state: 'SETTLED' });

    await assert.rejects(
      run(store, newCtx(), buildReversePayout({ sagaId: 'pay_4' })),
      (error: unknown) => codeOf(error) === 'SAGA.INVALID_TRANSITION',
    );

    // Nothing was returned: the seller's earned account stayed at zero and the saga stays SETTLED.
    assert.equal(await stateOf(store, 'pay_4'), 'SETTLED');
    let earnedBalance = await balanceOf(store, earned('usr_seller'));
    assert.deepEqual(earnedBalance, credit('0.00'));
  });

  test('an unknown sagaId is operator error (a thrown fault)', async () => {
    let store = newStore();
    await assert.rejects(
      run(store, newCtx(), buildReversePayout({ sagaId: 'pay_missing' })),
      (error: unknown) => codeOf(error) === 'OP.MALFORMED',
    );
  });

  test('a blank reason is rejected', async () => {
    let store = newStore();
    await openReservedSaga(store, { id: 'pay_5', state: 'RESERVED' });
    await assert.rejects(
      run(
        store,
        newCtx(),
        buildReversePayout({ sagaId: 'pay_5', reason: '   ' }),
      ),
      (error: unknown) => codeOf(error) === 'OP.MALFORMED',
    );
  });

  test('a userId that does not match the saga is rejected and posts nothing', async () => {
    let store = newStore();
    await openReservedSaga(store, { id: 'pay_8', state: 'RESERVED' });

    // The payout's seller is usr_seller. Before running, the framework locks the earned account
    // named by the operation's userId so no other write can touch it mid-operation, but the
    // reversal always credits the seller named on the payout. If an operator passes a userId that
    // does not match the payout's seller, the account being credited would be one that was never
    // locked, so the operation is refused up front.
    await assert.rejects(
      run(
        store,
        newCtx(),
        buildReversePayout({ sagaId: 'pay_8', userId: 'usr_other' }),
      ),
      (error: unknown) => codeOf(error) === 'OP.MALFORMED',
    );

    // Nothing moved: the saga is still live and the reserve is untouched.
    assert.equal(await stateOf(store, 'pay_8'), 'RESERVED');
    assert.deepEqual(
      await balanceOf(store, SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
  });
});

describe('reversePayout Through Submit', () => {
  test('an operator reversal emits one economy.payout.reversed', async () => {
    let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
    let economy: Economy = makeEconomy(1, store);
    await openReservedSaga(store, { id: 'pay_6', state: 'RESERVED' });

    let outcome = await economy.submit(
      buildReversePayout({ sagaId: 'pay_6', reason: 'chargeback' }),
    );
    assert.equal(outcome.status, 'committed');

    let events = await drainEvents(store);
    let reversed = events.filter((e) => e.type === 'economy.payout.reversed');
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0]!.audience, 'internal');
    assert.equal(reversed[0]!.subject, 'usr_seller');
    assert.deepEqual(reversed[0]!.data, {
      sagaId: 'pay_6',
      reason: 'chargeback',
    });
  });

  test('a non-privileged user actor is UNAUTHORIZED', async () => {
    let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
    let economy: Economy = makeEconomy(1, store);
    await openReservedSaga(store, { id: 'pay_7', state: 'RESERVED' });

    await assert.rejects(
      economy.submit(
        buildReversePayout({
          sagaId: 'pay_7',
          actor: { kind: 'user', userId: 'usr_seller' },
        }),
      ),
      (error: unknown) => codeOf(error) === 'AUTH.UNAUTHORIZED',
    );

    // The saga was never advanced and nothing was returned: the permission check runs first, so a
    // refused caller never reaches the state change or the posting.
    assert.equal(await stateOf(store, 'pay_7'), 'RESERVED');
  });
});

// Pull the events a committed operation queued for delivery and return them. Events are written
// into an outbox table as part of the same transaction, then handed to subscribers later; this
// claims a batch and marks it delivered so a second call would not see the same events again.
async function drainEvents(store: Store): Promise<EconomyEvent[]> {
  let batch = await store.outbox.claimBatch(100);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  return batch.map((message) => message.event);
}
