/// <reference types="node" />
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

import { reconcile } from '#src/reconcile.ts';
import { credit, usd } from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type {
  LedgerRecord,
  ProcessorRecord,
  ReconcileKind,
} from '#src/reconcile.ts';

// Wide enough to include every record here, so window filtering is a no-op. Window logic
// has its own test below.
let ALL_TIME = { from: 0, to: 1_000_000 };

// Processor record (one settled payment the processor reports), with defaults for fields a
// test doesn't care about.
function processorRecord(o: {
  kind?: ReconcileKind;
  matchKey: string;
  amount: Amount;
  settledAt?: number;
}): ProcessorRecord {
  return {
    kind: o.kind ?? 'payout',
    matchKey: o.matchKey,
    amount: o.amount,
    providerRef: `prov_${o.matchKey}`,
    settledAt: o.settledAt ?? 10,
  };
}

// Ledger record (our own record of the same payment). Defaults line up with
// processorRecord so a matching pair is easy to build.
function ledgerRecord(o: {
  kind?: ReconcileKind;
  matchKey: string;
  amount: Amount;
  postedAt?: number;
}): LedgerRecord {
  return {
    kind: o.kind ?? 'payout',
    matchKey: o.matchKey,
    amount: o.amount,
    txnId: `txn_${o.matchKey}`,
    postedAt: o.postedAt ?? 10,
  };
}

function reconcilesAMatchedPair(): void {
  let amount = usd('5.00');

  let report = reconcile(ALL_TIME, {
    processor: [processorRecord({ matchKey: 'pay_1', amount })],
    ledger: [ledgerRecord({ matchKey: 'pay_1', amount })],
  });

  assert.equal(report.reconciled, true);
  assert.equal(report.matched, 1);
  assert.deepEqual(report.discrepancies, []);
}

function flagsAProcessorOrphan(): void {
  let report = reconcile(ALL_TIME, {
    processor: [
      processorRecord({ matchKey: 'pay_orphan', amount: usd('9.00') }),
    ],
    ledger: [],
  });

  assert.equal(report.reconciled, false);
  assert.equal(report.matched, 0);
  assert.equal(report.processorOrphans, 1);
  assert.deepEqual(report.discrepancies, [
    {
      kind: 'processor_orphan',
      matchKey: 'pay_orphan',
      recordKind: 'payout',
      processorAmount: 'USD:9.00',
    },
  ]);
}

function flagsALedgerOrphan(): void {
  let report = reconcile(ALL_TIME, {
    processor: [],
    ledger: [ledgerRecord({ matchKey: 'pay_stuck', amount: usd('7.00') })],
  });

  assert.equal(report.reconciled, false);
  assert.equal(report.ledgerOrphans, 1);
  assert.deepEqual(report.discrepancies, [
    {
      kind: 'ledger_orphan',
      matchKey: 'pay_stuck',
      recordKind: 'payout',
      ledgerAmount: 'USD:7.00',
    },
  ]);
}

function flagsAmountDrift(): void {
  let report = reconcile(ALL_TIME, {
    processor: [processorRecord({ matchKey: 'pay_2', amount: usd('5.00') })],
    ledger: [ledgerRecord({ matchKey: 'pay_2', amount: usd('5.01') })],
  });

  assert.equal(report.reconciled, false);
  assert.equal(report.matched, 0);
  assert.equal(report.amountDrifts, 1);
  assert.deepEqual(report.discrepancies, [
    {
      kind: 'amount_drift',
      matchKey: 'pay_2',
      recordKind: 'payout',
      processorAmount: 'USD:5.00',
      ledgerAmount: 'USD:5.01',
    },
  ]);
}

function neverMatchesABuyToAPayout(): void {
  let amount = usd('5.00');

  // Same match key and amount, but one is a buy and the other a payout. Matcher pairs only
  // when kind matches too, so these stay separate.
  let report = reconcile(ALL_TIME, {
    processor: [processorRecord({ kind: 'buy', matchKey: 'ref_1', amount })],
    ledger: [ledgerRecord({ kind: 'payout', matchKey: 'ref_1', amount })],
  });

  assert.equal(report.matched, 0);
  assert.equal(report.processorOrphans, 1);
  assert.equal(report.ledgerOrphans, 1);
}

