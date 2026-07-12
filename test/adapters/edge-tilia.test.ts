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

import { compose, money } from '@pwngh/economy-edge';
import { tilia } from '@pwngh/economy-edge/providers/outbound/tilia';
import {
  tiliaPayoutWebhookBody,
  tiliaScenario,
} from '@pwngh/economy-edge/testing';
import {
  edgeTiliaCapabilities,
  edgeTiliaFloat,
  edgeTiliaPayees,
  edgeTiliaProcessor,
  payoutMatchKeyOf,
} from '#src/adapters/edge-tilia.ts';
import { ERROR_CODES } from '#src/errors.ts';
import { requestPayout } from '#src/operations/requestPayout.ts';
import { advanceDuePayouts } from '#src/worker/payouts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { runProcessorConformance } from '#test/conformance/processor.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { credit, usd } from '#test/support/builders.ts';
import {
  defaultPricing,
  fixedClock,
  fixedRates,
  noopMeter,
  seededDigest,
  seededSigner,
  sequentialIds,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Edge } from '@pwngh/economy-edge';
import type {
  TiliaScenario,
  TiliaScenarioOptions,
} from '@pwngh/economy-edge/testing';
import type { Ctx, WorkerCtx } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';
import type { Saga, Store, Unit } from '#src/ports.ts';

function edgeFrom(scenario: TiliaScenario): Edge {
  return compose({ outbound: [tilia(scenario.config)] });
}

function workerCtx(edge: Edge, clock = fixedClock(1_000)): WorkerCtx {
  return {
    clock,
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: edgeTiliaProcessor(edge.outbound),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

async function fund(
  store: Store,
  account: Parameters<typeof creditLeg>[0],
  amount: Amount,
  txnId: string,
) {
  await store.transaction(async (unit: Unit) => {
    await unit.ledger.append({
      txnId,
      legs: [creditLeg(account, amount), debitLeg(SYSTEM.STORED_VALUE, amount)],
      meta: { kind: 'test.fund' },
    });
  });
}

function saga(overrides: Partial<Saga> & Pick<Saga, 'id' | 'state'>): Saga {
  return {
    userId: 'usr_seller',
    reserve: credit('4.00'),
    rateId: 'payout:CREDIT->USD:1',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
    ...overrides,
  };
}

async function openSaga(store: Store, row: Saga): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.sagas.open(row);
  });
  await fund(store, SYSTEM.PAYOUT_RESERVE, row.reserve, `txn_seed_${row.id}`);
}

