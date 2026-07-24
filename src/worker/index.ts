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
import { encodeAmount, toAmount } from '#src/money.ts';
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
import { drainAccruals } from '#src/worker/accrual.ts';
import { reproveStoredChains } from '#src/worker/reproof.ts';
import { reconcileDueWindows } from '#src/worker/reconcile.ts';

import type { Economy } from '#src/contract.ts';
import type {
  Dispatcher,
  Ids,
  CallOptions,
  Ports,
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
import type { AccrualDrainSummary } from '#src/worker/accrual.ts';
import type { ReproofSummary } from '#src/worker/reproof.ts';
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
  'accrualDrain',
  'reproof',
] as const;

/** The name of one background job in the sweep cycle; {@link SWEEP_NAMES} fixes the run order. */
export type SweepName = (typeof SWEEP_NAMES)[number];

/** Default per-job batch cap when neither the sweep request nor {@link WorkerDefaults} sets one. */
export const DEFAULT_SWEEP_LIMIT = 100;

/**
 * Arguments for one sweep pass; every field optional, falling back to the worker's
 * construction-time defaults. `now` defaults to the clock, `limit` to
 * {@link WorkerDefaults.limit} and then {@link DEFAULT_SWEEP_LIMIT}.
 */
export type SweepRequest = {
  /** Per-job cap on due items claimed this pass. */
  readonly limit?: number;
  /** The tick every job sweeps at, in epoch milliseconds. */
  readonly now?: number;
  /**
   * Narrows the run to just these jobs — the lever behind a supervisor's targeted re-drive
   * (e.g. `only: ['relay']` to push a backlog without sealing a checkpoint). A job left out
   * reports its idle summary, the same shape an absent optional dependency produces.
   */
  readonly only?: ReadonlyArray<SweepName>;
  /**
   * Transport the relay job delivers outgoing events through; absent, the relay job is skipped
   * and pending outbox rows wait for a later run.
   */
  readonly dispatcher?: Dispatcher;
  /**
   * Economy the inbox-apply job submits each stored inbound Operation through, so the money move
   * runs through the same invariants and idempotency a direct caller hits. createWorker binds
   * one; absent both, `drainInbox` is skipped.
   */
  readonly economy?: Pick<Economy, 'submit'>;
  /**
   * External float source for the treasury tie-out's coverage half; absent, `floatCoverage` is
   * skipped — the internal backing check in `treasury` runs regardless.
   */
  readonly float?: FloatFeed;
  /**
   * Settlement-report source for the reconcile job; absent (or with no windows), `reconcile` is
   * skipped — a host with no provider report has nothing to compare.
   */
  readonly feed?: ReconcileFeed;
  /** The settlement windows the reconcile job compares, each reconciled independently. */
  readonly windows?: ReadonlyArray<Range>;
  readonly options?: CallOptions;
};

/**
 * Steady-state sweep arguments bound at {@link createWorker}; any {@link SweepRequest} field
 * overrides them per sweep.
 */
export type WorkerDefaults = {
  readonly dispatcher?: Dispatcher;
  readonly float?: FloatFeed;
  readonly feed?: ReconcileFeed;
  readonly windows?: ReadonlyArray<Range>;
  readonly only?: ReadonlyArray<SweepName>;
  /** Default DEFAULT_SWEEP_LIMIT when omitted. */
  readonly limit?: number;
};

/**
 * One job's outcome: its summary, or its caught error as data (code and retry flag). A job's
 * exception never escapes to the caller.
 */
export type SweepResult<TSummary> =
  | { ok: true; summary: TSummary }
  | { ok: false; code: string; retryable: boolean };

/** One entry per job, keyed by name. A failing job never hides the others. */
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
  accrualDrain: SweepResult<AccrualDrainSummary>;
  reproof: SweepResult<ReproofSummary>;
};

/**
 * What {@link Worker.sweep} resolves to: the batch plus the txn id of every posting the run
 * minted, so a host can build a feed without intercepting the id generator. A rolled-back job
 * can mint an id that never commits, so resolve each id via `read.posting` and skip a null.
 */
export type SweepRun = { batch: SweepBatch; postings: ReadonlyArray<string> };

/**
 * Handle the host program uses to drive the background jobs: one-shot passes via
 * {@link Worker.sweep}, a timer loop via {@link Worker.start}, and a maintenance gate via
 * pause/resume.
 */
export interface Worker {
  /**
   * Runs every job once at one resolved tick and returns the batch plus the txn id of every
   * posting the run minted. Each job runs isolated, so one throw becomes that job's failed
   * result and the rest still run; sweep itself never throws. An explicit sweep still runs
   * while paused — a supervisor or operator acting deliberately is not the loop being paused.
   */
  sweep(request?: SweepRequest): Promise<SweepRun>;
  /**
   * Runs the jobs every `everyMs` on a timer — the Scheduler port when the bag has one, a
   * built-in interval timer otherwise — and returns a stop function. Every tick reads `now`
   * from the clock, which is why its request cannot carry one.
   */
  start(everyMs: number, request?: Omit<SweepRequest, 'now'>): () => void;
  /**
   * Makes the scheduled runs no-ops until {@link Worker.resume}; the timer keeps ticking, so
   * stopping stays with whoever holds the stop function.
   */
  pause(): void;
  /** Lifts {@link Worker.pause}; the next scheduled tick sweeps again. */
  resume(): void;
  /** The pause gate's state, named apart from the economy's own `maintenanceActive`. */
  readonly sweepsPaused: boolean;
}

