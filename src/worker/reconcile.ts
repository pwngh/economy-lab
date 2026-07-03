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
 * Reports the outcome of one sweep. Each window is sorted into exactly one bucket.
 *
 *   - `reconciled`: the two sides matched and there were no discrepancies.
 *   - `drifted`: the comparison ran and found discrepancies, such as mismatched or missing
 *     records. This is a normal result that carries data, not a failure.
 *   - `failed`: the feed pull threw, so the comparison never ran. This bucket keeps the
 *     error code and whether the error is retryable.
 */
export type ReconcileSummary = {
  reconciled: ReadonlyArray<ReconcileReport>;
  drifted: ReadonlyArray<ReconcileReport>;
  failed: ReadonlyArray<{ window: Range; code: string; retryable: boolean }>;
};

// Mirrors ReconcileSummary but with mutable arrays so the sweep can push results as it goes.
// The public type exposes the same shape read-only.
type ReconcileTally = {
  reconciled: ReconcileReport[];
  drifted: ReconcileReport[];
  failed: Array<{ window: Range; code: string; retryable: boolean }>;
};

/**
 * Reconciles a batch of windows. For each window, it pulls both sides, compares them, and
 * sorts the result into the summary. A clean match goes to `reconciled`. Mismatches go to
 * `drifted`, which is a normal result. A feed pull that throws goes to `failed`. Windows are
 * handled independently, so one unreachable feed fails only its own window and the rest of
 * the batch still runs.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how the worker schedules and sweeps reconciliation windows.
 */
export async function reconcileDueWindows(
  feed: ReconcileFeed,
  ctx: WorkerCtx,
  input: { windows: ReadonlyArray<Range> },
  options?: Options,
): Promise<ReconcileSummary> {
  const tally: ReconcileTally = { reconciled: [], drifted: [], failed: [] };
  const sweep: Sweep = { feed, ctx, options };

  for (const window of input.windows) {
    await reconcileOne(sweep, window, tally);
  }

  return tally;
}

// Groups the inputs that stay constant across a sweep: the feed, the worker capabilities,
// and an optional cancellation signal. Grouping them lets the per-window function take fewer
// arguments.
type Sweep = { feed: ReconcileFeed; ctx: WorkerCtx; options?: Options };

// Reconciles a single window. It catches feed-pull errors so one failed pull cannot stop the
// other windows. A caught error goes to `failed` with its retryable flag: transient storage
// or provider failures retry on the next sweep, and anything else is terminal. A successful
// pull is compared and handed to `record`. Drift is not an error, so it is never caught here.
async function reconcileOne(
  sweep: Sweep,
  window: Range,
  tally: ReconcileTally,
): Promise<void> {
  try {
    const inputs = await sweep.feed.pull(window, sweep.options);
    record(sweep.ctx, window, reconcile(window, inputs), tally);
  } catch (error) {
    const normalized = normalizeError(error);
    tally.failed.push({
      window,
      code: normalized.code,
      retryable: normalized.retryable,
    });
    sweep.ctx.logger.log('error', 'worker.reconcile.failed', {
      from: window.from,
      to: window.to,
      code: normalized.code,
      retryable: normalized.retryable,
    });
  }
}

// Files the comparison result into the tally and reports it. Every window records its
// discrepancy count as a metric. A clean window goes to `reconciled` and logs at `info`. A
// window with discrepancies goes to `drifted` and logs at `warn` with per-kind counts so
// monitoring can alert on drift. The report itself is passed through unchanged for the caller.
function record(
  ctx: WorkerCtx,
  window: Range,
  report: ReconcileReport,
  tally: ReconcileTally,
): void {
  ctx.meter.observe(
    'worker.reconcile.discrepancies',
    report.discrepancies.length,
  );
  if (report.reconciled) {
    tally.reconciled.push(report);
    ctx.logger.log('info', 'worker.reconcile.reconciled', {
      from: window.from,
      to: window.to,
      matched: report.matched,
    });
    return;
  }
  tally.drifted.push(report);
  ctx.logger.log('warn', 'worker.reconcile.drifted', {
    from: window.from,
    to: window.to,
    processorOrphans: report.processorOrphans,
    ledgerOrphans: report.ledgerOrphans,
    amountDrifts: report.amountDrifts,
  });
}
