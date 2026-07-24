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
  fakeInbound,
  sampleSettlement,
  tiliaScenario,
} from '@pwngh/economy-edge/testing';
import {
  edgeReconcileFeed,
  settledPayoutLedgerRecords,
} from '#src/adapters/edge-reconcile.ts';
import { payoutMatchKeyOf } from '#src/adapters/edge-tilia.ts';

import type { ReconcileDrop } from '#src/adapters/edge-reconcile.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { reconcile } from '#src/reconcile.ts';
import { credit, usd } from '#test/support/builders.ts';

import type { LedgerRecord } from '#src/reconcile.ts';
import type { Range, Saga } from '#src/ports.ts';

const WINDOW: Range = {
  from: Date.parse('2026-07-01T00:00:00Z'),
  to: Date.parse('2026-07-02T00:00:00Z'),
};

describe('edge-reconcile feed', () => {
  test('maps both report directions into processor records and joins the host ledger side', async () => {
    const scenario = tiliaScenario({ disbursed: '100.00' });
    const edge = compose({
      inbound: [
        fakeInbound({
          report: async () => [
            sampleSettlement({ providerTxnId: 'txn-1' }),
            sampleSettlement({
              providerTxnId: '2026-07-01:sku-1:USD:US',
              granularity: 'sku-day',
            }),
            sampleSettlement({
              providerTxnId: 'txn-eur',
              gross: money('EUR', 100n),
            }),
          ],
        }),
      ],
      outbound: [tilia(scenario.config)],
    });
    const ledgerSide: LedgerRecord[] = [
      {
        kind: 'buy',
        matchKey: 'txn-1',
        amount: usd('4.99'),
        txnId: 'txn_lab_1',
        postedAt: WINDOW.from,
      },
      {
        kind: 'payout',
        matchKey: payoutMatchKeyOf(scenario.ref.id),
        amount: usd('100.00'),
        txnId: 'txn_lab_2',
        postedAt: WINDOW.from,
      },
    ];
    const drops: ReconcileDrop[] = [];
    const feed = edgeReconcileFeed(
      edge,
      async () => ledgerSide,
      (drop) => drops.push(drop),
    );

    const inputs = await feed.pull(WINDOW);
    const report = reconcile(WINDOW, inputs);

    assert.equal(inputs.processor.length, 2);
    assert.deepEqual(inputs.processor.map((record) => record.matchKey).sort(), [
      'ps-scenario',
      'txn-1',
    ]);
    assert.equal(report.reconciled, true);
    assert.equal(report.matched, 2);

    // The two filtered settlements are reported, never silently discarded: a
    // reconciliation feed that drops rows invisibly is how a missing payout hides.
    assert.deepEqual(
      drops
        .map((drop) => `${drop.reason}:${drop.providerTxnId}:${drop.currency}`)
        .sort(),
      ['foreign-currency:txn-eur:EUR', 'sku-day:2026-07-01:sku-1:USD:US:USD'],
    );
  });

  test('reconciles the settled-saga ledger side against the rail report end to end', async () => {
    const scenario = tiliaScenario({ disbursed: '100.00' });
    const edge = compose({ outbound: [tilia(scenario.config)] });
    const store = memoryStore();
    const settled: Saga = {
      id: 'pay_1',
      userId: 'usr_seller',
      reserve: credit('20000.00'),
      rateId: 'payout:CREDIT->USD:1',
      state: 'SETTLED',
      providerRef: scenario.ref.id,
      reason: null,
      attempts: 1,
      dueAt: 0,
      updatedAt: WINDOW.from,
      payoutUsd: usd('100.00'),
    };
    await store.transaction(async (unit) => {
      await unit.sagas.open(settled);
    });
    const feed = edgeReconcileFeed(
      edge,
      settledPayoutLedgerRecords(store, payoutMatchKeyOf),
    );

    const report = reconcile(WINDOW, await feed.pull(WINDOW));

    assert.equal(report.reconciled, true);
    assert.equal(report.matched, 1);
  });

  test('surfaces an amount drift when the rail disbursed a different figure', async () => {
    const scenario = tiliaScenario({ disbursed: '102.50' });
    const edge = compose({ outbound: [tilia(scenario.config)] });
    const ledgerSide: LedgerRecord[] = [
      {
        kind: 'payout',
        matchKey: payoutMatchKeyOf(scenario.ref.id),
        amount: usd('100.00'),
        txnId: 'txn_lab_2',
        postedAt: WINDOW.from,
      },
    ];
    const feed = edgeReconcileFeed(edge, async () => ledgerSide);

    const report = reconcile(WINDOW, await feed.pull(WINDOW));

    assert.equal(report.reconciled, false);
    assert.equal(report.amountDrifts, 1);
    assert.equal(report.discrepancies[0]!.processorAmount, 'USD:102.50');
    assert.equal(report.discrepancies[0]!.ledgerAmount, 'USD:100.00');
  });
});
