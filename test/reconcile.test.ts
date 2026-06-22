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

// A time window wide enough to include every record in these tests, so window filtering
// never gets in the way. The window logic itself has its own dedicated test below.
let ALL_TIME = { from: 0, to: 1_000_000 };

// Builds a processor record (one settled payment the processor reports), filling in the
// fields a test does not care about so each case only has to set what it is testing.
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

// Builds a ledger record (our own record of the same settled payment), again filling in
// the fields a test does not care about. Defaults line up with processorRecord above so a
// matching pair is easy to construct.
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

  // The two records share a match key and amount, but one is a buy and the other a
  // payout. The matcher pairs records only when their kind matches too, so a buy and a
  // payout stay separate instead of pairing up.
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

  // The window covers times from 10 up to (but not including) 20: a record at exactly 10
  // is inside the window, but one at exactly 20 falls outside it (it belongs to the next
  // window). So the "in" records count and the "out" records are dropped.
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
  // The two records share a match key, but their amounts are in different currencies
  // (USD vs CREDIT). Amounts in different currencies cannot be compared, so the pair is
  // reported as a mismatch (amount drift) rather than quietly treated as equal.
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
