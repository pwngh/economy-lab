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

import { reconcileDueWindows } from '#src/worker/reconcile.ts';
import { fault } from '#src/errors.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  testConfig,
} from '#test/support/capabilities.ts';
import { usd } from '#test/support/builders.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';
import type { ReconcileInputs } from '#src/reconcile.ts';
import type { Range } from '#src/ports.ts';

// Worker context from deterministic test fakes. reconcileDueWindows only reads `logger`
// and `meter`, but we fill every field to match the real WorkerCtx type.
function workerCtx(): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

// Fake feed: looks up canned inputs by window start (`window.from`), or returns empty
// processor/ledger lists. Real hosts fetch both sides from a vendor; here the data is
// fixed up front so each test controls what one sweep sees.
function feedOf(byWindow: Map<number, ReconcileInputs>): ReconcileFeed {
  return {
    pull: async (window) => {
      let inputs = byWindow.get(window.from);
      if (inputs === undefined) {
        return { processor: [], ledger: [] };
      }
      return inputs;
    },
  };
}

// Fake feed that throws for every window (unreachable feed). The sweep should catch this
// per window, record it under `failed`, and keep going.
function throwingFeed(error: unknown): ReconcileFeed {
  return {
    pull: async () => {
      throw error;
    },
  };
}

let WINDOW: Range = { from: 0, to: 1_000 };

// One $5.00 payout, same amount on processor and ledger sides. Both agree, so
// reconciliation finds no problem.
let MATCHED: ReconcileInputs = {
  processor: [
    {
      kind: 'payout',
      matchKey: 'pay_1',
      amount: usd('5.00'),
      providerRef: 'prov_1',
      settledAt: 100,
    },
  ],
  ledger: [
    {
      kind: 'payout',
      matchKey: 'pay_1',
      amount: usd('5.00'),
      txnId: 'txn_1',
      postedAt: 100,
    },
  ],
};

// Same payout on both sides, amounts off by one cent ($5.00 vs $4.99). Reconciliation
// matches by key, then reports the amount mismatch.
let DRIFTED: ReconcileInputs = {
  processor: [
    {
      kind: 'payout',
      matchKey: 'pay_1',
      amount: usd('5.00'),
      providerRef: 'prov_1',
      settledAt: 100,
    },
  ],
  ledger: [
    {
      kind: 'payout',
      matchKey: 'pay_1',
      amount: usd('4.99'),
      txnId: 'txn_1',
      postedAt: 100,
    },
  ],
};

// Processor-cleared money with no ledger entry (ledger side empty): real money moved but
// nothing on our books accounts for it. Reconciliation reports a "processor orphan".
let PROCESSOR_ORPHAN: ReconcileInputs = {
  processor: [
    {
      kind: 'buy',
      matchKey: 'ord_9',
      amount: usd('2.00'),
      providerRef: 'prov_9',
      settledAt: 200,
    },
  ],
  ledger: [],
};

describe('reconcileDueWindows', () => {
  test('tallies a fully matched window as reconciled', async () => {
    let feed = feedOf(new Map([[WINDOW.from, MATCHED]]));

    let summary = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW],
    });

    assert.equal(summary.reconciled.length, 1);
    assert.equal(summary.drifted.length, 0);
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.reconciled[0].matched, 1);
    assert.equal(summary.reconciled[0].reconciled, true);
  });

  test('tallies a window with an amount drift as drifted, not failed', async () => {
    let feed = feedOf(new Map([[WINDOW.from, DRIFTED]]));

    let summary = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW],
    });

    assert.equal(summary.drifted.length, 1);
    assert.equal(summary.reconciled.length, 0);
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.drifted[0].amountDrifts, 1);
    assert.equal(summary.drifted[0].reconciled, false);
  });

  test('flags a processor record with no ledger counterpart as a processor orphan', async () => {
    let feed = feedOf(new Map([[WINDOW.from, PROCESSOR_ORPHAN]]));

    let summary = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW],
    });

    assert.equal(summary.drifted.length, 1);
    assert.equal(summary.drifted[0].processorOrphans, 1);
    assert.equal(summary.drifted[0].discrepancies[0].kind, 'processor_orphan');
  });

  test('records a feed fault as failed, classified on retryable, never throwing the batch', async () => {
    let feed = throwingFeed(
      fault('STORE.FAILURE', 'feed unreachable', { retryable: true }),
    );

    let summary = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW],
    });

    assert.equal(summary.failed.length, 1);
    assert.equal(summary.reconciled.length, 0);
    assert.equal(summary.failed[0].code, 'STORE.FAILURE');
    assert.equal(summary.failed[0].retryable, true);
  });

  test('isolates a feed fault per window and continues the batch', async () => {
    let second: Range = { from: 1_000, to: 2_000 };
    let cases: Array<{ window: Range; throws: boolean }> = [
      { window: WINDOW, throws: true },
      { window: second, throws: false },
    ];
    let feed: ReconcileFeed = {
      pull: async (window) => {
        let match = cases.find((c) => c.window.from === window.from);
        if (match?.throws) {
          throw fault('PROVIDER.FAILURE', 'down', { retryable: true });
        }
        return MATCHED;
      },
    };

    let summary = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW, second],
    });

    assert.equal(summary.failed.length, 1);
    assert.equal(summary.reconciled.length, 1);
    assert.equal(summary.failed[0].window.from, WINDOW.from);
    assert.equal(summary.reconciled[0].window.from, second.from);
  });
});

describe('reconcileDueWindows Determinism', () => {
  test('emits a byte-identical report across two runs over the same feed', async () => {
    let feed = feedOf(new Map([[WINDOW.from, MATCHED]]));

    let first = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW],
    });
    let second = await reconcileDueWindows(feed, workerCtx(), {
      windows: [WINDOW],
    });

    assert.deepEqual(
      JSON.stringify(first.reconciled),
      JSON.stringify(second.reconciled),
    );
  });
});
