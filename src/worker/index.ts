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
import {
  realizeFees,
  sweepFloatCoverage,
  sweepTreasury,
} from '#src/worker/treasury.ts';
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
  FloatFeed,
  FloatSummary,
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
  'floatCoverage',
  'checkpointVerify',
  'checkpoint',
  'relay',
  'drainInbox',
  'reconcile',
  'promos',
] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

// Arguments for every background job in one object; not every job uses every field. `limit` caps
// each due-item pass, and `options` may carry an AbortSignal that cancels a running job.
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
  // Settlement-report source for the reconcile job. Optional like `dispatcher`: absent (or with
  // no windows), `reconcile` is skipped — a host with no provider report has nothing to compare.
  feed?: ReconcileFeed;
  windows?: ReadonlyArray<Range>;
  // External float source for the treasury tie-out's coverage half. Optional like `dispatcher`:
  // absent, `floatCoverage` is skipped — the internal backing check in `treasury` runs regardless.
  float?: FloatFeed;
  options?: Options;
};

// One job's outcome: its summary, or its caught error as data (code and retry flag). A job's
// exception never escapes to the caller.
export type SweepResult<TSummary> =
  | { ok: true; summary: TSummary }
  | { ok: false; code: string; retryable: boolean };

// One entry per job, keyed by name. A failing job never hides the others.
export type SweepBatch = {
  payouts: SweepResult<PayoutSweepSummary>;
  subscriptions: SweepResult<SweepSummary>;
  treasury: SweepResult<TreasurySummary>;
  feeSweep: SweepResult<FeeRealizationSummary>;
  floatCoverage: SweepResult<FloatSummary>;
  checkpoint: SweepResult<CheckpointSummary>;
  checkpointVerify: SweepResult<CheckpointVerifySummary>;
  relay: SweepResult<RelaySummary>;
  drainInbox: SweepResult<InboxSummary>;
  reconcile: SweepResult<ReconcileSummary>;
  promos: SweepResult<PromoExpirySummary>;
};

// runOnce's result: the batch plus the txn id of every posting the run minted, so a host can build
// a feed without intercepting the id generator. A rolled-back job can mint an id that never
// commits, so resolve each id via read.posting and skip a null.
export type SweepRun = { batch: SweepBatch; postings: ReadonlyArray<string> };

/**
 * Handle the host program uses to drive the background jobs. `runOnce` runs every job once.
 * `start` runs them on a timer and returns a stop function; present only when a Scheduler was
 * supplied at creation (without one there's nothing to drive the loop).
 *
 * `pause` makes the scheduled runs no-ops until `resume`; the timer keeps ticking so stop stays
 * with whoever holds the stop function. An explicit `runOnce` still runs while paused — a
 * supervisor or operator acting deliberately is not the loop being paused.
 */
export type Worker = {
  runOnce(input: SweepInput): Promise<SweepRun>;
  pause(): void;
  resume(): void;
  paused(): boolean;
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
    feeSweep: await isolate(() => realizeFees(store, ctx, { now })),
    floatCoverage:
      input.float === undefined
        ? {
            ok: true,
            summary: { position: null, breaches: [], retrying: [], failed: [] },
          }
        : await isolate(() =>
            sweepFloatCoverage(store, ctx, input.float!, { now }),
          ),
    // A verify mismatch is recorded on the summary, not thrown; only a corrupt row or storage
    // failure becomes a failed result.
    checkpointVerify: await isolate(() => reverifyCheckpoint(store, ctx)),
    checkpoint: await isolate(() => sealCheckpoint(store, ctx)),
    // The optional dispatcher is handled only here; relayOutbox itself always requires one.
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
    reconcile:
      input.feed === undefined
        ? { ok: true, summary: { reconciled: [], drifted: [], failed: [] } }
        : await isolate(() =>
            reconcileDueWindows(
              input.feed!,
              ctx,
              { windows: input.windows ?? [] },
              options,
            ),
          ),
    promos: await isolate(() =>
      sweepExpiredPromos(store, ctx, { now, limit }, options),
    ),
  };
}

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
  let paused = false;
  const controls = {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    paused: () => paused,
  };
  const runOnce = async (input: SweepInput): Promise<SweepRun> => {
    // A wrapped id generator records the run's txn ids (see SweepRun). `start` below does not need
    // this, so it stays on the bare runSweeps.
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
    return { runOnce, ...controls };
  }
  return {
    runOnce,
    ...controls,
    start: (intervalMs, input) =>
      scheduler.every(
        intervalMs,
        async () => {
          if (paused) return;
          await runSweeps(store, ctx, input);
        },
        input.options,
      ),
  };
}
