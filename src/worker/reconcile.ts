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

import { normalizeError } from '#src/errors.ts';
import { reconcile } from '#src/reconcile.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { ReconcileInputs, ReconcileReport } from '#src/reconcile.ts';
import type { Options, Range } from '#src/ports.ts';

/**
 * Supplies both sides of reconciliation for one window: the processor's settled records and
 * our ledger's records of the same events. The host implements this (data-warehouse or
 * processor adapter) and returns the `ReconcileInputs` the matching function consumes, so
 * this worker never talks to a vendor API directly.
 *
 * Needed because neither the processor port (settlements arrive as inbound webhooks) nor
 * the ledger store offers a "list everything settled in this window" read.
 */
export type ReconcileFeed = {
  pull(window: Range, options?: Options): Promise<ReconcileInputs>;
};

/**
 * Outcome of one sweep, each window sorted into one bucket:
 *   - `reconciled`: the two sides matched, no discrepancies.
 *   - `drifted`: comparison ran and found discrepancies (mismatched or missing records). A
 *     normal result that carries data, not a failure.
 *   - `failed`: the feed pull threw, so the comparison never ran. Keeps the error code and
 *     whether it's retryable.
 */
export type ReconcileSummary = {
  reconciled: ReadonlyArray<ReconcileReport>;
  drifted: ReadonlyArray<ReconcileReport>;
  failed: ReadonlyArray<{ window: Range; code: string; retryable: boolean }>;
};

// ReconcileSummary with mutable arrays so the sweep can push as it goes; the public type
// exposes it read-only.
type ReconcileTally = {
  reconciled: ReconcileReport[];
  drifted: ReconcileReport[];
  failed: Array<{ window: Range; code: string; retryable: boolean }>;
};

/**
 * Reconcile a batch of windows: for each, pull both sides, compare, sort into the summary.
 * Clean match → `reconciled`; mismatches → `drifted` (normal result); feed pull throws →
 * `failed`. Windows are handled independently, so one unreachable feed fails only its own
 * window and the rest of the batch still runs.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how the worker schedules and sweeps reconciliation windows.
 */
export async function reconcileDueWindows(
  feed: ReconcileFeed,
  ctx: WorkerCtx,
  input: { windows: ReadonlyArray<Range> },
  options?: Options,
): Promise<ReconcileSummary> {
  let tally: ReconcileTally = { reconciled: [], drifted: [], failed: [] };
  let sweep: Sweep = { feed, ctx, options };

  for (let window of input.windows) {
    await reconcileOne(sweep, window, tally);
  }

  return tally;
}

// Inputs constant across a sweep (feed, worker capabilities, optional cancellation signal),
// grouped so the per-window function takes fewer arguments.
type Sweep = { feed: ReconcileFeed; ctx: WorkerCtx; options?: Options };

// Reconcile a single window, catching feed-pull errors so they can't stop other windows.
// Caught errors go to `failed` with their retryable flag (transient storage/provider
// failures retry next sweep; anything else is terminal). A successful pull is compared and
// handed to `record`. Drift is not an error and is never caught here.
async function reconcileOne(
  sweep: Sweep,
  window: Range,
  tally: ReconcileTally,
): Promise<void> {
  try {
    let inputs = await sweep.feed.pull(window, sweep.options);
    record(sweep.ctx, window, reconcile(window, inputs), tally);
  } catch (error) {
    let normalized = normalizeError(error);
    tally.failed.push({
      window,
      code: normalized.code,
      retryable: normalized.retryable,
    });
    sweep.ctx.logger.log('error', 'reconcile.window.failed', {
      from: window.from,
      to: window.to,
      code: normalized.code,
      retryable: normalized.retryable,
    });
  }
}

// File the comparison result into the tally and report it. Every window records its
// discrepancy count as a metric. Clean → `reconciled`, logs `info`; discrepancies →
// `drifted`, logs `warn` with per-kind counts so monitoring can alert on drift. The report
// is passed through unchanged for the caller.
function record(
  ctx: WorkerCtx,
  window: Range,
  report: ReconcileReport,
  tally: ReconcileTally,
): void {
  ctx.meter.observe(
    'economy.reconcile.discrepancies',
    report.discrepancies.length,
  );
  if (report.reconciled) {
    tally.reconciled.push(report);
    ctx.logger.log('info', 'reconcile.window.reconciled', {
      from: window.from,
      to: window.to,
      matched: report.matched,
    });
    return;
  }
  tally.drifted.push(report);
  ctx.logger.log('warn', 'reconcile.window.drifted', {
    from: window.from,
    to: window.to,
    processorOrphans: report.processorOrphans,
    ledgerOrphans: report.ledgerOrphans,
    amountDrifts: report.amountDrifts,
  });
}
