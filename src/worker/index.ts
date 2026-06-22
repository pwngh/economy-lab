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
import { settleDuePayouts } from '#src/worker/payouts.ts';
import { sweepDueSubscriptions } from '#src/worker/subscriptions.ts';
import { realizeFees, sweepTreasury } from '#src/worker/treasury.ts';
import { reverifyCheckpoint, sealCheckpoint } from '#src/worker/checkpoint.ts';
import { sweepExpiredPromos } from '#src/worker/promos.ts';
import { relayOutbox } from '#src/worker/relay.ts';
import { reconcileDueWindows } from '#src/worker/reconcile.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type {
  Dispatcher,
  Options,
  Range,
  Scheduler,
  Store,
} from '#src/ports.ts';
import type { SettleSummary } from '#src/worker/payouts.ts';
import type { SweepSummary } from '#src/worker/subscriptions.ts';
import type {
  FeeRealizationSummary,
  TreasurySummary,
} from '#src/worker/treasury.ts';
import type {
  CheckpointSummary,
  CheckpointVerifySummary,
} from '#src/worker/checkpoint.ts';
import type { PromoExpirySummary } from '#src/worker/promos.ts';
import type { RelaySummary } from '#src/worker/relay.ts';
import type { ReconcileFeed, ReconcileSummary } from '#src/worker/reconcile.ts';

/**
 * Names of the background jobs run each cycle. `SweepName` below is derived from this list, so
 * these literals are the sole definition. `as const` (freezing the array, keeping literal types)
 * rather than an enum.
 *
 * Array order is run order and result order.
 *
 * `feeSweep` follows `treasury`: treasury only reads (measures the platform's surplus, the cash
 * held beyond what it owes users); feeSweep moves that surplus into platform funds. Keep the
 * measure-then-move pair adjacent.
 *
 * `checkpointVerify` runs before `checkpoint`. A checkpoint is a sealed ledger snapshot used to
 * detect tampering. Verify re-checks the previous snapshot against the current ledger before a
 * fresh one overwrites it; checking the old snapshot catches tampering since it was sealed,
 * whereas a just-taken snapshot always passes (built from the ledger it's compared against).
 * `promos` runs with the other due-item sweeps.
 */
export const SWEEP_NAMES = [
  'payouts',
  'subscriptions',
  'treasury',
  'feeSweep',
  'checkpointVerify',
  'checkpoint',
  'relay',
  'reconcile',
  'promos',
] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

// Arguments for the background jobs in one object, so the runner takes a single value. Not every
// job uses every field: `now`/`limit` for due-item scans (current time, per-pass cap);
// `dispatcher` for event delivery; `feed`/`windows` for reconciliation. `options` may carry an
// AbortSignal to cancel a running job.
export type SweepInput = {
  now: number;
  limit: number;
  // Transport the relay job delivers outgoing events through. Optional: a deployment with no
  // dispatcher (no SQS queue or HTTP endpoint, see `selectDispatcher` in src/index.ts) still
  // runs every other job. When absent the relay job is skipped; pending rows stay in the outbox
  // (the table of not-yet-delivered events) for a later run once a dispatcher is wired up.
  dispatcher?: Dispatcher;
  feed: ReconcileFeed;
  windows: ReadonlyArray<Range>;
  options?: Options;
};

// Outcome of one job: it ran and produced a summary (`ok: true`), or it threw and the caught
// error became a result (`ok: false`) carrying the error code and retry flag. Errors are always
// reported this way, so one job's exception never escapes to the caller.
export type SweepResult<TSummary> =
  | { ok: true; summary: TSummary }
  | { ok: false; code: string; retryable: boolean };

// Combined result from `runSweeps`: one entry per job, keyed by name; each is the job's summary
// if it ran or its caught error if it failed. One job failing never hides the others.
export type SweepBatch = {
  payouts: SweepResult<SettleSummary>;
  subscriptions: SweepResult<SweepSummary>;
  treasury: SweepResult<TreasurySummary>;
  feeSweep: SweepResult<FeeRealizationSummary>;
  checkpoint: SweepResult<CheckpointSummary>;
  checkpointVerify: SweepResult<CheckpointVerifySummary>;
  relay: SweepResult<RelaySummary>;
  reconcile: SweepResult<ReconcileSummary>;
  promos: SweepResult<PromoExpirySummary>;
};

