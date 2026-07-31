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

import {
  detectDeadlockStorm,
  detectEngineStall,
  detectInboxDeadLetters,
  detectIntegrityMismatches,
  detectOutboxBacklog,
  detectRetryExhaustion,
  detectSilences,
  detectSlowSeal,
  detectStuckSagas,
  detectTreasuryBreaches,
  detectVelocityAnomaly,
  detectWebhookReplayStorm,
} from '#src/supervisor/detect.ts';

import { intFault, mustBe } from '#src/config.ts';
import { ERROR_CODES, fault } from '#src/errors.ts';

import type { ProveReport } from '#src/contract.ts';
import type { IntBounds } from '#src/env.ts';
import type { Clock, Saga, Scheduler } from '#src/ports.ts';
import type {
  AuditPhase,
  AuditRecord,
  AuditSink,
} from '#src/supervisor/audit.ts';
import type { StuckSagaFinding } from '#src/supervisor/detect.ts';
import type { SignalFeed, SupervisorRuntime } from '#src/supervisor/runtime.ts';

/**
 * The saga store slice the supervisor polls. `list` streams every saga for the stuck-saga
 * detector's full walk, and `load` re-reads one saga after a sweep — the verify step that
 * decides whether the action progressed it. A store's `sagas` handle satisfies this directly.
 */
export type SagaSource = {
  list(): AsyncIterable<Saga>;
  load(id: string): Promise<Saga | null>;
};

/**
 * The tuning surface holds per-signature thresholds and windows plus the shared guardrail knobs
 * (`actionCooldownMs`, `maxActionAttempts`). Every duration is in milliseconds. Passed as a
 * partial through {@link SupervisorPorts.config}; unset fields keep the
 * {@link defaultSupervisorConfig} values.
 */
export type SupervisorConfig = {
  /** A non-terminal saga counts as stuck once its last update is at least this old. */
  stuckSagaAgeMs: number;
  /**
   * Minimum spacing between two lever actions — tracked per saga for the stuck-saga pass, per
   * signature for the outbox and inbox passes.
   */
  actionCooldownMs: number;
  /** Lever attempts (per the same tracking) before the pass escalates permanently instead of acting. */
  maxActionAttempts: number;
  /** The meter name the deadlock-storm pass sums, `engine.retry` by default. */
  deadlockMetric: string;
  /** The deadlock-storm window; also the minimum spacing between two storm reports. */
  deadlockWindowMs: number;
  /** Retry volume in the window at or above which the storm pass reports. */
  deadlockThreshold: number;
  /** How long the oldest unanswered pool acquire waits before the stall pass escalates. */
  stallGraceMs: number;
  /** The velocity-anomaly window; also the minimum spacing between two anomaly reports. */
  anomalyWindowMs: number;
  /** RISK_DENIED rejections in the window at or above which the velocity pass reports. */
  anomalyThreshold: number;
  /** At or above this many rejections in the window, the velocity pass escalates instead of advising. */
  anomalyEscalationThreshold: number;
  /** The retry-exhaustion window; also the minimum spacing between two exhaustion reports. */
  retryExhaustionWindowMs: number;
  /** Exhausted budgets in the window at or above which the exhaustion pass escalates. */
  retryExhaustionThreshold: number;
  /** Backlog age at or past which the outbox pass re-drives the relay. */
  outboxBacklogAgeMs: number;
  /** The replay-storm window; also the minimum spacing between two storm reports. */
  webhookReplayWindowMs: number;
  /** Dropped duplicates in the window at or above which the replay pass reports. */
  webhookReplayThreshold: number;
  /** A completed checkpoint seal at or past this duration counts as slow. */
  sealLatencyMs: number;
  /** The slow-seal window; also the minimum spacing between two slow-seal reports. */
  sealLatencyWindowMs: number;
  /** New dead-letter signals at or above which the inbox pass opens a revive episode. */
  inboxDeadLetterThreshold: number;
  /** Most dead inbox rows one revive episode flips back to pending. */
  inboxReviveLimit: number;
  /** Signals the host declares as periodic. The silence pass escalates past twice each cadence. */
  watchdogs: ReadonlyArray<{ signal: string; everyMs: number }>;
};

/**
 * The defaults every pass runs under when {@link SupervisorPorts.config} leaves a field unset.
 * `watchdogs` defaults empty — the silence pass watches nothing until the host declares its
 * periodic signals.
 */
export const defaultSupervisorConfig: SupervisorConfig = {
  stuckSagaAgeMs: 300_000,
  actionCooldownMs: 60_000,
  maxActionAttempts: 3,
  deadlockMetric: 'engine.retry',
  deadlockWindowMs: 60_000,
  deadlockThreshold: 20,
  stallGraceMs: 10_000,
  anomalyWindowMs: 300_000,
  anomalyThreshold: 20,
  anomalyEscalationThreshold: 100,
  retryExhaustionWindowMs: 300_000,
  retryExhaustionThreshold: 5,
  outboxBacklogAgeMs: 300_000,
  webhookReplayWindowMs: 60_000,
  webhookReplayThreshold: 20,
  sealLatencyMs: 5_000,
  sealLatencyWindowMs: 300_000,
  inboxDeadLetterThreshold: 1,
  inboxReviveLimit: 10,
  watchdogs: [],
};

// The ceiling every duration in the table below is held to. The economy's own webhook skew window
// states the same day for the same reason: past it the check the value feeds is not tuned, it is
// off.
const A_DAY_MS = 24 * 60 * 60_000;

/**
 * How one {@link SupervisorConfig} knob is bounded. Keyed by `keyof SupervisorConfig`, so a knob
 * added to the type leaves the table short a key and fails the typecheck.
 */
