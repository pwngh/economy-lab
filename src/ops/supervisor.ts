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
} from '#src/ops/detect.ts';

import type { Clock, Saga, Scheduler } from '#src/ports.ts';
import type { AuditPhase, AuditRecord, AuditSink } from '#src/ops/audit.ts';
import type { StuckSagaFinding } from '#src/ops/detect.ts';
import type { OpsRuntime, SignalFeed } from '#src/ops/runtime.ts';

/**
 * The saga store slice the supervisor polls: `list` streams every saga for the stuck-saga
 * detector's full walk, and `load` re-reads one saga after a sweep — the verify step that
 * decides whether the action progressed it. A store's `sagas` handle satisfies this directly.
 */
export type SagaSource = {
  list(): AsyncIterable<Saga>;
  load(id: string): Promise<Saga | null>;
};

/**
 * The tuning surface: per-signature thresholds and windows plus the shared guardrail knobs
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
  /** Signals the host declares as periodic; the silence pass escalates past twice each cadence. */
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

/**
 * What the host injects into {@link createSupervisor}. The required ports cover observation
 * (clock, signals, sagas), the one mandatory lever (`runSweep`), and the audit sink; the
 * optional ones add levers and hooks the matching passes use when present and quietly skip
 * when absent.
 */
export type SupervisorPorts = {
  clock: Clock;
  /** The detector's input, normally an {@link OpsRuntime}'s `signals`. */
  signals: SignalFeed;
  /** The saga store slice the stuck-saga pass polls and re-reads. */
  sagas: SagaSource;
  /**
   * The stuck-saga lever: one guarded worker sweep, typically
   * `(now) => worker.sweep({ now, limit })`. One sweep serves every actionable saga; the pass
   * verifies by re-loading each saga afterward. Also the outbox fallback when `runRelay` is
   * absent.
   */
  runSweep: (now: number) => Promise<unknown>;
  /**
   * Receives every audit record synchronously as the tick emits it, before the record is also
   * returned from `tick()`. A throwing sink aborts the tick.
   */
  audit: AuditSink;
  /**
   * Runs the integrity prover once when a mismatch episode is detected; its resolved value (or
   * `{ proverFailed }` when it throws) rides the escalation record as evidence. Absent, the
   * escalation carries a null proof.
   */
  prove?: () => Promise<unknown>;
  /**
   * Called once per escalation with the same record already sent to `audit` — the pager hook.
   * Absent, escalations still reach the audit trail.
   */
  escalate?: (record: AuditRecord) => void;
  /**
   * Pauses the host worker's scheduled loop — the integrity pass's containment lever.
   * Deliberately a one-way switch: the supervisor never resumes; a human does, after the
   * evidence is reviewed.
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
   * Runs every detection pass once against the current clock and returns the audit records the
   * tick emitted (each already delivered to the audit sink), empty when nothing fired. A tick
   * that arrives while one is still running returns an empty array without running — overlap
   * is skipped, not queued.
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
  // The containment latch: set by any integrity episode, cleared only by a supervisor restart.
  // While set, no tier-1 pass calls its lever — `sweep` deliberately ignores `paused()`, so
  // without this the supervisor's own remediations would keep writing through a paused worker.
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
 * A supervisor over an already-built ops runtime: the runtime's signal feed slots in and the
 * host supplies the rest of the ports.
 */
export function createSupervisorFrom(
  runtime: OpsRuntime,
  ports: Omit<SupervisorPorts, 'signals'>,
  scheduler?: Scheduler,
): Supervisor {
  return createSupervisor({ ...ports, signals: runtime.signals }, scheduler);
}

/**
 * Builds the supervisor from its injected ports. Each tick runs the twelve incident passes
 * once: tier-3 signatures report or escalate with an advisory and touch nothing, while the
 * three tier-1 signatures (stuck-saga, outbox-backlog, inbox-dead-letter) call their lever
 * under the shared guardrails — the cooldown spaces actions out, the attempt cap converts
 * further action into a permanent escalation, and any integrity episode sets a containment
 * latch that silences every lever until the supervisor is restarted. The integrity pass itself
 * never fixes: it proves once, escalates, pauses the worker, and latches. All dedupe state is
 * in-memory; a restart starts clean.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ops/the-supervisor/ The supervisor}
 * for the tier model and the per-signature runbooks.
 *
 * @example
 * const ops = createOpsRuntime({ meter, logger, clock });
 * // compose the economy and worker over ops.meter / ops.logger, then:
 * const supervisor = createSupervisor({
 *   clock,
 *   signals: ops.signals,
 *   sagas: ports.store.sagas,
 *   runSweep: (now) => worker.sweep({ now, limit: 10 }),
 *   audit: jsonlAuditSink((line) => trail.write(`${line}\n`)),
 * });
 * const records = await supervisor.tick();
 */
export function createSupervisor(
  deps: SupervisorPorts,
  scheduler?: Scheduler,
): Supervisor {
  const config = { ...defaultSupervisorConfig, ...deps.config };
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
      // Before the saga poll: a stalled engine can hang that poll, and the escalations must
      // reach the audit sink regardless.
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
    detail: { proof },
  };
  emit(escalation);
  deps.escalate?.(escalation);
  // Containment, not remediation: the ledger is never touched. The latch stops every tier-1
  // lever, and the pause stops the scheduled loop; both hold until a human reviews the evidence
  // (resume + supervisor restart).
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

async function runProver(deps: SupervisorPorts): Promise<unknown> {
  if (deps.prove === undefined) {
    return null;
  }
  try {
    return await deps.prove();
  } catch (error) {
    return { proverFailed: String(error) };
  }
}

const STALL_ADVISORY =
  'Connection acquires started and none completed: the pool is starved or the ' +
  'database is unresponsive. Submits are queued, not failing, so no error ' +
  'surfaces on its own. Check database liveness, then pool sizing (DB_POOL_MAX).';

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
  deps.escalate?.(escalation);
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
  deps.escalate?.(escalation);
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
    deps.escalate?.(escalation);
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
    deps.escalate?.(escalation);
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
  deps.escalate?.(escalation);
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
      deps.escalate?.(escalation);
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
// single pass, and per-saga targeting deliberately does not exist in the lab.
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

// The shared guardrail readout for the per-signature (not per-subject) tier-1 passes:
// containment and prior escalation silence the pass; the attempt cap converts it into a
// permanent escalation; the cooldown spaces the actions out.
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
  const { deps, now, emit } = pass;
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
  deps.escalate?.(escalation);
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
// row forever. The watermark advances on every decision, so one episode audits once; reviveDead
// itself picks the oldest dead rows, signaled or not.
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
  const { deps, now, emit } = pass;
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
  deps.escalate?.(escalation);
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
