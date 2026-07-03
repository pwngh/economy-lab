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
import { advanceDuePayouts } from '#src/worker/payouts.ts';
import { sweepDueSubscriptions } from '#src/worker/subscriptions.ts';
import { realizeFees, sweepTreasury } from '#src/worker/treasury.ts';
import { reverifyCheckpoint, sealCheckpoint } from '#src/worker/checkpoint.ts';
import { sweepExpiredPromos } from '#src/worker/promos.ts';
import { relayOutbox } from '#src/worker/relay.ts';
import { drainInbox } from '#src/worker/inbox.ts';
import { reconcileDueWindows } from '#src/worker/reconcile.ts';

import type { Economy, WorkerCtx } from '#src/contract.ts';
import type {
  Dispatcher,
  Ids,
  Options,
  Range,
  Scheduler,
  Store,
} from '#src/ports.ts';
import type { PayoutSweepSummary } from '#src/worker/payouts.ts';
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
import type { InboxSummary } from '#src/worker/inbox.ts';
import type { ReconcileFeed, ReconcileSummary } from '#src/worker/reconcile.ts';

/**
 * Names of the background jobs run each cycle, and the sole definition `SweepName` is derived from.
 * `as const` (not an enum) freezes the array and keeps the literal types.
 *
 * Array order is both run order and result order, and the order matters. `feeSweep` follows
 * `treasury` because one measures the surplus and the next moves it, so keep the pair adjacent.
 * `checkpointVerify` runs before `checkpoint` so it re-checks the old sealed snapshot before a fresh
 * one overwrites it; a just-taken snapshot always passes. `drainInbox` sits next to its outbound
 * mirror `relay` and is never gated on the pause, so settlements keep flowing during a maintenance
 * window.
 */
export const SWEEP_NAMES = [
  'payouts',
  'subscriptions',
  'treasury',
  'feeSweep',
  'checkpointVerify',
  'checkpoint',
  'relay',
  'drainInbox',
  'reconcile',
  'promos',
] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

// Bundles the arguments for every background job into one object, so the runner takes a single
// value. Not every job uses every field. `now` and `limit` drive the due-item scans: `now` is the
// current time and `limit` is the per-pass cap. `dispatcher` handles event delivery. `feed` and
// `windows` drive reconciliation. `options` may carry an AbortSignal that cancels a running job.
export type SweepInput = {
  now: number;
  limit: number;
  // Transport the relay job delivers outgoing events through. Optional (see `selectDispatcher` in
  // src/index.ts): when absent the relay job is skipped and pending outbox rows wait for a later run.
  dispatcher?: Dispatcher;
  // Economy the inbox-apply job submits each stored inbound Operation through, so the money move runs
  // through the same invariants and idempotency a direct caller hits. Optional like `dispatcher`:
  // absent, `drainInbox` is skipped and pending inbox rows wait for a later run.
  economy?: Economy;
  feed: ReconcileFeed;
  windows: ReadonlyArray<Range>;
  options?: Options;
};

// Holds the outcome of one job. Either the job ran and produced a summary (`ok: true`), or it threw
// and the caught error became a result (`ok: false`) that carries the error code and retry flag.
// Errors are always reported this way, so one job's exception never escapes to the caller.
export type SweepResult<TSummary> =
  | { ok: true; summary: TSummary }
  | { ok: false; code: string; retryable: boolean };

// Combines the results from `runSweeps` into one entry per job, keyed by name. Each entry is the
// job's summary if it ran or its caught error if it failed. One job failing never hides the others.
export type SweepBatch = {
  payouts: SweepResult<PayoutSweepSummary>;
  subscriptions: SweepResult<SweepSummary>;
  treasury: SweepResult<TreasurySummary>;
  feeSweep: SweepResult<FeeRealizationSummary>;
  checkpoint: SweepResult<CheckpointSummary>;
  checkpointVerify: SweepResult<CheckpointVerifySummary>;
  relay: SweepResult<RelaySummary>;
  drainInbox: SweepResult<InboxSummary>;
  reconcile: SweepResult<ReconcileSummary>;
  promos: SweepResult<PromoExpirySummary>;
};

