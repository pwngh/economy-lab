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
 * Tests for settlePayout, the SUBMITTED -> SETTLED step of a payout saga. This step used to live in
 * the background worker (src/worker/payouts.ts). It now lives in a system-actor operation that an
 * inbound provider settlement webhook can trigger (see src/webhooks.ts toSettlePayout). The worker
 * now only SUBMITS a payout. The provider's "payout settled" callback drives this operation to settle
 * it.
 *
 * These are the worker-settle outcome assertions that used to live in test/worker/payouts.test.ts.
 * They are carried over unweakened now that the settle lives here. Settling a SUBMITTED saga empties
 * the reserve into REVENUE, moves an equal sum of USD out of TRUST_CASH through USD_CLEARING, advances
 * the saga to SETTLED, and emits exactly one economy.payout.settled event. A settle that loses the
 * SUBMITTED -> SETTLED compare-and-set (because another settle got there first) rolls back its
 * postings and its event rather than paying the seller twice. A non-SUBMITTED state is refused with
 * INVALID_TRANSITION. An unknown saga is a mapping fault. An end user may not settle their own payout.
 *
 * There are two drive paths, mirroring reversePayout.test.ts. The ledger postings, the saga state, the
 * rollback, and the rolled-back event call the handler directly inside one `store.transaction`,
 * because the submit pipeline runs it as its final step and settlePayout enqueues its own event in
 * that transaction. The emitted event on a clean settle and the privileged-actor gate go through the
 * full `economy.submit` entry point.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { settlePayout } from '#src/operations/settlePayout.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { SYSTEM } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';
import {
  credit,
  usd,
  settlePayout as buildSettlePayout,
} from '#test/support/builders.ts';
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
import type { Saga, SagaState, Store, Unit } from '#src/ports.ts';

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

// Opens a payout in the given state with credits already in escrow, matching how a payout that the
// worker SUBMITTED is left: the seller's earned credits sit in PAYOUT_RESERVE. Seeding the reserve,
// balanced against STORED_VALUE (a platform account exempt from the overdraft rule), gives the
// settle's credit-side debit a balance to draw from instead of pushing the reserve negative.
async function openSubmittedSaga(
  store: Store,
  overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>,
): Promise<Saga> {
  const row: Saga = {
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: 'prov_pay_1',
    reason: null,
    attempts: 1,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
    ...overrides,
  };
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
    await unit.ledger.append({
      txnId: `txn_seed_${row.id}`,
      legs: [
        creditLeg(SYSTEM.PAYOUT_RESERVE, row.reserve),
        debitLeg(SYSTEM.STORED_VALUE, row.reserve),
      ],
      meta: { kind: 'seed' },
    });
  });
  return row;
}

function run(store: Store, ctx: Ctx, operation: Operation): Promise<Outcome> {
  return store.transaction((unit: Unit) => settlePayout(operation, unit, ctx));
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as { code?: string }).code : undefined;
}

async function stateOf(
  store: Store,
  id: string,
): Promise<SagaState | undefined> {
  return (await store.sagas.load(id))?.state;
}

// Wraps a store so the first transaction the settle opens simulates another settle clearing this saga
// out from under it. By the time this settle's guarded SUBMITTED -> SETTLED move runs, the saga has
// already left SUBMITTED, so the move matches no row and returns false. This is the race the settle
// path must roll back from instead of paying the seller twice. The pre-empting flip only changes the
// state and posts nothing, so the reserve it left behind is what this run's rollback must restore.
function raceSettleOnce(store: Store, id: string): Store {
  let raced = false;
  return {
    ...store,
    transaction: async (work, options) => {
      if (!raced) {
        raced = true;
        await store.sagas.advance(id, 'SUBMITTED', 'SETTLED', { updatedAt: 0 });
      }
      return store.transaction(work, options);
    },
  };
}