describe('edge-tilia shim (the compiled @pwngh/economy-edge package behind the lab ports)', () => {
  test('submitPayout threads the saga key and returns the edge ref as providerRef', async () => {
    const scenario = tiliaScenario();
    const edge = edgeFrom(scenario);

    const result = await edgeTiliaProcessor(edge.outbound).submitPayout({
      key: 'pay_1',
      userId: 'usr_seller',
      amount: usd('2.00'),
    });

    assert.deepEqual(result, { providerRef: scenario.ref.id });
    assert.ok(scenario.requests.length > 0);
  });

  test('pins the edge ref format payoutMatchKeyOf and the webhook lookup depend on', async () => {
    const scenario = tiliaScenario();
    const edge = edgeFrom(scenario);

    // The shim slices the providerRef on '/' and the saga lookup matches webhook
    // events by the same ref, so both rest on an implicit edge contract:
    // `accountId/payoutStatusId`, and submit and webhook agree on it. Pin all of
    // that here so an edge format change fails this suite instead of silently
    // orphaning payouts at reconcile time.
    const { providerRef } = await edgeTiliaProcessor(
      edge.outbound,
    ).submitPayout({
      key: 'pay_pin',
      userId: 'usr_seller',
      amount: usd('2.00'),
    });
    const segments = providerRef.split('/');
    assert.equal(
      segments.length,
      2,
      'edge ref is no longer accountId/payoutStatusId',
    );
    assert.ok(segments[0]!.length > 0 && segments[1]!.length > 0);
    assert.equal(payoutMatchKeyOf(providerRef), segments[1]);

    const events = edge.outbound.parse({
      provider: 'tilia',
      headers: {},
      body: tiliaPayoutWebhookBody('SETTLED'),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.ref?.id, providerRef);
  });

  test('the float feed refuses a wallet balance the rail reports in a non-USD currency', async () => {
    const scenario = tiliaScenario({ walletBalance: '42.00' });
    const edge = edgeFrom(scenario);
    const foreign = {
      ...edge.outbound,
      balance: async () => money('EUR', 4200n),
    };

    await assert.rejects(
      () => edgeTiliaFloat(foreign).balance(),
      (error: unknown) =>
        (error as { code?: string }).code === ERROR_CODES.PROVIDER_FAILURE,
    );
  });

  test('the worker sweep submits a reserved saga through the edge package', async () => {
    const store = memoryStore();
    const scenario = tiliaScenario();
    const edge = edgeFrom(scenario);
    await openSaga(store, saga({ id: 'pay_1', state: 'RESERVED' }));

    const summary = await advanceDuePayouts(store, workerCtx(edge), {
      now: 1_000,
      limit: 10,
    });

    assert.deepEqual(summary.submitted, ['pay_1']);
    const submitted = await store.sagas.load('pay_1');
    assert.equal(submitted!.state, 'SUBMITTED');
    assert.equal(submitted!.providerRef, scenario.ref.id);
  });

  test('the sweep reverses promptly when the rail reports the payout failed', async () => {
    const store = memoryStore();
    const scenario = tiliaScenario({ status: 'FAILED' });
    const edge = edgeFrom(scenario);
    await openSaga(
      store,
      saga({
        id: 'pay_1',
        state: 'SUBMITTED',
        providerRef: scenario.ref.id,
        updatedAt: 1_000,
      }),
    );

    const summary = await advanceDuePayouts(store, workerCtx(edge), {
      now: 1_000,
      limit: 10,
    });

    assert.deepEqual(summary.deadLettered, [
      { id: 'pay_1', reason: 'payout.provider_failed' },
    ]);
    assert.equal((await store.sagas.load('pay_1'))!.state, 'FAILED');
    assert.deepEqual(
      await store.ledger.balance(earned('usr_seller')),
      credit('4.00'),
    );
  });

  test('the sweep holds a payout the rail reports settled instead of force-failing it', async () => {
    const store = memoryStore();
    const scenario = tiliaScenario({ status: 'SETTLED' });
    const edge = edgeFrom(scenario);
    await openSaga(
      store,
      saga({
        id: 'pay_1',
        state: 'SUBMITTED',
        providerRef: scenario.ref.id,
        updatedAt: 0,
      }),
    );
    const past = testConfig().maxPayoutAgeMs + 60_000;

    const summary = await advanceDuePayouts(
      store,
      workerCtx(edge, fixedClock(past)),
      { now: past, limit: 10 },
    );

    assert.deepEqual(summary.deadLettered, []);
    assert.equal((await store.sagas.load('pay_1'))!.state, 'SUBMITTED');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('4.00'),
    );
  });

  test('the capabilities factory yields a working processor, payee gate, and float in one call', async () => {
    const scenario = tiliaScenario({ walletBalance: '42.00', kyc: 'CLEARED' });

    const capabilities = edgeTiliaCapabilities(scenario.config);

    const result = await capabilities.processor.submitPayout({
      key: 'pay_1',
      userId: 'usr_seller',
      amount: usd('2.00'),
    });
    assert.deepEqual(result, { providerRef: scenario.ref.id });
    assert.deepEqual(await capabilities.payees.status('usr_seller'), {
      state: 'CLEARED',
    });
    assert.deepEqual(await capabilities.float.balance(), usd('42.00'));
    assert.equal(typeof capabilities.outbound.parse, 'function');
  });

  test('the float feed reads the wallet balance through the edge report', async () => {
    const scenario = tiliaScenario({ walletBalance: '42.00' });
    const edge = edgeFrom(scenario);

    const float = await edgeTiliaFloat(edge.outbound).balance();

    assert.deepEqual(float, usd('42.00'));
  });

  test('requestPayout gates on the edge-backed payee directory', async () => {
    const cases: Array<
      [NonNullable<TiliaScenarioOptions['kyc']>, 'committed' | 'rejected']
    > = [
      ['CLEARED', 'committed'],
      ['BLOCKED', 'rejected'],
      ['PENDING', 'rejected'],
    ];
    for (const [kyc, expected] of cases) {
      const store = memoryStore({
        digest: seededDigest(1),
        clock: fixedClock(0),
      });
      const edge = edgeFrom(tiliaScenario({ kyc }));
      await fund(store, earned('usr_seller'), credit('30.00'), 'txn_seed');
      const ctx: Ctx = {
        clock: fixedClock(0),
        ids: sequentialIds(),
        digest: seededDigest(1),
        signer: seededSigner(1),
        processor: edgeTiliaProcessor(edge.outbound),
        config: testConfig(),
        pricing: defaultPricing(),
        rates: fixedRates(),
        logger: testLogger(),
        meter: noopMeter(),
        payees: edgeTiliaPayees(edge.outbound),
      };

      const outcome = await store.transaction((unit: Unit) =>
        requestPayout(
          {
            kind: 'requestPayout',
            idempotencyKey: `idem_${kyc}`,
            actor: { kind: 'user', userId: 'usr_seller' },
            userId: 'usr_seller',
            amount: credit('12.00'),
          },
          unit,
          ctx,
        ),
      );

      assert.equal(outcome.status, expected, kyc);
      if (outcome.status === 'rejected') {
        assert.equal(outcome.reason, 'PAYEE_UNVERIFIED', kyc);
      }
    }
  });
});

runProcessorConformance('edgeTiliaProcessor over @pwngh/economy-edge', {
  accepted: () => edgeTiliaProcessor(edgeFrom(tiliaScenario()).outbound),
  indeterminate: () =>
    edgeTiliaProcessor(
      edgeFrom(tiliaScenario({ submit: 'indeterminate' })).outbound,
    ),
  rejected: () =>
    edgeTiliaProcessor(
      edgeFrom(tiliaScenario({ submit: 'rejected' })).outbound,
    ),
  status: (state) => {
    const scenario = tiliaScenario({ status: state });
    return {
      processor: edgeTiliaProcessor(edgeFrom(scenario).outbound),
      providerRef: scenario.ref.id,
    };
  },
});
