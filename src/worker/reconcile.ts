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

import { normalizePortError, normalizeError } from '#src/errors.ts';
import { reconcile } from '#src/reconcile.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { ReconcileInputs, ReconcileReport } from '#src/reconcile.ts';
import type { Options, Range } from '#src/ports.ts';

/**
 * Host-implemented feed that supplies both sides of one window: the processor's settled records
 * and our ledger's records of the same events. It exists because neither the processor port nor
 * the ledger store offers a "list everything settled in this window" read.
 */
export type ReconcileFeed = {
  pull(window: Range, options?: Options): Promise<ReconcileInputs>;
};

/**
 * Outcome of one sweep; each window lands in exactly one bucket.
 * - `reconciled`: the two sides matched.
 * - `drifted`: discrepancies found — a normal result that carries data, not a failure.
 * - `failed`: the feed pull threw, so the comparison never ran.
 */
export type ReconcileSummary = {
  reconciled: ReadonlyArray<ReconcileReport>;
  drifted: ReadonlyArray<ReconcileReport>;
  failed: ReadonlyArray<{ window: Range; code: string; retryable: boolean }>;
};

type ReconcileTally = {
  reconciled: ReconcileReport[];
  drifted: ReconcileReport[];
  failed: Array<{ window: Range; code: string; retryable: boolean }>;
};

/**
 * Reconciles a batch of windows independently: one unreachable feed fails only its own window
 * and the rest of the batch still runs.
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

type Sweep = { feed: ReconcileFeed; ctx: WorkerCtx; options?: Options };

async function reconcileOne(
  sweep: Sweep,
  window: Range,
  tally: ReconcileTally,
): Promise<void> {
  try {
    // The feed is the injected port; its raw throw is a provider fault, not storage.
    const inputs = await sweep.feed
      .pull(window, sweep.options)
      .catch((error) => {
        throw normalizePortError(error);
      });
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
