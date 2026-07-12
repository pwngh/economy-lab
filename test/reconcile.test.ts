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
const ALL_TIME = { from: 0, to: 1_000_000 };

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

// Defaults line up with processorRecord so a matching pair is easy to build.
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

describe('Reconcile', () => {
  test('reconciles a 1:1 matched pair with zero discrepancies', () => {
    const amount = usd('5.00');

    const report = reconcile(ALL_TIME, {
      processor: [processorRecord({ matchKey: 'pay_1', amount })],
      ledger: [ledgerRecord({ matchKey: 'pay_1', amount })],
    });

    assert.equal(report.reconciled, true);
    assert.equal(report.matched, 1);
    assert.deepEqual(report.discrepancies, []);
  });

  test('flags a processor record with no ledger posting as a processor orphan', () => {
    const report = reconcile(ALL_TIME, {
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
  });

  test('flags a ledger posting with no settled cash as a ledger orphan', () => {
    const report = reconcile(ALL_TIME, {
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
  });

  test('flags a matched pair whose amounts disagree as amount drift', () => {
    const report = reconcile(ALL_TIME, {
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
  });

  test('never matches a buy to a payout under the same key', () => {
    const amount = usd('5.00');

    const report = reconcile(ALL_TIME, {
      processor: [processorRecord({ kind: 'buy', matchKey: 'ref_1', amount })],
      ledger: [ledgerRecord({ kind: 'payout', matchKey: 'ref_1', amount })],
    });

    assert.equal(report.matched, 0);
    assert.equal(report.processorOrphans, 1);
    assert.equal(report.ledgerOrphans, 1);
  });

  test('scopes the half-open window, excluding the upper boundary', () => {
    const amount = usd('1.00');

    const report = reconcile(
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
  });

  test('treats a cross-currency matched pair as drift, never a silent match', () => {
    const report = reconcile(ALL_TIME, {
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
  });

  test('produces the same report regardless of input order', () => {
    const amount = usd('2.00');
    const processor = [
      processorRecord({ matchKey: 'orphan_b', amount }),
      processorRecord({ matchKey: 'orphan_a', amount }),
    ];

    const forward = reconcile(ALL_TIME, { processor, ledger: [] });
    const reversed = reconcile(ALL_TIME, {
      processor: [...processor].reverse(),
      ledger: [],
    });

    assert.deepEqual(forward, reversed);
    assert.deepEqual(
      forward.discrepancies.map((discrepancy) => discrepancy.matchKey),
      ['orphan_a', 'orphan_b'],
    );
  });

  test('reports counts that stay consistent with the discrepancy list', () => {
    const amount = usd('1.00');

    const report = reconcile(ALL_TIME, {
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
  });

  // --- duplicate match keys ------------------------------------------------------------------
  // A repeated matchKey signals corruption. Regression lock: the guarded bug kept only the first
  // ledger record per key, so a duplicate vanished and the report read `reconciled: true`.

  test('surfaces a duplicate ledger record (one matched) as a ledger orphan, never dropped', () => {
    const amount = usd('5.00');
    const report = reconcile(ALL_TIME, {
      processor: [processorRecord({ matchKey: 'dup', amount })],
      ledger: [
        ledgerRecord({ matchKey: 'dup', amount }),
        ledgerRecord({ matchKey: 'dup', amount }),
      ],
    });

    assert.equal(report.matched, 1);
    assert.equal(report.ledgerOrphans, 1);
    assert.equal(report.reconciled, false);
    assert.equal(report.matched + report.ledgerOrphans, report.ledgerCount);
  });

  test('surfaces every duplicate ledger orphan, never collapsing them to one', () => {
    const amount = usd('3.00');
    const report = reconcile(ALL_TIME, {
      processor: [],
      ledger: [
        ledgerRecord({ matchKey: 'dup', amount }),
        ledgerRecord({ matchKey: 'dup', amount }),
        ledgerRecord({ matchKey: 'dup', amount }),
      ],
    });

    assert.equal(report.matched, 0);
    assert.equal(report.ledgerOrphans, 3);
    assert.equal(report.reconciled, false);
    assert.equal(report.matched + report.ledgerOrphans, report.ledgerCount);
  });

  test('surfaces a duplicate processor record (one matched) as a processor orphan', () => {
    const amount = usd('4.00');
    const report = reconcile(ALL_TIME, {
      processor: [
        processorRecord({ matchKey: 'dup', amount }),
        processorRecord({ matchKey: 'dup', amount }),
      ],
      ledger: [ledgerRecord({ matchKey: 'dup', amount })],
    });

    assert.equal(report.matched, 1);
    assert.equal(report.processorOrphans, 1);
    assert.equal(report.reconciled, false);
    assert.equal(
      report.matched + report.processorOrphans,
      report.processorCount,
    );
  });

  test('pairs duplicates oldest-first and drifts the surplus, accounting for every record', () => {
    const report = reconcile(ALL_TIME, {
      processor: [
        processorRecord({ matchKey: 'dup', amount: usd('5.00') }),
        processorRecord({ matchKey: 'dup', amount: usd('9.99') }),
      ],
      ledger: [
        ledgerRecord({ matchKey: 'dup', amount: usd('5.00') }),
        ledgerRecord({ matchKey: 'dup', amount: usd('5.00') }),
      ],
    });

    assert.equal(report.matched, 1);
    assert.equal(report.amountDrifts, 1);
    assert.equal(report.processorOrphans, 0);
    assert.equal(report.ledgerOrphans, 0);
    assert.equal(
      report.matched + report.amountDrifts + report.processorOrphans,
      report.processorCount,
    );
    assert.equal(
      report.matched + report.amountDrifts + report.ledgerOrphans,
      report.ledgerCount,
    );
  });
});