/**
 * Run every background job once over the same shared context and input. Each job runs inside its
 * own try/catch (see `isolate`), so a throw is recorded against just that job and the rest still
 * run. Returns one combined result keyed by job name. Never throws.
 */
export async function runSweeps(
  store: Store,
  ports: Ports,
  input: SweepRequest = {},
): Promise<SweepBatch> {
  const now = input.now ?? ports.clock.now();
  const limit = input.limit ?? DEFAULT_SWEEP_LIMIT;
  const options = input.options;
  const batch = await runSweepJobs(store, ports, input, {
    now,
    limit,
    options,
  });
  // The batch heartbeat: a supervisor watching for this count going silent learns the worker
  // died faster than any downstream symptom can say so.
  try {
    ports.meter.count('worker.sweep', 1, {
      failed: String(
        Object.values(batch).filter((result) => !result.ok).length,
      ),
    });
  } catch {
    // Telemetry only; the batch is already decided.
  }
  return batch;
}

type SummaryOf<K extends SweepName> = Extract<
  SweepBatch[K],
  { ok: true }
>['summary'];

// The empty-ok summary each job reports when it does not run — left out of `SweepRequest.only`,
// or missing its optional dependency — so callers never see a third result shape.
const IDLE_SUMMARIES: { [K in SweepName]: SummaryOf<K> } = {
  payouts: { submitted: [], deadLettered: [], retrying: [] },
  subscriptions: { charged: [], lapsed: [], deadLettered: [], retrying: [] },
  treasury: { position: null, breaches: [], retrying: [], failed: [] },
  feeSweep: {
    swept: encodeAmount(toAmount('CREDIT', 0n)),
    skipped: true,
    duplicate: false,
  },
  floatCoverage: { position: null, breaches: [], retrying: [], failed: [] },
  checkpointVerify: {
    verified: null,
    skipped: true,
    mismatch: false,
    deadLettered: [],
    retrying: [],
  },
  checkpoint: { sealed: null, skipped: true, deadLettered: [], retrying: [] },
  relay: { relayed: [], failed: [], deadLettered: [] },
  drainInbox: { applied: [], failed: [], deadLettered: [] },
  reconcile: { reconciled: [], drifted: [], failed: [] },
  promos: { reversed: [], failed: [] },
  accrualDrain: { drained: [], failed: [], skipped: true },
  reproof: { checked: 0, cursor: null, rotatedAt: null, skipped: true },
};

type ResolvedTick = { now: number; limit: number; options?: CallOptions };

// The `only` filter as a job wrapper: a left-out job resolves to its idle summary unrun.
function gateOf(input: SweepRequest) {
  return <K extends SweepName>(
    name: K,
    run: () => Promise<SweepResult<SummaryOf<K>>>,
  ): Promise<SweepResult<SummaryOf<K>>> =>
    input.only === undefined || input.only.includes(name)
      ? run()
      : Promise.resolve({ ok: true, summary: IDLE_SUMMARIES[name] });
}