interface SupervisorKnob {
  /** Integer bounds, in the knob's own unit. On `watchdogs` they bound each entry's cadence. */
  readonly int?: IntBounds;
  /** The knob is a meter or event name. */
  readonly name?: true;
  /** The knob is the watchdog list. */
  readonly list?: true;
}

/**
 * Every knob's bounds. A supervisor is a detector, so a value outside them does not tune a pass —
 * it switches one off, in one of two directions, and neither says so:
 *
 * - A window at or below zero empties `signals.since(now - window)`, so the pass reports nothing
 *   while the incident it watches for runs. A duration past a day does the same from above.
 * - A threshold or age gate at or below zero makes the pass's own comparison always true, so it
 *   reports an incident, and pulls its lever, on a healthy system.
 *
 * The count thresholds carry no ceiling on purpose: the value above which one stops firing is the
 * host's traffic, which the lab cannot know. `withinIntBounds` still refuses a non-integer,
 * `NaN`, `Infinity` and anything past `Number.MAX_SAFE_INTEGER`.
 */
const SUPERVISOR_KNOBS = {
  // At 0 every non-terminal saga is stuck the moment it is created, and the sweep lever runs on
  // all of them.
  stuckSagaAgeMs: { int: { min: 1, max: A_DAY_MS } },
  // The one knob here that is spacing rather than detection, so 0 is a choice: act on every tick.
  actionCooldownMs: { int: { min: 0, max: A_DAY_MS } },
  // At 0 the cap is reached before the first action, so every tier-1 pass escalates instead of
  // ever pulling its lever.
  maxActionAttempts: { int: { min: 1 } },
  deadlockMetric: { name: true },
  deadlockWindowMs: { int: { min: 1, max: A_DAY_MS } },
  deadlockThreshold: { int: { min: 1 } },
  // At 0 an acquire that has not completed yet is a stall, which is every acquire in flight.
  stallGraceMs: { int: { min: 1, max: A_DAY_MS } },
  anomalyWindowMs: { int: { min: 1, max: A_DAY_MS } },
  anomalyThreshold: { int: { min: 1 } },
  anomalyEscalationThreshold: { int: { min: 1 } },
  retryExhaustionWindowMs: { int: { min: 1, max: A_DAY_MS } },
  retryExhaustionThreshold: { int: { min: 1 } },
  // At 0 a drained outbox is a backlog, and the relay is re-driven on every tick.
  outboxBacklogAgeMs: { int: { min: 1, max: A_DAY_MS } },
  webhookReplayWindowMs: { int: { min: 1, max: A_DAY_MS } },
  webhookReplayThreshold: { int: { min: 1 } },
  // At 0 every completed seal is slow, so the trend this watches never has a quiet baseline.
  sealLatencyMs: { int: { min: 1, max: A_DAY_MS } },
  sealLatencyWindowMs: { int: { min: 1, max: A_DAY_MS } },
  inboxDeadLetterThreshold: { int: { min: 1 } },
  // Reaches the store as its row limit; 0 revives nothing and a negative is not a limit.
  inboxReviveLimit: { int: { min: 1 } },
  // A cadence at or below zero reports a watchdog silent on the tick watching started.
  watchdogs: { list: true, int: { min: 1, max: A_DAY_MS } },
} as const satisfies Readonly<Record<keyof SupervisorConfig, SupervisorKnob>>;

/**
 * Refuses a supplied override outside {@link SUPERVISOR_KNOBS} and returns the resolved config.
 *
 * This is the supervisor's half of the rule `checkedConfig` states for the economy: a knob
 * written in code has no fallback that is not a value nobody chose, so the door refuses rather
 * than clamps. Unset fields take their default and are not checked — the defaults are the table's
 * own values.
 */
function checkedSupervisorConfig(
  supplied: Partial<SupervisorConfig> | undefined,
): SupervisorConfig {
  const issues: { knob: string; message: string }[] = [];
  for (const knob of Object.keys(
    SUPERVISOR_KNOBS,
  ) as (keyof SupervisorConfig)[]) {
    if (supplied === undefined || !(knob in supplied)) {
      continue;
    }
    const found = tuningFault(knob, SUPERVISOR_KNOBS[knob], supplied[knob]);
    if (found !== null) {
      issues.push({ knob, message: found });
    }
  }
  if (issues.length > 0) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      issues.map((one) => one.message).join(' '),
      {
        detail: { knobs: issues.map((one) => one.knob) },
        retryable: false,
      },
    );
  }
  return { ...defaultSupervisorConfig, ...supplied };
}

const nameFault = (path: string, value: unknown): string | null =>
  mustBe(
    path,
    'a non-empty meter name',
    value,
    typeof value === 'string' && value.trim() !== '',
  );

function tuningFault(
  name: string,
  knob: SupervisorKnob,
  value: unknown,
): string | null {
  const path = `config.${name}`;
  if (knob.name === true) {
    return nameFault(path, value);
  }
  if (knob.list === true) {
    return watchdogFault(path, knob.int, value);
  }
  return intFault(path, knob.int, value);
}