function scopesTheHalfOpenWindow(): void {
  let amount = usd('1.00');

  // Window is [10, 20): 10 is inside, 20 belongs to the next window. So "in" records count
  // and "out" records are dropped.
  let report = reconcile(
    { from: 10, to: 20 },
    {
      processor: [
        processorRecord({ matchKey: 'in', amount, settledAt: 10 }),
        processorRecord({ matchKey: 'out', amount, settledAt: 20 }),
      ],
      ledger: [
        ledgerRecord({ matchKey: 'in', amount, postedAt: 10 }),
        ledgerRecord({ matchKey: 'out', amount, postedAt: 20 }),
      ],
    },
  );

  assert.equal(report.processorCount, 1);
  assert.equal(report.ledgerCount, 1);
  assert.equal(report.matched, 1);
  assert.equal(report.reconciled, true);
}

function treatsCrossCurrencyAsDrift(): void {
  // Same match key, but amounts are in different currencies (USD vs CREDIT). Cross-currency
  // amounts can't be compared, so report drift rather than treat them as equal.
  let report = reconcile(ALL_TIME, {
    processor: [processorRecord({ matchKey: 'pay_3', amount: usd('5.00') })],
    ledger: [ledgerRecord({ matchKey: 'pay_3', amount: credit('5.00') })],
  });

  assert.equal(report.matched, 0);
  assert.equal(report.amountDrifts, 1);
  assert.deepEqual(report.discrepancies, [
    {
      kind: 'amount_drift',
      matchKey: 'pay_3',
      recordKind: 'payout',
      processorAmount: 'USD:5.00',
      ledgerAmount: 'CREDIT:5.00',
    },
  ]);
}

function emitsAByteStableReportRegardlessOfInputOrder(): void {
  let amount = usd('2.00');
  let processor = [
    processorRecord({ matchKey: 'orphan_b', amount }),
    processorRecord({ matchKey: 'orphan_a', amount }),
  ];

  let forward = reconcile(ALL_TIME, { processor, ledger: [] });
  let reversed = reconcile(ALL_TIME, {
    processor: [...processor].reverse(),
    ledger: [],
  });

  assert.deepEqual(forward, reversed);
  assert.deepEqual(
    forward.discrepancies.map((discrepancy) => discrepancy.matchKey),
    ['orphan_a', 'orphan_b'],
  );
}

function reportsCountsAndKeepsThemConsistentWithTheList(): void {
  let amount = usd('1.00');

  let report = reconcile(ALL_TIME, {
    processor: [
      processorRecord({ matchKey: 'ok', amount }),
      processorRecord({ matchKey: 'p_only', amount }),
      processorRecord({ matchKey: 'drift', amount: usd('1.00') }),
    ],
    ledger: [
      ledgerRecord({ matchKey: 'ok', amount }),
      ledgerRecord({ matchKey: 'l_only', amount }),
      ledgerRecord({ matchKey: 'drift', amount: usd('2.00') }),
    ],
  });

  assert.equal(report.matched, 1);
  assert.equal(report.processorOrphans, 1);
  assert.equal(report.ledgerOrphans, 1);
  assert.equal(report.amountDrifts, 1);
  assert.equal(report.discrepancies.length, 3);
  assert.equal(report.reconciled, false);
}

describe('Reconcile', () => {
  test('reconciles a 1:1 matched pair with zero discrepancies', () =>
    reconcilesAMatchedPair());
  test('flags a processor record with no ledger posting as a processor orphan', () =>
    flagsAProcessorOrphan());
  test('flags a ledger posting with no settled cash as a ledger orphan', () =>
    flagsALedgerOrphan());
  test('flags a matched pair whose amounts disagree as amount drift', () =>
    flagsAmountDrift());
  test('never matches a buy to a payout under the same key', () =>
    neverMatchesABuyToAPayout());
  test('scopes the half-open window, excluding the upper boundary', () =>
    scopesTheHalfOpenWindow());
  test('treats a cross-currency matched pair as drift, never a silent match', () =>
    treatsCrossCurrencyAsDrift());
  test('produces the same report regardless of input order', () =>
    emitsAByteStableReportRegardlessOfInputOrder());
  test('reports counts that stay consistent with the discrepancy list', () =>
    reportsCountsAndKeepsThemConsistentWithTheList());
});
