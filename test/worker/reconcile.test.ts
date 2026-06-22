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

// Build the worker's context (clock, id generator, logger, and so on) from the test
// fakes, which all behave the same way every run so results are reproducible.
// reconcileDueWindows only actually reads `logger` and `meter`, but we fill in every
// field so this matches the real WorkerCtx type exactly.
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

// A fake feed: given a window, it looks up canned inputs for that window in the supplied
// map (keyed by the window's start, `window.from`) and returns them, or empty processor
// and ledger lists if there are none. In real use the host fetches both sides from a
// vendor; here the data is fixed up front so each test controls exactly what one
// reconciliation run (a "sweep" — comparing both sides across a batch of windows) sees.
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

// A fake feed that throws the given error for every window, standing in for a feed the
// worker can't reach. The sweep is supposed to catch this per window, record it under
// `failed`, and keep going.
function throwingFeed(error: unknown): ReconcileFeed {
  return {
    pull: async () => {
      throw error;
    },
  };
}

let WINDOW: Range = { from: 0, to: 1_000 };

// One $5.00 payout that the processor cleared, plus our ledger's record of the same payout
// for the same amount. The two sides agree exactly, so reconciliation should find no problem.
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

// The same payout on both sides, but the amounts disagree by one cent ($5.00 vs $4.99).
// Reconciliation should match them by key and then report the amount mismatch.
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

// Money the processor cleared that has no matching entry in our ledger (the ledger side is
// empty). This is the dangerous case: real money moved but nothing on our books accounts for
// it. Reconciliation should report it as a "processor orphan".
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