function watchdogFault(
  path: string,
  bounds: IntBounds | undefined,
  value: unknown,
): string | null {
  if (!Array.isArray(value)) {
    return `${path} must be a list of { signal, everyMs }; it was ${JSON.stringify(value) ?? String(value)}.`;
  }
  for (const [index, entry] of value.entries()) {
    const found =
      nameFault(`${path}[${index}].signal`, entry?.signal) ??
      intFault(`${path}[${index}].everyMs`, bounds, entry?.everyMs);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * What the host injects into {@link createSupervisor}. The required ports cover observation
 * (clock, signals, sagas), the one mandatory lever (`runSweep`), and the audit sink. The
 * optional ports add levers and hooks the matching passes use when present and quietly skip
 * when absent.
 */
export type SupervisorPorts = {
  clock: Clock;
  /** The detector's input, normally a {@link SupervisorRuntime}'s `signals`. */
  signals: SignalFeed;
  /** The saga store slice the stuck-saga pass polls and re-reads. */
  sagas: SagaSource;
  /**
   * The stuck-saga lever is one guarded worker sweep, typically
   * `(now) => worker.sweep({ now, limit })`. One sweep serves every actionable saga. The pass
   * verifies by re-loading each saga afterward. It is also the outbox fallback when `runRelay`
   * is absent.
   */
  runSweep: (now: number) => Promise<unknown>;
  /**
   * Receives every audit record synchronously as the tick emits it, before the record is also
   * returned from `tick()`. A throwing sink aborts the tick.
   */
  audit: AuditSink;
  /**
   * Runs the integrity prover once when a mismatch episode is detected; the report rides the
   * escalation record as evidence. The record's `detail.prover` names whichever prover filled it,
   * because `proveEconomy` and `read.health()` answer `chainIntact` differently and the escalation
   * is read after the containment latch has already pulled. A prover that throws leaves
   * `{ proverFailed }` and a null prover; when the port is absent the escalation carries both null.
   */
  prove?: () => Promise<ProveReport>;
  /**
   * Called once per escalation with the same record already sent to `audit` — the pager hook.
   * When absent, escalations still reach the audit trail.
   */
  escalate?: (record: AuditRecord) => void;
  /**
   * Pauses the host worker's scheduled loop — the containment lever the integrity pass pulls.
   * This is a one-way switch on purpose. The supervisor never resumes the worker. A human
   * does, after reviewing the evidence.
   */
  pauseWorker?: () => void;
  /**
   * A targeted relay run for the outbox-backlog remediation, typically
   * `worker.sweep({ ...input, only: ['relay'] })`. Falls back to `runSweep` when absent.
   */
  runRelay?: (now: number) => Promise<unknown>;
  /** Flips up to `limit` dead inbox rows back to pending, typically `store.inbox.reviveDead`. */
  reviveInbox?: (limit: number) => Promise<ReadonlyArray<{ id: string }>>;
  /** Per-field overrides merged over {@link defaultSupervisorConfig}. */
  config?: Partial<SupervisorConfig>;
};

/** The handle {@link createSupervisor} returns. */
export type Supervisor = {
  /**
   * Runs every detection pass once against the current clock. Returns the audit records the
   * tick emitted (each already delivered to the audit sink), or an empty array when nothing
   * fired.
   *
   * A tick that arrives while one is still running returns an empty array without running —
   * overlap is skipped, not queued.
   */
  tick(): Promise<ReadonlyArray<AuditRecord>>;
  /**
   * Ticks on the supplied Scheduler every `intervalMs` and returns the cancel function.
   * Present only when {@link createSupervisor} was given a Scheduler.
   */
  start?(intervalMs: number): () => void;
};

type SagaActionState = {
  attempts: number;
  lastActedAt: number;
  escalated: boolean;
};

type SupervisorState = {
  perSaga: Map<string, SagaActionState>;
  stormReportedAt: number;
  mismatchHandledUpTo: number;
  stallEscalated: boolean;
  breachHandledUpTo: number;
  anomalyReportedAt: number;
  silenceEscalated: Map<string, boolean>;
  watchStartedAt: number | null;
  exhaustionReportedAt: number;
  replayStormReportedAt: number;
  sealSlowReportedAt: number;
  // The containment latch. Any integrity episode sets it, and only a supervisor restart
  // clears it. While set, no tier-1 pass calls its lever — `sweep` deliberately ignores
  // `paused()`, so without this the supervisor's own remediations would keep writing through
  // a paused worker.
  containment: boolean;
  outboxAction: SagaActionState;
  outboxVerify: { actedAt: number; ageAtAction: number } | null;
  inboxAction: SagaActionState;
  inboxHandledUpTo: number;
};

function initialState(): SupervisorState {
  return {
    perSaga: new Map(),
    stormReportedAt: Number.NEGATIVE_INFINITY,
    mismatchHandledUpTo: Number.NEGATIVE_INFINITY,
    stallEscalated: false,
    breachHandledUpTo: Number.NEGATIVE_INFINITY,
    anomalyReportedAt: Number.NEGATIVE_INFINITY,
    silenceEscalated: new Map(),
    watchStartedAt: null,
    exhaustionReportedAt: Number.NEGATIVE_INFINITY,
    replayStormReportedAt: Number.NEGATIVE_INFINITY,
    sealSlowReportedAt: Number.NEGATIVE_INFINITY,
    containment: false,
    outboxAction: idleAction(),
    outboxVerify: null,
    inboxAction: idleAction(),
    inboxHandledUpTo: Number.NEGATIVE_INFINITY,
  };
}

function idleAction(): SagaActionState {
  return {
    attempts: 0,
    lastActedAt: Number.NEGATIVE_INFINITY,
    escalated: false,
  };
}

type Pass = {
  deps: SupervisorPorts;
  config: SupervisorConfig;
  state: SupervisorState;
  now: number;
  emit: (record: AuditRecord) => void;
};

/**
 * Builds a supervisor over an already-built supervisor runtime. The runtime's signal feed slots in,
 * and the host supplies the rest of the ports.
 */
export function createSupervisorFrom(
  runtime: SupervisorRuntime,
  ports: Omit<SupervisorPorts, 'signals'>,
  scheduler?: Scheduler,
): Supervisor {
  return createSupervisor({ ...ports, signals: runtime.signals }, scheduler);
}

/**
 * Builds the supervisor from its injected ports. Each tick runs the twelve incident passes
 * once.
 *
 * Tier-3 signatures report or escalate with an advisory and touch nothing. The three tier-1
 * signatures (stuck-saga, outbox-backlog, inbox-dead-letter) call their lever under the shared
 * guardrails: the cooldown spaces actions out, and the attempt cap converts further action into
 * a permanent escalation.
 *
 * Any integrity episode sets a containment latch that silences every lever until the supervisor
 * is restarted. The integrity pass itself never fixes anything. It proves once, escalates,
 * pauses the worker, and latches.
 *
 * All dedupe state is in-memory, so a restart starts clean.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ops/the-supervisor/ The supervisor}
 * for the tier model and the per-signature runbooks.
 *
 * @example
 * const runtime = createSupervisorRuntime({ meter, logger, clock });
 * // compose the economy and worker over runtime.meter / runtime.logger, then:
 * const supervisor = createSupervisor(
 *   {
 *     // observation
 *     clock,
 *     signals: runtime.signals,
 *     sagas: ports.store.sagas,
 *     // levers
 *     runSweep: (now) => worker.sweep({ now, limit: 10 }),
 *     runRelay: (now) => worker.sweep({ now, only: ['relay'] }), // optional: targeted outbox re-drive; falls back to runSweep
 *     reviveInbox: (limit) => ports.store.inbox.reviveDead(limit), // optional: the inbox dead-letter lever
 *     pauseWorker: () => worker.pause(), // optional: the integrity containment lever
 *     // reporting
 *     audit: jsonlAuditSink((line) => trail.write(`${line}\n`)),
 *     escalate: (record) => pager.notify(record), // optional: the pager hook
 *     prove: () => proveEconomy(ports), // optional: evidence on an integrity escalation
 *     config: { stuckSagaAgeMs: 600_000, maxActionAttempts: 5 }, // optional: merged over defaultSupervisorConfig
 *   },
 *   scheduler, // optional: enables supervisor.start(intervalMs)
 * );
 * const records = await supervisor.tick();
 */
export function createSupervisor(
  deps: SupervisorPorts,
  scheduler?: Scheduler,
): Supervisor {
  // At construction, not at the first tick: a supervisor built on a knob nobody chose must not
  // exist to be started. The field keeps the type `Partial<SupervisorConfig>` because it is on
  // the published surface; the check is the guarantee, not the type.
  const config = checkedSupervisorConfig(deps.config);
  const state = initialState();
  // Overlapping ticks would both decide to act before either records its cooldown, so a
  // tick that arrives while one is still running is skipped, not queued.
  let inFlight = false;
  const tick = async (): Promise<ReadonlyArray<AuditRecord>> => {
    if (inFlight) {
      return [];
    }
    inFlight = true;
    try {
      const now = deps.clock.now();
      const out: AuditRecord[] = [];
      const pass: Pass = {
        deps,
        config,
        state,
        now,
        emit: (record) => {
          deps.audit(record);
          out.push(record);
        },
      };
      state.watchStartedAt ??= now;
      await runIntegrityPass(pass);
      // This runs before the saga poll because a stalled engine can hang that poll, and the
      // escalations must reach the audit sink regardless.
      runStallPass(pass);
      runTreasuryPass(pass);
      runSilencePass(pass);
      runStormPass(pass);
      runRetryExhaustionPass(pass);
      runReplayStormPass(pass);
      runSealLatencyPass(pass);
      runVelocityPass(pass);
      await runStuckSagaPass(pass);
      await runOutboxBacklogPass(pass);
      await runInboxDeadLetterPass(pass);
      return out;
    } finally {
      inFlight = false;
    }
  };
  if (scheduler === undefined) {
    return { tick };
  }
  return {
    tick,
    start: (intervalMs) =>
      scheduler.every(intervalMs, async () => {
        await tick();
      }),
  };
}

async function runIntegrityPass(pass: Pass): Promise<void> {
  const { deps, state, now, emit } = pass;
  const findings = detectIntegrityMismatches(
    deps.signals,
    state.mismatchHandledUpTo,
  );
  if (findings.length === 0) {
    return;
  }
  emit({
    at: now,
    signature: 'integrity-mismatch',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: {
      signals: findings.length,
      channels: [...new Set(findings.map((finding) => finding.channel))],
    },
  });
  const proof = await runProver(deps);
  const escalation: AuditRecord = {
    at: now,
    signature: 'integrity-mismatch',
    tier: 3,
    phase: 'escalated',
    subject: null,
    detail: { prover: proverOf(proof), proof },
  };
  emit(escalation);
  notifyPager(pass, escalation);
  // This is containment, not remediation. The ledger is never touched. The latch stops every
  // tier-1 lever, and the pause stops the scheduled loop. Both hold until a human reviews the
  // evidence (resume + supervisor restart).
  state.containment = true;
  if (deps.pauseWorker !== undefined) {
    let failure: string | null = null;
    try {
      deps.pauseWorker();
    } catch (error) {
      failure = String(error);
    }
    emit({
      at: now,
      signature: 'integrity-mismatch',
      tier: 3,
      phase: 'acted',
      subject: null,
      detail:
        failure === null ? { action: 'pause' } : { action: 'pause', failure },
    });
  }
  state.mismatchHandledUpTo = findings.reduce(
    (max, finding) => Math.max(max, finding.at),
    state.mismatchHandledUpTo,
  );
}

/**
 * Hands one escalation to the pager hook. A host hook can be down, and a throw out of it used to
 * abort the whole tick: on an integrity episode that aborted between the escalation and the
 * containment it announces, so `pauseWorker` never ran, the latch never set, and every later tick
 * re-detected the same mismatch and threw again. The failure rides the audit trail instead, the
 * way every lever's does, and only when there is one — a page that goes out adds no record.
 */
function notifyPager(pass: Pass, record: AuditRecord): void {
  const { deps, emit } = pass;
  if (deps.escalate === undefined) {
    return;
  }
  try {
    deps.escalate(record);
  } catch (error) {
    emit({
      ...record,
      phase: 'acted',
      detail: { action: 'page', failure: String(error) },
    });
  }
}

type Proof = ProveReport | { proverFailed: string } | null;

async function runProver(deps: SupervisorPorts): Promise<Proof> {
  if (deps.prove === undefined) {
    return null;
  }
  try {
    return await deps.prove();
  } catch (error) {
    return { proverFailed: String(error) };
  }
}

// The escalation names its prover even in the two states that have no report, so no record leaves
// the reader inferring which question `chainIntact` answered.
function proverOf(proof: Proof): ProveReport['prover'] | null {
  return proof !== null && 'prover' in proof ? proof.prover : null;
}

const STALL_ADVISORY =
  'Connection acquires started and none completed: the pool is starved or the ' +
  'database is unresponsive. Submits queue until DB_CONNECT_TIMEOUT_MS, then the ' +
  'acquire fails. Check database liveness, then pool sizing (DB_POOL_MAX).';

function runStallPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  const stall = detectEngineStall(deps.signals, now, {
    graceMs: config.stallGraceMs,
  });
  if (stall === null) {
    state.stallEscalated = false;
    return;
  }
  if (state.stallEscalated) {
    return;
  }
  state.stallEscalated = true;
  emit({
    at: now,
    signature: 'engine-stall',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: { pending: stall.pending, oldestWaitMs: stall.oldestWaitMs },
  });
  const escalation: AuditRecord = {
    at: now,
    signature: 'engine-stall',
    tier: 3,
    phase: 'escalated',
    subject: null,
    detail: {
      pending: stall.pending,
      oldestWaitMs: stall.oldestWaitMs,
      advisory: STALL_ADVISORY,
    },
  };
  emit(escalation);
  notifyPager(pass, escalation);
}

function runTreasuryPass(pass: Pass): void {
  const { deps, state, now, emit } = pass;
  const breach = detectTreasuryBreaches(deps.signals, state.breachHandledUpTo);
  if (breach === null) {
    return;
  }
  state.breachHandledUpTo = breach.newestAt;
  emit({
    at: now,
    signature: 'treasury-breach',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: { breaches: breach.breaches, channels: [...breach.channels] },
  });
  const escalation: AuditRecord = {
    at: now,
    signature: 'treasury-breach',
    tier: 3,
    phase: 'escalated',
    subject: null,
    detail: {
      breaches: breach.breaches,
      channels: [...breach.channels],
      advisory:
        'The backing invariant is breached: custodial CREDIT exceeds what the trust or ' +
        'float covers. Money already moved wrong somewhere upstream; reconcile before ' +
        'anything is paid out. Never auto-fixed.',
    },
  };
  emit(escalation);
  notifyPager(pass, escalation);
}

function runSilencePass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  const findings = detectSilences(
    deps.signals,
    now,
    config.watchdogs,
    state.watchStartedAt ?? now,
  );
  const silentNow = new Set(findings.map((finding) => finding.signal));
  for (const [signal, flagged] of state.silenceEscalated) {
    if (flagged && !silentNow.has(signal)) {
      state.silenceEscalated.set(signal, false);
    }
  }
  for (const finding of findings) {
    if (state.silenceEscalated.get(finding.signal) === true) {
      continue;
    }
    state.silenceEscalated.set(finding.signal, true);
    emit({
      at: now,
      signature: 'signal-silence',
      tier: 3,
      phase: 'detected',
      subject: finding.signal,
      detail: { silentForMs: finding.silentForMs },
    });
    const escalation: AuditRecord = {
      at: now,
      signature: 'signal-silence',
      tier: 3,
      phase: 'escalated',
      subject: finding.signal,
      detail: {
        silentForMs: finding.silentForMs,
        advisory:
          'A signal the host declared as periodic has gone quiet. The process that should ' +
          'emit it is down, paused, or wedged; nothing downstream will say so on its own.',
      },
    };
    emit(escalation);
    notifyPager(pass, escalation);
  }
}