// Holds runOnce's result: the per-job batch plus the txn id of every ledger posting the run
// committed, so a host can fold settlements, reversals, and sweeps into a feed without intercepting
// the id generator. A rolled-back job can mint an id that never commits, so resolve each id via
// read.posting and skip a null. `postings` sits beside `batch`, not merged in, so iterating the
// batch's job results never trips over the postings list.
export type SweepRun = { batch: SweepBatch; postings: ReadonlyArray<string> };

/**
 * Handle the host program uses to drive the background jobs. `runOnce` runs every job once.
 * `start` runs them on a timer and returns a stop function; present only when a Scheduler was
 * supplied at creation (without one there's nothing to drive the loop).
 */
export type Worker = {
  runOnce(input: SweepInput): Promise<SweepRun>;
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
  const { now, limit, options } = input;
  return {
    payouts: await isolate(() => advanceDuePayouts(store, ctx, { now, limit })),
    subscriptions: await isolate(() =>
      sweepDueSubscriptions(store, ctx, { now, limit }),
    ),
    treasury: await isolate(() => sweepTreasury(store, ctx, { now })),
    // Moves the surplus the treasury sweep just measured into platform funds. Wrapped like every
    // job, so when realizeFees rejects (money owed to users must not move) that surfaces as a failed result.
    feeSweep: await isolate(() => realizeFees(store, ctx, { now })),
    // Re-checks the previous sealed snapshot before `checkpoint` below overwrites it: that old
    // snapshot predates any tampering since it was sealed, so it catches it. A mismatch is recorded
    // on the summary (not thrown), so only a corrupt row or storage failure becomes a failed result.
    checkpointVerify: await isolate(() => reverifyCheckpoint(store, ctx)),
    checkpoint: await isolate(() => sealCheckpoint(store, ctx)),
    // Relay is one of two sweeps with an optional capability. With no dispatcher there is nothing to
    // deliver through, so it short-circuits to an empty successful summary and pending rows stay in
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
    // The inbound mirror of relay, and the other sweep with an optional capability. With no economy
    // handle there is nothing to submit through, so it short-circuits to an empty summary and pending
    // inbox rows stay put. Never gated on the economy pause: settlements must keep flowing through a
    // maintenance window (see drainInbox's note).
    drainInbox:
      input.economy === undefined
        ? { ok: true, summary: { applied: [], failed: [], deadLettered: [] } }
        : await isolate(() =>
            drainInbox(
              store,
              ctx,
              { economy: input.economy!, now, limit },
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

// Runs one job and turns its outcome into a SweepResult: a return becomes `ok: true` with the
// summary, a throw is normalized (errors.ts) into the `ok: false` code and retry flag. Catching
// here keeps one failing job from stopping the others.
async function isolate<TSummary>(
  run: () => Promise<TSummary>,
): Promise<SweepResult<TSummary>> {
  try {
    return { ok: true, summary: await run() };
  } catch (error) {
    const normalized = normalizeError(error);
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
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for the sweep cycle, ordering, and isolation model.
 */
export function createWorker(
  store: Store,
  ctx: WorkerCtx,
  scheduler?: Scheduler,
): Worker {
  const runOnce = async (input: SweepInput): Promise<SweepRun> => {
    // Records every txn id minted this run through a wrapped id generator, so the host gets the run's
    // ledger postings without intercepting `ctx.ids` itself. `start` below does not need this, so it
    // stays on the bare runSweeps.
    const postings: string[] = [];
    const recordingCtx: WorkerCtx = {
      ...ctx,
      ids: {
        next: (prefix) => {
          const id = ctx.ids.next(prefix);
          if (prefix === 'txn') postings.push(id);
          return id;
        },
      } satisfies Ids,
    };
    const batch = await runSweeps(store, recordingCtx, input);
    return { batch, postings };
  };
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