describe('settlePayout', () => {
  test('settles a submitted saga with both the credit-side and USD-side postings', async () => {
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    const outcome = await run(
      store,
      newCtx(),
      buildSettlePayout({ sagaId: 'pay_1' }),
    );

    assert.equal(outcome.status, 'committed');
    // The credit-side entry empties the reserve into REVENUE. The seller's set-aside credits become
    // platform earnings, because the platform now owes the seller real money instead.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('4.00'),
    );
    // The USD-side entry records cash leaving custody through USD_CLEARING. TRUST_CASH (real cash
    // held for users) grows on a debit, so crediting it lowers it. That drop is the cash the buyer
    // already gave up when they spent these credits. The reserved 4.00 CREDIT converts at the payout
    // rate ($0.005) to $0.02, an equal sum of USD leaving trust against the reserve cleared.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('-0.02'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      usd('0.02'),
    );
    // The saga is now SETTLED, with the gross USD disbursed persisted on the record itself and no
    // failure reason. The console reads this terminal settle outcome straight from the saga, with no
    // posting-meta harvest.
    const settled = await store.sagas.load('pay_1');
    assert.equal(settled!.state, 'SETTLED');
    assert.deepEqual(settled!.payoutUsd, usd('0.02'));
    assert.equal(settled!.reason, null);
  });

  test('emits exactly one economy.payout.settled event carrying the money detail', async () => {
    // Drive through the full economy.submit entry point so the submit pipeline commits the event the
    // settle enqueued in the same transaction as the postings.
    const store = newStore();
    const economy: Economy = makeEconomy(1, store);
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    const outcome = await economy.submit(
      buildSettlePayout({ sagaId: 'pay_1' }),
    );
    assert.equal(outcome.status, 'committed');

    // The settled event is enqueued in the same transaction as the ledger postings and the guarded
    // state advance, so a settled payout leaves exactly one such event on the outbox.
    const messages = await store.outbox.claimBatch(10);
    const settled = messages.filter(
      (m) => m.event.type === 'economy.payout.settled',
    );
    assert.equal(settled.length, 1);
    const event = settled[0]!.event;
    assert.equal(event.audience, 'internal');
    assert.equal(event.subject, 'usr_seller');
    assert.equal(event.data.sagaId, 'pay_1');
    assert.equal(event.data.usd, encodeAmount(usd('0.02')));
  });

  test('rolls back the settlement on a lost CAS rather than double-paying', async () => {
    // Another settle clears this saga first (see raceSettleOnce), so this run's guarded SUBMITTED ->
    // SETTLED move finds nothing to advance and throws, rolling back its two postings rather than
    // emptying the reserve into REVENUE and moving USD a second time.
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    await assert.rejects(
      () =>
        run(
          raceSettleOnce(store, 'pay_1'),
          newCtx(),
          buildSettlePayout({ sagaId: 'pay_1' }),
        ),
      (error) => codeOf(error) === 'SAGA.INVALID_TRANSITION',
    );

    // The winning settle left the reserve in place, because raceSettleOnce only flips the state and
    // posts nothing. The losing settle rolled its postings back. So the reserve is untouched, REVENUE
    // is empty, and no USD left custody: the seller is paid once, not twice.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      usd('0.00'),
    );
  });

  test('a rolled-back settle emits no settled event', async () => {
    // settlePayout enqueues its event in the same transaction as the postings, so the lost-CAS throw
    // rolls the enqueued event back with them: no settled event is left behind for a settle that never
    // took.
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    await assert.rejects(() =>
      run(
        raceSettleOnce(store, 'pay_1'),
        newCtx(),
        buildSettlePayout({ sagaId: 'pay_1' }),
      ),
    );

    assert.deepEqual(
      (await store.outbox.claimBatch(10)).filter(
        (m) => m.event.type === 'economy.payout.settled',
      ),
      [],
    );
  });

  test('refuses a non-SUBMITTED saga with INVALID_TRANSITION and posts nothing', async () => {
    // Only a SUBMITTED payout has a disbursement the provider can report settled. A RESERVED saga (not
    // yet handed to the provider) has nothing to settle, so the settle is refused and posts nothing.
    const store = newStore();
    await openSubmittedSaga(store, { id: 'pay_resv', state: 'RESERVED' });

    await assert.rejects(
      () => run(store, newCtx(), buildSettlePayout({ sagaId: 'pay_resv' })),
      (error) => codeOf(error) === 'SAGA.INVALID_TRANSITION',
    );

    assert.equal(await stateOf(store, 'pay_resv'), 'RESERVED');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
  });

  test('throws a mapping fault for an unknown saga id', async () => {
    const store = newStore();

    await assert.rejects(
      () => run(store, newCtx(), buildSettlePayout({ sagaId: 'pay_missing' })),
      (error) => codeOf(error) === 'OP.MALFORMED',
    );
  });

  test('an end user may not settle their own payout (UNAUTHORIZED)', async () => {
    // settlePayout is system/operator-only (RESTRICTED_TO_PRIVILEGED): a seller must never settle
    // their own payout. The privileged gate lives at the economy.submit entry point, so drive it there.
    const store = newStore();
    const economy: Economy = makeEconomy(1, store);
    await openSubmittedSaga(store, { id: 'pay_1', state: 'SUBMITTED' });

    await assert.rejects(
      () =>
        economy.submit(
          buildSettlePayout({
            sagaId: 'pay_1',
            actor: { kind: 'user', userId: 'usr_seller' },
          }),
        ),
      (error) => codeOf(error) === 'AUTH.UNAUTHORIZED',
    );

    // Nothing settled: the saga stays SUBMITTED and the reserve is untouched.
    assert.equal(await stateOf(store, 'pay_1'), 'SUBMITTED');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
  });
});