const VELOCITY_ADVISORY =
  'A velocity-rejection spike is first a fraud signal: a cohort probing the ' +
  'limits (card testing, credit farming) trips the per-user gates long before ' +
  'a legitimate surge does. Inspect the rejected subjects and operation kinds ' +
  'before touching any limit; a limit change is a config rebuild, never a live ' +
  'mutation. Runbook: https://economy-lab-docs.pages.dev/economy/ops/runbooks/velocity-anomaly/.';

function runVelocityPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  if (now - state.anomalyReportedAt < config.anomalyWindowMs) {
    return;
  }
  const anomaly = detectVelocityAnomaly(deps.signals, now, {
    windowMs: config.anomalyWindowMs,
    threshold: config.anomalyThreshold,
  });
  if (anomaly === null) {
    return;
  }
  emit({
    at: now,
    signature: 'velocity-anomaly',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: {
      rejections: anomaly.rejections,
      byKind: anomaly.byKind,
      ratePerMin: anomaly.ratePerMin,
      windowMs: anomaly.windowMs,
    },
  });
  // Past the escalation threshold this is no longer a tuning question — someone gets paged.
  if (anomaly.rejections >= config.anomalyEscalationThreshold) {
    const escalation: AuditRecord = {
      at: now,
      signature: 'velocity-anomaly',
      tier: 3,
      phase: 'escalated',
      subject: null,
      detail: {
        rejections: anomaly.rejections,
        byKind: anomaly.byKind,
        ratePerMin: anomaly.ratePerMin,
        advisory: VELOCITY_ADVISORY,
      },
    };
    emit(escalation);
    notifyPager(pass, escalation);
  } else {
    emit({
      at: now,
      signature: 'velocity-anomaly',
      tier: 3,
      phase: 'decided',
      subject: null,
      detail: { decision: 'advise', advisory: VELOCITY_ADVISORY },
    });
  }
  state.anomalyReportedAt = now;
}