async function runSweepJobs(
  store: Store,
  ctx: Ports,
  input: SweepRequest,
  { now, limit, options }: ResolvedTick,
): Promise<SweepBatch> {
  const gate = gateOf(input);
  return {
    payouts: await gate('payouts', () =>
      isolate(() => advanceDuePayouts(store, ctx, { now, limit })),
    ),
    subscriptions: await gate('subscriptions', () =>
      isolate(() => sweepDueSubscriptions(store, ctx, { now, limit })),
    ),
    treasury: await gate('treasury', () =>
      isolate(() => sweepTreasury(store, ctx, { now })),
    ),
    feeSweep: await gate('feeSweep', () =>
      isolate(() => realizeFees(store, ctx, { now })),
    ),
    floatCoverage: await gate('floatCoverage', () =>
      input.float === undefined
        ? Promise.resolve({ ok: true, summary: IDLE_SUMMARIES.floatCoverage })
        : isolate(() => sweepFloatCoverage(store, ctx, input.float!, { now })),
    ),
    // A verify mismatch is recorded on the summary, not thrown; only a corrupt row or storage
    // failure becomes a failed result.
    checkpointVerify: await gate('checkpointVerify', () =>
      isolate(() => reverifyCheckpoint(store, ctx)),
    ),
    checkpoint: await gate('checkpoint', () =>
      isolate(() => sealCheckpoint(store, ctx)),
    ),
    // The optional dispatcher is handled only here; relayOutbox itself always requires one.
    relay: await gate('relay', () =>
      input.dispatcher === undefined
        ? Promise.resolve({ ok: true, summary: IDLE_SUMMARIES.relay })
        : isolate(() =>
            relayOutbox(
              store,
              ctx,
              { dispatcher: input.dispatcher!, limit },
              options,
            ),
          ),
    ),
    drainInbox: await gate('drainInbox', () =>
      input.economy === undefined
        ? Promise.resolve({ ok: true, summary: IDLE_SUMMARIES.drainInbox })
        : isolate(() =>
            drainInbox(
              store,
              ctx,
              { economy: input.economy!, now, limit },
              options,
            ),
          ),
    ),
    reconcile: await gate('reconcile', () =>
      input.feed === undefined
        ? Promise.resolve({ ok: true, summary: IDLE_SUMMARIES.reconcile })
        : isolate(() =>
            reconcileDueWindows(
              input.feed!,
              ctx,
              { windows: input.windows ?? [] },
              options,
            ),
          ),
    ),
    promos: await gate('promos', () =>
      isolate(() => sweepExpiredPromos(store, ctx, { now, limit }, options)),
    ),
    accrualDrain: await gate('accrualDrain', () =>
      isolate(() => drainAccruals(store, ctx, { now, limit })),
    ),
    reproof: await gate('reproof', () =>
      isolate(() => reproveStoredChains(store, ctx, { now, limit })),
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
 * Build the worker over an open Ports bag and the economy its inbox job submits through.
 * `defaults` binds the steady-state feeds, dispatcher, and limit; a sweep request overrides any
 * of them per run. The dispatcher falls back to the bag's own, so an env-selected transport
 * relays without restating. `start` drives the loop through the bag's Scheduler when one is
 * present, else a built-in interval timer.
 *
 * @example
 * const worker = createWorker(ports, economy, { dispatcher });
 * const stop = worker.start(30_000); // full pass every 30s
 * const run = await worker.sweep({ only: ['relay'] }); // targeted manual pass
 * const failed = SWEEP_NAMES.filter((name) => !run.batch[name].ok);
 * stop();
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for the sweep cycle, ordering, and isolation model.
 */
export function createWorker(
  ports: Ports,
  economy: Economy,
  defaults: WorkerDefaults = {},
): Worker {
  const store = ports.store;
  const resolve = (request: SweepRequest): SweepRequest => ({
    now: request.now ?? ports.clock.now(),
    limit: request.limit ?? defaults.limit ?? DEFAULT_SWEEP_LIMIT,
    only: request.only ?? defaults.only,
    dispatcher: request.dispatcher ?? defaults.dispatcher ?? ports.dispatcher,
    economy: request.economy ?? economy,
    float: request.float ?? defaults.float,
    feed: request.feed ?? defaults.feed,
    windows: request.windows ?? defaults.windows,
    options: request.options,
  });
  let paused = false;
  const scheduler = ports.scheduler ?? intervalScheduler();

  const sweep = async (request: SweepRequest = {}): Promise<SweepRun> => {
    // A wrapped id generator records the run's txn ids (see SweepRun). `start` below does not need
    // this, so it stays on the bare runSweeps.
    const postings: string[] = [];
    const recordingPorts: Ports = {
      ...ports,
      ids: {
        next: (prefix) => {
          const id = ports.ids.next(prefix);
          if (prefix === 'txn') postings.push(id);
          return id;
        },
      } satisfies Ids,
    };
    const batch = await runSweeps(store, recordingPorts, resolve(request));
    return { batch, postings };
  };

  return {
    sweep,
    start: (everyMs, request = {}) =>
      scheduler.every(
        everyMs,
        async () => {
          if (paused) return;
          // resolve() reads the clock here, so every tick sweeps at its own moment.
          await runSweeps(store, ports, resolve(request));
        },
        request.options,
      ),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    get sweepsPaused() {
      return paused;
    },
  };
}

function intervalScheduler(): Scheduler {
  return {
    every: (ms, task) => {
      // The one sanctioned raw timer: this IS the fallback Scheduler the restriction elsewhere
      // points to. runSweeps never throws, so the fire-and-forget tick cannot leak a rejection.
      // eslint-disable-next-line no-restricted-globals
      const timer = setInterval(() => void task(), ms);
      // Node's interval holds the event loop open; unref (absent on web runtimes) lets an
      // embedding host exit without calling the stop handle.
      const handle = timer as { unref?: () => void };
      if (typeof handle.unref === 'function') {
        handle.unref();
      }
      return () => clearInterval(timer);
    },
  };
}

// The rest of the /worker facet: the two directly-drivable jobs and the host-implemented feeds.
export { drainInbox } from '#src/worker/inbox.ts';
export { relayOutbox } from '#src/worker/relay.ts';
export type { FloatFeed } from '#src/worker/treasury.ts';
export type { ReconcileFeed } from '#src/worker/reconcile.ts';
