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
import type { SignalFeed } from '#src/ops/runtime.ts';

export type SagaSource = {
  list(): AsyncIterable<Saga>;
  load(id: string): Promise<Saga | null>;
};

export type SupervisorConfig = {
  stuckSagaAgeMs: number;
  actionCooldownMs: number;
  maxActionAttempts: number;
  deadlockMetric: string;
  deadlockWindowMs: number;
  deadlockThreshold: number;
  stallGraceMs: number;
  anomalyWindowMs: number;
  anomalyThreshold: number;
  /** At or above this many rejections in the window, the velocity pass escalates instead of advising. */
  anomalyEscalationThreshold: number;
  retryExhaustionWindowMs: number;
  retryExhaustionThreshold: number;
  outboxBacklogAgeMs: number;
  webhookReplayWindowMs: number;
  webhookReplayThreshold: number;
  sealLatencyMs: number;
  sealLatencyWindowMs: number;
  inboxDeadLetterThreshold: number;
  /** Most dead inbox rows one revive episode flips back to pending. */
  inboxReviveLimit: number;
  watchdogs: ReadonlyArray<{ signal: string; everyMs: number }>;
};

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

export type SupervisorDeps = {
  clock: Clock;
  signals: SignalFeed;
  sagas: SagaSource;
  runSweep: (now: number) => Promise<unknown>;
  audit: AuditSink;
  prove?: () => Promise<unknown>;
  escalate?: (record: AuditRecord) => void;
  /**
   * Pauses the host worker's scheduled loop — the integrity pass's containment lever.
   * Deliberately a one-way switch: the supervisor never resumes; a human does, after the
   * evidence is reviewed.
   */
  pauseWorker?: () => void;
  /**
   * A targeted relay run for the outbox-backlog remediation, typically
   * `worker.runOnce({ ...input, only: ['relay'] })`. Falls back to `runSweep` when absent.
   */
  runRelay?: (now: number) => Promise<unknown>;
  /** Flips up to `limit` dead inbox rows back to pending, typically `store.inbox.reviveDead`. */
  reviveInbox?: (limit: number) => Promise<ReadonlyArray<{ id: string }>>;
  config?: Partial<SupervisorConfig>;
};

export type Supervisor = {
  tick(): Promise<ReadonlyArray<AuditRecord>>;
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
  // While set, no tier-1 pass calls its lever — `runOnce` deliberately ignores `paused()`, so
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
  deps: SupervisorDeps;
  config: SupervisorConfig;
  state: SupervisorState;
  now: number;
  emit: (record: AuditRecord) => void;
};

export function createSupervisor(
  deps: SupervisorDeps,
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

async function runProver(deps: SupervisorDeps): Promise<unknown> {
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
        stuckRecord(now, 'decided', id, { decision: 'act', action: 'runOnce' }),
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
        ? { action: 'runOnce', sagas: ids }
        : { action: 'runOnce', sagas: ids, failure },
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
  const actionName = deps.runRelay === undefined ? 'runOnce' : 'redriveRelay';
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