const EXHAUSTION_ADVISORY =
  'Retry budgets are running out: these submits failed to their callers after ' +
  'every retry, so users are seeing errors, not just latency. Sustained ' +
  'exhaustion means the conflict rate is beyond what the budget absorbs — ' +
  'check the deadlock counters and the pool before raising any budget. ' +
  'Runbook: https://economy-lab-docs.pages.dev/economy/ops/runbooks/retry-exhaustion/.';

function runRetryExhaustionPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  if (now - state.exhaustionReportedAt < config.retryExhaustionWindowMs) {
    return;
  }
  const finding = detectRetryExhaustion(deps.signals, now, {
    windowMs: config.retryExhaustionWindowMs,
    threshold: config.retryExhaustionThreshold,
  });
  if (finding === null) {
    return;
  }
  state.exhaustionReportedAt = now;
  emit({
    at: now,
    signature: 'retry-exhaustion',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: {
      exhausted: finding.exhausted,
      byEngine: finding.byEngine,
      windowMs: finding.windowMs,
    },
  });
  const escalation: AuditRecord = {
    at: now,
    signature: 'retry-exhaustion',
    tier: 3,
    phase: 'escalated',
    subject: null,
    detail: {
      exhausted: finding.exhausted,
      byEngine: finding.byEngine,
      advisory: EXHAUSTION_ADVISORY,
    },
  };
  emit(escalation);
  notifyPager(pass, escalation);
}

