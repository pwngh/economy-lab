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
 * Supplies the two sides reconciliation compares for one time window: the payment
 * processor's settled records and our own ledger's records of the same events. The host
 * implements this (typically a data-warehouse or processor adapter) and returns plain
 * data — the exact `ReconcileInputs` the matching function consumes — so this worker never
 * talks to a vendor API directly.
 *
 * We need a feed here because neither the processor port (settlements arrive as inbound
 * webhooks) nor the ledger store offers a "list everything settled in this window" read,
 * which is what the comparison requires.
 */
export type ReconcileFeed = {
  pull(window: Range, options?: Options): Promise<ReconcileInputs>;
};

/**
 * The outcome of one sweep, with every window sorted into one of three buckets:
 *   - `reconciled` — the two sides matched with no discrepancies.
 *   - `drifted` — the comparison ran fine and found discrepancies (mismatched or missing
 *     records). This is a normal result that carries data, not a failure.
 *   - `failed` — pulling that window's feed threw, so the comparison never ran. Each entry
 *     keeps the error code and whether it's worth retrying.
 */
export type ReconcileSummary = {
  reconciled: ReadonlyArray<ReconcileReport>;
  drifted: ReadonlyArray<ReconcileReport>;
  failed: ReadonlyArray<{ window: Range; code: string; retryable: boolean }>;
};

// Same shape as ReconcileSummary but with mutable arrays, so the sweep can push results
// into it as it goes; the public summary type just exposes it as read-only.
type ReconcileTally = {
  reconciled: ReconcileReport[];
  drifted: ReconcileReport[];
  failed: Array<{ window: Range; code: string; retryable: boolean }>;
};

/**
 * Run reconciliation over a batch of time windows: for each one, pull both sides from the
 * feed, compare them, and sort the result into the summary.
 *
 * A window that matches cleanly goes to `reconciled`; one with mismatches goes to
 * `drifted` (a normal result — the comparison ran and found differences); one whose feed
 * pull throws goes to `failed`. Each window is handled independently, so a single
 * unreachable feed fails only its own window and the rest of the batch still runs.
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

// The inputs that stay the same across every window in one sweep — the feed, the worker's
// capabilities, and the optional cancellation signal — grouped into one value so the
// per-window function takes fewer arguments.
type Sweep = { feed: ReconcileFeed; ctx: WorkerCtx; options?: Options };

// Reconcile a single window, catching any error from its feed pull so it can't stop the
// other windows. A caught error is recorded in `failed` along with whether it's retryable
// (a transient storage/provider failure can be retried on the next sweep; anything else is
// terminal). A successful pull is compared and handed to `record`, which decides whether it
// reconciled or drifted — drift is not an error and is never caught here.
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

// File the comparison result into the tally and report what happened. Every window records
// its number of discrepancies as a metric. A clean window goes to `reconciled` and logs at
// `info`; a window with discrepancies goes to `drifted`, logs at `warn`, and includes the
// per-kind counts so monitoring can alert on reconciliation drift. The report object is
// passed through unchanged for the caller to forward on.
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
