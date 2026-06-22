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
 * The names of the background jobs the worker runs each cycle. Each job scans the data for
 * items that need attention and acts on them — for example, paying out due payouts or
 * billing due subscriptions. The `SweepName` type just below is built from this list, so these
 * literal strings are the one place the names are spelled out. Declared with `as const`
 * (which freezes the array and keeps each entry as its exact string literal) rather than a
 * TypeScript enum, so those literals stay the only definition.
 *
 * The order here is the order the jobs run in and the order they appear in the result.
 *
 * `feeSweep` runs right after `treasury`. The treasury job only reads: it measures the
 * platform's surplus — the spare cash the platform holds beyond what it owes its users.
 * `feeSweep` is the writing counterpart that actually moves that surplus into the platform's
 * own funds, so the measure-then-move pair stays adjacent.
 *
 * `checkpointVerify` runs BEFORE `checkpoint`. A checkpoint is a sealed snapshot of the
 * ledger used later to detect tampering. The verify step re-checks the previous snapshot
 * against the current ledger before a fresh snapshot overwrites it. Checking the old snapshot
 * first is what catches tampering that happened since it was sealed: checking a snapshot taken
 * just now would always pass, because it was built from the very ledger it is being compared
 * against. `promos` runs alongside the other due-item sweeps.
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

// All the arguments the background jobs need, gathered into one object so the runner takes a
// single value instead of a different argument list per job. Not every job uses every field:
// `now` and `limit` are used by the jobs that scan for due items (the current time, and a
// cap on how many to handle in one pass); `dispatcher` is used by the job that delivers
// outgoing events; `feed` and `windows` are used by the reconciliation job. `options` can
// carry an AbortSignal so a caller can cancel a job that is still running.
export type SweepInput = {
  now: number;
  limit: number;
  // The transport the relay job delivers outgoing events through. Optional: a deployment with
  // no dispatcher configured (no SQS queue or HTTP endpoint — see `selectDispatcher` in
  // src/index.ts) still runs every other job. When it is absent the relay job is skipped
  // cleanly rather than dropping events: the pending rows are simply left in the outbox — the
  // database table that holds not-yet-delivered events — for a future run once a dispatcher is
  // wired up.
  dispatcher?: Dispatcher;
  feed: ReconcileFeed;
  windows: ReadonlyArray<Range>;
  options?: Options;
};

// The outcome of one job. Either it ran and produced its own summary (`ok: true`), or it
// threw and the error was caught and turned into a result (`ok: false`) carrying the error
// code and whether it is worth retrying. A job's error is always reported this way, so an
// exception from one job never escapes to the caller.
export type SweepResult<TSummary> =
  | { ok: true; summary: TSummary }
  | { ok: false; code: string; retryable: boolean };

// The combined result `runSweeps` returns: one entry per job, keyed by the job's name. Each
// entry is that job's own summary if it ran, or its caught error if it failed. Because every
// job has its own entry, one job failing never hides the results of the others.
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
 * The handle the host program holds to drive the background jobs. `runOnce` runs every
 * job a single time when called. `start` runs them over and over on a timer, and returns a
 * function you call to stop the loop; it is only present when a Scheduler was supplied when
 * the worker was created (without one, there is nothing to drive the repeating loop).
 */
export type Worker = {
  runOnce(input: SweepInput): Promise<SweepBatch>;
  start?(intervalMs: number, input: SweepInput): () => void;
};

/**
 * Run all the background jobs once, each over the same shared context and input. Every job
 * runs inside its own try/catch (see `isolate` below), so if one job throws — even right at
 * the start, before it has processed any items — the error is recorded against just that job
 * and the remaining jobs still run. Returns one combined result keyed by job name (each job's
 * summary if it ran, or its caught error if it failed). This function itself never throws:
 * the returned result is the complete report.
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
    // Move the surplus the treasury job just measured (the spare cash the platform holds
    // beyond what it owes users) into the platform's own funds: take the full amount available
    // this cycle, skip cleanly when it is zero, and record the economy.fees.swept event in the
    // same database commit as the money movement so the two can never disagree. Wrapped like
    // every other job, so if one of its safety checks (it may only move funds that are truly
    // surplus and have settled, not money still owed to users) refuses, the loop does not
    // crash — the refusal is reported as a failed result here.
    feeSweep: await isolate(() => realizeFees(store, ctx, { now })),
    // Re-check the PREVIOUS sealed snapshot of the ledger against the current ledger BEFORE
    // sealing a fresh snapshot below. Checking the old snapshot first catches tampering that
    // happened since it was sealed, because the old snapshot predates that tampering; a
    // snapshot taken just now would always pass, since it was built from the very ledger it is
    // compared against. When the check finds a mismatch it records that on the summary instead
    // of throwing, so it does not take `isolate`'s error path — only a corrupted row or a
    // storage failure is reported as a failed result here.
    checkpointVerify: await isolate(() => reverifyCheckpoint(store, ctx)),
    checkpoint: await isolate(() => sealCheckpoint(store, ctx)),
    // The relay job is the one sweep with an optional capability. When no dispatcher is
    // configured there is nothing to deliver through, so it short-circuits to an empty,
    // successful summary instead of running: the pending rows stay in the outbox (no events
    // are dropped) for a later run once a dispatcher exists. This is the single place that
    // owns the optional dispatcher — relayOutbox itself always requires one.
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

// Runs one job and turns its outcome into a SweepResult. If the job returns, that becomes the
// `ok: true` result with its summary.
//
// If the job throws, the thrown value is run through `normalizeError` (in errors.ts) to get a
// standard EconomyError. If it was already an EconomyError, it passes through unchanged;
// anything else is wrapped as a STORE.FAILURE that is marked safe to retry and keeps the
// original error attached as its `cause` (for logs). The resulting error's code and
// retry-safety flag then form the `ok: false` result.
//
// Catching the throw here is what keeps one failing job from stopping the others.
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
 * Build the worker from the store and context it should use. The returned worker always has
 * `runOnce`, which runs every job a single time. If a `scheduler` is also supplied, the
 * worker additionally gets `start(intervalMs, input)`, which uses that scheduler to run the
 * jobs every `intervalMs` milliseconds and returns a function that stops the loop. The
 * scheduler runs the loop rather than a built-in timer, so the same code path that starts the
 * loop also stops it.
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