const REPLAY_STORM_ADVISORY =
  'The same provider events keep arriving: a redelivery storm is a provider ' +
  'misconfiguration (acks not registering) or a replay attack. The gates held ' +
  '— every duplicate was dropped and no money moved twice — but the edge is ' +
  'burning work. Check the layer tag: "stale"/"replay" storms stop at the ' +
  'edge, an "inbox" storm means redeliveries are getting past it. Runbook: ' +
  'https://economy-lab-docs.pages.dev/economy/ops/runbooks/webhook-replay-storm/.';

function runReplayStormPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  if (now - state.replayStormReportedAt < config.webhookReplayWindowMs) {
    return;
  }
  const finding = detectWebhookReplayStorm(deps.signals, now, {
    windowMs: config.webhookReplayWindowMs,
    threshold: config.webhookReplayThreshold,
  });
  if (finding === null) {
    return;
  }
  state.replayStormReportedAt = now;
  emit({
    at: now,
    signature: 'webhook-replay-storm',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: {
      duplicates: finding.duplicates,
      byProvider: finding.byProvider,
      byLayer: finding.byLayer,
      windowMs: finding.windowMs,
    },
  });
  emit({
    at: now,
    signature: 'webhook-replay-storm',
    tier: 3,
    phase: 'decided',
    subject: null,
    detail: { decision: 'advise', advisory: REPLAY_STORM_ADVISORY },
  });
}

const SEAL_SLOW_ADVISORY =
  'Checkpoint sealing is slowing down. The seal re-derives every chain head, ' +
  'so its duration tracks table growth: a rising trend is the ledger outgrowing ' +
  'the sweep, brewing toward timeouts. Plan capacity now, while it is a trend ' +
  'and not an outage. Runbook: https://economy-lab-docs.pages.dev/economy/ops/runbooks/checkpoint-seal-slow/.';

function runSealLatencyPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  if (now - state.sealSlowReportedAt < config.sealLatencyWindowMs) {
    return;
  }
  const finding = detectSlowSeal(deps.signals, now, {
    thresholdMs: config.sealLatencyMs,
    windowMs: config.sealLatencyWindowMs,
  });
  if (finding === null) {
    return;
  }
  state.sealSlowReportedAt = now;
  emit({
    at: now,
    signature: 'checkpoint-seal-slow',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: {
      maxMs: finding.maxMs,
      samples: finding.samples,
      windowMs: finding.windowMs,
    },
  });
  emit({
    at: now,
    signature: 'checkpoint-seal-slow',
    tier: 3,
    phase: 'decided',
    subject: null,
    detail: { decision: 'advise', advisory: SEAL_SLOW_ADVISORY },
  });
}

const DEADLOCK_ADVISORY =
  'Known signature: InnoDB gap locks on the idempotency claim under concurrent ' +
  'submits. Confirm against the engine deadlock counters ' +
  '(performance_schema on MySQL, pg_stat_database on Postgres), then reduce ' +
  'submit concurrency or shard the hot platform accounts; the retry budget ' +
  'absorbs the storm in the meantime.';