/**
 * Handle the host program uses to drive the background jobs. `runOnce` runs every job once.
 * `start` runs them on a timer and returns a stop function; present only when a Scheduler was
 * supplied at creation (without one there's nothing to drive the loop).
 */
export type Worker = {
  runOnce(input: SweepInput): Promise<SweepBatch>;
  start?(intervalMs: number, input: SweepInput): () => void;
};

/**
 * Run every background job once over the same shared context and input. Each job runs inside its
 * own try/catch (see `isolate`), so a throw is recorded against just that job and the rest still
 * run. Returns one combined result keyed by job name. Never throws.
 */
export async function runSweeps(
  store: Store,
  ctx: WorkerCtx,
  input: SweepInput,
): Promise<SweepBatch> {
  let { now, limit, options } = input;
  return {
    payouts: await isolate(() => settleDuePayouts(store, ctx, { now, limit })),
    subscriptions: await isolate(() =>
      sweepDueSubscriptions(store, ctx, { now, limit }),
    ),
    treasury: await isolate(() => sweepTreasury(store, ctx, { now })),
    // Move the surplus treasury just measured (cash held beyond what's owed users) into platform
    // funds: take the full amount available this cycle, skip when zero, and record the
    // economy.fees.swept event in the same commit as the money movement so the two can't
    // disagree. Wrapped like every job, so if a safety check (only truly surplus, settled funds
    // may move, not money owed to users) refuses, the refusal is reported as a failed result.
    feeSweep: await isolate(() => realizeFees(store, ctx, { now })),
    // Re-check the previous sealed snapshot against the current ledger before sealing a fresh one
    // below. The old snapshot predates any tampering since it was sealed, so it catches it; a
    // just-taken snapshot always passes (built from the ledger it's compared against). A mismatch
    // is recorded on the summary rather than thrown, so it skips `isolate`'s error path; only a
    // corrupted row or storage failure is reported as a failed result.
    checkpointVerify: await isolate(() => reverifyCheckpoint(store, ctx)),
    checkpoint: await isolate(() => sealCheckpoint(store, ctx)),
    // Relay is the one sweep with an optional capability. With no dispatcher there's nothing to
    // deliver through, so it short-circuits to an empty successful summary; pending rows stay in
    // the outbox for a later run. This is the only place that handles the optional dispatcher;
    // relayOutbox itself always requires one.
    relay:
      input.dispatcher === undefined
        ? { ok: true, summary: { relayed: [], failed: [], deadLettered: [] } }
        : await isolate(() =>
            relayOutbox(
              store,
              ctx,
              { dispatcher: input.dispatcher!, limit },
              options,
            ),
          ),
    reconcile: await isolate(() =>
      reconcileDueWindows(input.feed, ctx, { windows: input.windows }, options),
    ),
    promos: await isolate(() =>
      sweepExpiredPromos(store, ctx, { now, limit }, options),
    ),
  };
}

// Runs one job and turns its outcome into a SweepResult. A return becomes `ok: true` with the
// summary.
//
// A throw goes through `normalizeError` (errors.ts) to a standard EconomyError: an existing
// EconomyError passes through unchanged; anything else is wrapped as a retryable STORE.FAILURE
// keeping the original as `cause` (for logs). Its code and retry flag form the `ok: false` result.
//
// Catching here keeps one failing job from stopping the others.
async function isolate<TSummary>(
  run: () => Promise<TSummary>,
): Promise<SweepResult<TSummary>> {
  try {
    return { ok: true, summary: await run() };
  } catch (error) {
    let normalized = normalizeError(error);
    return {
      ok: false,
      code: normalized.code,
      retryable: normalized.retryable,
    };
  }
}

/**
 * Build the worker from the store and context it uses. Always has `runOnce` (every job once).
 * With a `scheduler`, also gets `start(intervalMs, input)`, which runs the jobs every
 * `intervalMs` ms via that scheduler and returns a stop function. Using the scheduler rather
 * than a built-in timer keeps start and stop on the same code path.
 */
export function createWorker(
  store: Store,
  ctx: WorkerCtx,
  scheduler?: Scheduler,
): Worker {
  let runOnce = (input: SweepInput): Promise<SweepBatch> =>
    runSweeps(store, ctx, input);
  if (scheduler === undefined) {
    return { runOnce };
  }
  return {
    runOnce,
    start: (intervalMs, input) =>
      scheduler.every(
        intervalMs,
        async () => {
          await runSweeps(store, ctx, input);
        },
        input.options,
      ),
  };
}