function runStormPass(pass: Pass): void {
  const { deps, config, state, now, emit } = pass;
  if (now - state.stormReportedAt < config.deadlockWindowMs) {
    return;
  }
  const storm = detectDeadlockStorm(deps.signals, now, {
    metric: config.deadlockMetric,
    windowMs: config.deadlockWindowMs,
    threshold: config.deadlockThreshold,
  });
  if (storm === null) {
    return;
  }
  emit({
    at: now,
    signature: 'deadlock-storm',
    tier: 3,
    phase: 'detected',
    subject: null,
    detail: { retries: storm.retries, windowMs: storm.windowMs },
  });
  emit({
    at: now,
    signature: 'deadlock-storm',
    tier: 3,
    phase: 'decided',
    subject: null,
    detail: { decision: 'advise', advisory: DEADLOCK_ADVISORY },
  });
  state.stormReportedAt = now;
}

async function runStuckSagaPass(pass: Pass): Promise<void> {
  const { deps, config, state, now, emit } = pass;
  const findings = await detectStuckSagas(deps.sagas, now, {
    ageMs: config.stuckSagaAgeMs,
  });
  const actionable: StuckSagaFinding[] = [];
  for (const finding of findings) {
    const id = finding.saga.id;
    emit(
      stuckRecord(now, 'detected', id, {
        state: finding.saga.state,
        ageMs: finding.ageMs,
      }),
    );
    const action = state.perSaga.get(id) ?? idleAction();
    state.perSaga.set(id, action);
    if (state.containment) {
      emit(
        stuckRecord(now, 'decided', id, {
          decision: 'suppressed',
          reason: 'containment',
        }),
      );
    } else if (action.escalated) {
      emit(
        stuckRecord(now, 'decided', id, {
          decision: 'suppressed',
          reason: 'escalated',
        }),
      );
    } else if (action.attempts >= config.maxActionAttempts) {
      action.escalated = true;
      const escalation = stuckRecord(now, 'escalated', id, {
        attempts: action.attempts,
        state: finding.saga.state,
      });
      emit(escalation);
      notifyPager(pass, escalation);
    } else if (now - action.lastActedAt < config.actionCooldownMs) {
      emit(
        stuckRecord(now, 'decided', id, {
          decision: 'suppressed',
          reason: 'cooldown',
        }),
      );
    } else {
      emit(
        stuckRecord(now, 'decided', id, { decision: 'act', action: 'sweep' }),
      );
      actionable.push(finding);
    }
  }
  if (actionable.length > 0) {
    await actOnStuckSagas(pass, actionable);
  }
}

// One sweep serves every actionable saga: the worker advances all time-due work in a
// single pass, and the lab intentionally offers no per-saga targeting.
async function actOnStuckSagas(
  pass: Pass,
  actionable: ReadonlyArray<StuckSagaFinding>,
): Promise<void> {
  const { deps, state, now, emit } = pass;
  const ids = actionable.map((finding) => finding.saga.id);
  let failure: string | null = null;
  try {
    await deps.runSweep(now);
  } catch (error) {
    failure = String(error);
  }
  emit({
    at: now,
    signature: 'stuck-saga',
    tier: 1,
    phase: 'acted',
    subject: null,
    detail:
      failure === null
        ? { action: 'sweep', sagas: ids }
        : { action: 'sweep', sagas: ids, failure },
  });
  for (const finding of actionable) {
    const action = state.perSaga.get(finding.saga.id);
    if (action === undefined) {
      continue;
    }
    action.attempts += 1;
    action.lastActedAt = now;
    const after = await deps.sagas.load(finding.saga.id);
    const progressed =
      after !== null &&
      (after.state !== finding.saga.state ||
        after.updatedAt !== finding.saga.updatedAt);
    emit(
      stuckRecord(now, 'verified', finding.saga.id, {
        outcome: progressed ? 'progressed' : 'unchanged',
        from: finding.saga.state,
        to: after?.state ?? null,
        attempts: action.attempts,
      }),
    );
  }
}

function stuckRecord(
  at: number,
  phase: AuditPhase,
  subject: string,
  detail: Record<string, unknown>,
): AuditRecord {
  return { at, signature: 'stuck-saga', tier: 1, phase, subject, detail };
}

// The gauge pair the detector reads is emitted at the START of each relay run, so a re-drive's
// own emission still shows the pre-action backlog. Verification therefore spans ticks: the
// outcome is read from the first gauge sample newer than the action.
async function runOutboxBacklogPass(pass: Pass): Promise<void> {
  const { deps, config, state, now, emit } = pass;
  verifyOutboxRedrive(pass);
  const finding = detectOutboxBacklog(deps.signals, {
    ageMs: config.outboxBacklogAgeMs,
  });
  if (finding === null) {
    return;
  }
  emit(
    backlogRecord(now, 'detected', {
      ageMs: finding.ageMs,
      pending: finding.pending,
    }),
  );
  const action = state.outboxAction;
  const suppressed = decideSuppression(pass, action);
  if (suppressed !== null) {
    if (suppressed === 'escalate') {
      escalateBacklog(pass, finding, action);
    } else {
      emit(
        backlogRecord(now, 'decided', {
          decision: 'suppressed',
          reason: suppressed,
        }),
      );
    }
    return;
  }
  const lever = deps.runRelay ?? deps.runSweep;
  const actionName = deps.runRelay === undefined ? 'sweep' : 'redriveRelay';
  emit(backlogRecord(now, 'decided', { decision: 'act', action: actionName }));
  let failure: string | null = null;
  try {
    await lever(now);
  } catch (error) {
    failure = String(error);
  }
  emit(
    backlogRecord(
      now,
      'acted',
      failure === null
        ? { action: actionName }
        : { action: actionName, failure },
    ),
  );
  action.attempts += 1;
  action.lastActedAt = now;
  state.outboxVerify = { actedAt: now, ageAtAction: finding.ageMs };
}

function verifyOutboxRedrive(pass: Pass): void {
  const { deps, state, now, emit } = pass;
  if (state.outboxVerify === null) {
    return;
  }
  const fresh = deps.signals
    .since(state.outboxVerify.actedAt + 1)
    .filter(
      (signal) =>
        signal.source === 'meter' &&
        signal.name === 'worker.relay.backlog_age_ms',
    )
    .at(-1);
  if (fresh === undefined) {
    return;
  }
  emit(
    backlogRecord(now, 'verified', {
      outcome:
        fresh.value < state.outboxVerify.ageAtAction ? 'drained' : 'unchanged',
      ageMs: fresh.value,
      ageAtAction: state.outboxVerify.ageAtAction,
    }),
  );
  state.outboxVerify = null;
}

// The shared guardrail readout for the per-signature (not per-subject) tier-1 passes.
// Containment and prior escalation silence the pass. The attempt cap converts it into a
// permanent escalation. The cooldown spaces the actions out.
function decideSuppression(
  pass: Pass,
  action: SagaActionState,
): 'containment' | 'escalated' | 'escalate' | 'cooldown' | null {
  const { config, state, now } = pass;
  if (state.containment) {
    return 'containment';
  }
  if (action.escalated) {
    return 'escalated';
  }
  if (action.attempts >= config.maxActionAttempts) {
    return 'escalate';
  }
  if (now - action.lastActedAt < config.actionCooldownMs) {
    return 'cooldown';
  }
  return null;
}

function escalateBacklog(
  pass: Pass,
  finding: { ageMs: number; pending: number },
  action: SagaActionState,
): void {
  const { now, emit } = pass;
  action.escalated = true;
  const escalation = backlogRecord(now, 'escalated', {
    attempts: action.attempts,
    ageMs: finding.ageMs,
    pending: finding.pending,
    advisory:
      'Re-drives are not draining the outbox: the dispatcher is down or the ' +
      'pending events are poisoned. Runbook: https://economy-lab-docs.pages.dev/economy/ops/runbooks/outbox-backlog/.',
  });
  emit(escalation);
  notifyPager(pass, escalation);
}

function backlogRecord(
  at: number,
  phase: AuditPhase,
  detail: Record<string, unknown>,
): AuditRecord {
  return {
    at,
    signature: 'outbox-backlog',
    tier: 1,
    phase,
    subject: null,
    detail,
  };
}

// Revive episodes are capped like saga sweeps: a poison row that dead-letters again opens a new
// episode, and at the attempt cap the pass escalates permanently instead of ping-ponging the
// row forever. The watermark advances on every decision, so one episode audits once.
// reviveDead itself picks the oldest dead rows, signaled or not.
async function runInboxDeadLetterPass(pass: Pass): Promise<void> {
  const { deps, config, state, now, emit } = pass;
  const finding = detectInboxDeadLetters(deps.signals, state.inboxHandledUpTo, {
    threshold: config.inboxDeadLetterThreshold,
  });
  if (finding === null) {
    return;
  }
  state.inboxHandledUpTo = finding.newestAt;
  emit(inboxRecord(now, 'detected', { deadLettered: finding.deadLettered }));
  const action = state.inboxAction;
  const suppressed =
    deps.reviveInbox === undefined
      ? 'no-lever'
      : decideSuppression(pass, action);
  if (suppressed !== null) {
    if (suppressed === 'escalate') {
      escalateInbox(pass, finding.deadLettered, action);
    } else {
      emit(
        inboxRecord(now, 'decided', {
          decision: 'suppressed',
          reason: suppressed,
        }),
      );
    }
    return;
  }
  emit(
    inboxRecord(now, 'decided', {
      decision: 'act',
      action: 'reviveInbox',
      limit: config.inboxReviveLimit,
    }),
  );
  let revived: ReadonlyArray<{ id: string }> = [];
  let failure: string | null = null;
  try {
    revived = await deps.reviveInbox!(config.inboxReviveLimit);
  } catch (error) {
    failure = String(error);
  }
  const ids = revived.map((row) => row.id);
  emit(
    inboxRecord(
      now,
      'acted',
      failure === null
        ? { action: 'reviveInbox', revived: ids }
        : { action: 'reviveInbox', revived: ids, failure },
    ),
  );
  action.attempts += 1;
  action.lastActedAt = now;
  emit(
    inboxRecord(now, 'verified', {
      outcome: ids.length > 0 ? 'revived' : 'empty',
      revived: ids.length,
    }),
  );
}

function escalateInbox(
  pass: Pass,
  deadLettered: number,
  action: SagaActionState,
): void {
  const { now, emit } = pass;
  action.escalated = true;
  const escalation = inboxRecord(now, 'escalated', {
    attempts: action.attempts,
    deadLettered,
    advisory:
      'Revived inbox rows keep dead-lettering: the events are poisoned, not ' +
      'delayed. Inspect the rows before any further replay. Runbook: ' +
      'https://economy-lab-docs.pages.dev/economy/ops/runbooks/inbox-dead-letter/.',
  });
  emit(escalation);
  notifyPager(pass, escalation);
}

function inboxRecord(
  at: number,
  phase: AuditPhase,
  detail: Record<string, unknown>,
): AuditRecord {
  return {
    at,
    signature: 'inbox-dead-letter',
    tier: 1,
    phase,
    subject: null,
    detail,
  };
}
