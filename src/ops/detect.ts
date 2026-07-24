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

import type { Saga } from '#src/ports.ts';
import type { Signal, SignalFeed } from '#src/ops/runtime.ts';

/** What {@link detectDeadlockStorm} found: summed retry volume over the window. */
export type DeadlockStormFinding = {
  signature: 'deadlock-storm';
  /** Retry count summed over the window — conflict pressure, not caller-visible failures. */
  retries: number;
  windowMs: number;
};

/** One stuck saga from {@link detectStuckSagas}; the poll emits one finding per saga. */
export type StuckSagaFinding = {
  signature: 'stuck-saga';
  /** The saga row as of the poll; the supervisor re-loads it after acting to verify progress. */
  saga: Saga;
  /** Milliseconds since the saga's `updatedAt`. */
  ageMs: number;
};

/** One mismatch signal from {@link detectIntegrityMismatches}. */
export type IntegrityMismatchFinding = {
  signature: 'integrity-mismatch';
  /** The signal's capture time — the watermark the caller advances past this episode. */
  at: number;
  /** Which side carried the evidence: the verify metric or the mismatch log event. */
  channel: 'meter' | 'log';
};

/** What {@link detectEngineStall} found: acquires started with no completion since. */
export type EngineStallFinding = {
  signature: 'engine-stall';
  /** Acquires recorded after the last completed acquire. */
  pending: number;
  /** How long the oldest of them has been waiting. */
  oldestWaitMs: number;
};

/** What {@link detectTreasuryBreaches} found past the caller's watermark. */
export type TreasuryBreachFinding = {
  signature: 'treasury-breach';
  breaches: number;
  /** The distinct breach metric names seen: backing, float, or both. */
  channels: ReadonlyArray<string>;
  /** The newest breach signal's capture time — the caller's next watermark. */
  newestAt: number;
};

/** What {@link detectVelocityAnomaly} found: RISK_DENIED rejection volume over the window. */
export type VelocityAnomalyFinding = {
  signature: 'velocity-anomaly';
  rejections: number;
  /** Rejections tallied per operation kind tag; untagged signals tally under `unknown`. */
  byKind: Readonly<Record<string, number>>;
  /** The window's rejection count normalized to a per-minute rate, rounded. */
  ratePerMin: number;
  windowMs: number;
};

/** One quiet watchdog from {@link detectSilences}. */
export type SilenceFinding = {
  signature: 'signal-silence';
  /** The declared signal name that went quiet. */
  signal: string;
  /** Time since the later of the last beat and when watching began. */
  silentForMs: number;
};

/** What {@link detectRetryExhaustion} found: exhausted retry budgets over the window. */
export type RetryExhaustionFinding = {
  signature: 'retry-exhaustion';
  /** Submits that failed to their callers after every retry. */
  exhausted: number;
  /** Exhaustions tallied per engine tag; untagged signals tally under `unknown`. */
  byEngine: Readonly<Record<string, number>>;
  windowMs: number;
};

/** What {@link detectOutboxBacklog} found in the newest relay gauge pair. */
export type OutboxBacklogFinding = {
  signature: 'outbox-backlog';
  /** The newest backlog-age gauge reading. */
  ageMs: number;
  /** The newest backlog-depth gauge reading, or 0 when no depth sample is buffered. */
  pending: number;
};

/** What {@link detectWebhookReplayStorm} found: dropped duplicate volume over the window. */
export type WebhookReplayStormFinding = {
  signature: 'webhook-replay-storm';
  duplicates: number;
  /** Duplicates tallied per provider tag; untagged signals tally under `unknown`. */
  byProvider: Readonly<Record<string, number>>;
  /** Duplicates tallied per catching layer: an edge layer held, an inbox layer means leakage. */
  byLayer: Readonly<Record<string, number>>;
  windowMs: number;
};

/** What {@link detectSlowSeal} found: the slowest completed seal in the window. */
export type SlowSealFinding = {
  signature: 'checkpoint-seal-slow';
  /** The slowest completed seal's duration. */
  maxMs: number;
  /** Completed seals observed in the window. */
  samples: number;
  windowMs: number;
};

/** What {@link detectInboxDeadLetters} found past the caller's watermark. */
export type InboxDeadLetterFinding = {
  signature: 'inbox-dead-letter';
  /** Dead-letter log signals counted; row ids are not buffered, so none are carried. */
  deadLettered: number;
  /** The newest dead-letter signal's capture time — the caller's next watermark. */
  newestAt: number;
};

/**
 * The union of every finding type, one per incident signature. Each carries the evidence its
 * runbook starts from; the detectors are stateless, so dedupe and watermarks live with the
 * caller (the supervisor).
 */
export type Finding =
  | DeadlockStormFinding
  | StuckSagaFinding
  | IntegrityMismatchFinding
  | EngineStallFinding
  | TreasuryBreachFinding
  | VelocityAnomalyFinding
  | SilenceFinding
  | RetryExhaustionFinding
  | OutboxBacklogFinding
  | WebhookReplayStormFinding
  | SlowSealFinding
  | InboxDeadLetterFinding;

const TERMINAL_SAGA_STATES: ReadonlySet<Saga['state']> = new Set([
  'SETTLED',
  'FAILED',
]);

/**
 * Sums the named retry metric's values over the trailing window and fires at or above the
 * threshold, or returns null. Retries measure conflict pressure the retry budget is absorbing,
 * not failures: callers still succeed while a storm is running, which is why nothing else
 * surfaces it.
 */
export function detectDeadlockStorm(
  signals: SignalFeed,
  now: number,
  options: { metric: string; windowMs: number; threshold: number },
): DeadlockStormFinding | null {
  const retries = signals
    .since(now - options.windowMs)
    .filter(
      (signal) => signal.source === 'meter' && signal.name === options.metric,
    )
    .reduce((sum, signal) => sum + signal.value, 0);
  if (retries < options.threshold) {
    return null;
  }
  return { signature: 'deadlock-storm', retries, windowMs: options.windowMs };
}

/**
 * Walks the saga listing and returns one finding per saga that is non-terminal (any state
 * other than SETTLED or FAILED) and has not been updated for at least `ageMs`. Returns an
 * empty array when nothing qualifies. Stateless: the same stuck saga is found again on every
 * poll until it progresses.
 */
// SagaStore.list streams newest-updated first, so the stale sagas this detector wants
// arrive last: every poll walks the full set. Acceptable at demo scale; revisit with a
// state-filtered listing if a real host ever carries a deep saga history.
export async function detectStuckSagas(
  sagas: { list(): AsyncIterable<Saga> },
  now: number,
  options: { ageMs: number },
): Promise<ReadonlyArray<StuckSagaFinding>> {
  const found: StuckSagaFinding[] = [];
  for await (const saga of sagas.list()) {
    if (TERMINAL_SAGA_STATES.has(saga.state)) {
      continue;
    }
    const ageMs = now - saga.updatedAt;
    if (ageMs >= options.ageMs) {
      found.push({ signature: 'stuck-saga', saga, ageMs });
    }
  }
  return found;
}

const ACQUIRE_METRIC = 'engine.pool.acquire';
const ACQUIRE_DONE_METRIC = 'engine.pool.acquire_ms';

/**
 * Counts pool acquires recorded after the last completed acquire; fires when the oldest of
 * them has waited past the grace period, else returns null. The rule scans the whole buffer,
 * not a sliding window: a stalled pool emits nothing else, so a window would age the stall's
 * own evidence out. Clears itself — once an acquire completes, the pending set restarts.
 */
export function detectEngineStall(
  signals: SignalFeed,
  now: number,
  options: { graceMs: number },
): EngineStallFinding | null {
  const all = signals.since(Number.MIN_SAFE_INTEGER);
  const lastCompletion = all
    .filter(
      (signal) =>
        signal.source === 'meter' && signal.name === ACQUIRE_DONE_METRIC,
    )
    .reduce((max, signal) => Math.max(max, signal.at), Number.MIN_SAFE_INTEGER);
  const pending = all.filter(
    (signal) =>
      signal.source === 'meter' &&
      signal.name === ACQUIRE_METRIC &&
      signal.at > lastCompletion,
  );
  if (pending.length === 0) {
    return null;
  }
  const oldestWaitMs = now - pending[0].at;
  if (oldestWaitMs < options.graceMs) {
    return null;
  }
  return { signature: 'engine-stall', pending: pending.length, oldestWaitMs };
}

const MISMATCH_METRIC = 'worker.checkpoint.verify';
const MISMATCH_LOG = 'worker.checkpoint.mismatch';

/**
 * Returns one finding per checkpoint-verify mismatch signal strictly newer than
 * `sinceExclusive`, matching both channels: the verify metric with a mismatch outcome and the
 * mismatch log event. No threshold — a single mismatch is an incident. The caller advances its
 * watermark to the newest `at` so an episode is handled once.
 */
export function detectIntegrityMismatches(
  signals: SignalFeed,
  sinceExclusive: number,
): ReadonlyArray<IntegrityMismatchFinding> {
  return signals
    .since(sinceExclusive + 1)
    .filter(isMismatch)
    .map((signal) => ({
      signature: 'integrity-mismatch' as const,
      at: signal.at,
      channel: signal.source,
    }));
}

const BREACH_METRICS: ReadonlySet<string> = new Set([
  'worker.treasury.breach',
  'worker.treasury.float_breach',
]);

/**
 * Counts backing- and float-breach metrics strictly newer than `sinceExclusive`; any hit fires
 * (there is no threshold to tune — a breached backing invariant is always an incident), none
 * returns null. `newestAt` is the caller's next watermark.
 */
export function detectTreasuryBreaches(
  signals: SignalFeed,
  sinceExclusive: number,
): TreasuryBreachFinding | null {
  const hits = signals
    .since(sinceExclusive + 1)
    .filter(
      (signal) => signal.source === 'meter' && BREACH_METRICS.has(signal.name),
    );
  if (hits.length === 0) {
    return null;
  }
  return {
    signature: 'treasury-breach',
    breaches: hits.length,
    channels: [...new Set(hits.map((hit) => hit.name))],
    newestAt: hits.reduce((max, hit) => Math.max(max, hit.at), sinceExclusive),
  };
}

/**
 * Sums submit rejections whose reason is RISK_DENIED over the trailing window and fires at or
 * above the threshold, or returns null. The finding tallies per operation kind and carries a
 * rounded per-minute rate; a spike is read as a fraud signal (a cohort probing the velocity
 * limits) before it is read as a tuning problem.
 */
export function detectVelocityAnomaly(
  signals: SignalFeed,
  now: number,
  options: { windowMs: number; threshold: number },
): VelocityAnomalyFinding | null {
  const hits = signals
    .since(now - options.windowMs)
    .filter(
      (signal) =>
        signal.source === 'meter' &&
        signal.name === 'economy.submit' &&
        signal.tags.status === 'rejected' &&
        signal.tags.reason === 'RISK_DENIED',
    );
  const rejections = hits.reduce((sum, signal) => sum + signal.value, 0);
  if (rejections < options.threshold) {
    return null;
  }
  return {
    signature: 'velocity-anomaly',
    rejections,
    byKind: tallyByTag(hits, 'kind'),
    ratePerMin: Math.round((rejections * 60_000) / options.windowMs),
    windowMs: options.windowMs,
  };
}

/**
 * Checks each declared watchdog — a signal the host says beats on a cadence, such as a worker
 * sweep — and returns one finding per signal silent for more than twice its declared cadence.
 * Silence is measured from the later of the last beat and `watchStartedAt`, so a worker that
 * never started is caught too. Returns an empty array when every watchdog is beating.
 */
export function detectSilences(
  signals: SignalFeed,
  now: number,
  watchdogs: ReadonlyArray<{ signal: string; everyMs: number }>,
  watchStartedAt: number,
): ReadonlyArray<SilenceFinding> {
  const all = signals.since(Number.MIN_SAFE_INTEGER);
  return watchdogs.flatMap((watchdog) => {
    const lastSeen = all
      .filter((signal) => signal.name === watchdog.signal)
      .reduce((max, signal) => Math.max(max, signal.at), watchStartedAt);
    const silentForMs = now - lastSeen;
    if (silentForMs <= watchdog.everyMs * 2) {
      return [];
    }
    return [
      {
        signature: 'signal-silence' as const,
        signal: watchdog.signal,
        silentForMs,
      },
    ];
  });
}

/**
 * Sums exhausted retry-budget signals over the trailing window and fires at or above the
 * threshold, or returns null. Unlike a deadlock storm these are caller-visible failures: every
 * exhaustion is a submit that errored back to its caller after the whole budget was spent. The
 * finding tallies per engine.
 */
export function detectRetryExhaustion(
  signals: SignalFeed,
  now: number,
  options: { windowMs: number; threshold: number },
): RetryExhaustionFinding | null {
  const hits = signals
    .since(now - options.windowMs)
    .filter(
      (signal) =>
        signal.source === 'meter' &&
        signal.name === 'engine.retry' &&
        signal.tags.outcome === 'exhausted',
    );
  const exhausted = hits.reduce((sum, signal) => sum + signal.value, 0);
  if (exhausted < options.threshold) {
    return null;
  }
  return {
    signature: 'retry-exhaustion',
    exhausted,
    byEngine: tallyByTag(hits, 'engine'),
    windowMs: options.windowMs,
  };
}

const BACKLOG_AGE_METRIC = 'worker.relay.backlog_age_ms';
const BACKLOG_DEPTH_METRIC = 'worker.relay.backlog';

/**
 * Reads the newest relay backlog-age gauge sample and fires when it is at or past `ageMs`, or
 * returns null when no sample is buffered or the newest is under the bound. Only the newest
 * sample matters — the gauge pair rides each relay run, so an old high reading followed by a
 * fresh low one means the backlog drained. `pending` comes from the newest depth gauge.
 */
export function detectOutboxBacklog(
  signals: SignalFeed,
  options: { ageMs: number },
): OutboxBacklogFinding | null {
  const all = signals.since(Number.MIN_SAFE_INTEGER);
  const newestAge = newestMeter(all, BACKLOG_AGE_METRIC);
  if (newestAge === null || newestAge.value < options.ageMs) {
    return null;
  }
  const newestDepth = newestMeter(all, BACKLOG_DEPTH_METRIC);
  return {
    signature: 'outbox-backlog',
    ageMs: newestAge.value,
    pending: newestDepth?.value ?? 0,
  };
}

/**
 * Sums webhook duplicate counts over the trailing window and fires at or above the threshold,
 * or returns null. Every counted duplicate was already dropped — no money moved twice — so the
 * finding measures wasted edge work and provider misbehavior, tallied per provider and per
 * catching layer.
 */
export function detectWebhookReplayStorm(
  signals: SignalFeed,
  now: number,
  options: { windowMs: number; threshold: number },
): WebhookReplayStormFinding | null {
  const hits = signals
    .since(now - options.windowMs)
    .filter(
      (signal) =>
        signal.source === 'meter' &&
        signal.name === 'economy.webhook.duplicate',
    );
  const duplicates = hits.reduce((sum, signal) => sum + signal.value, 0);
  if (duplicates < options.threshold) {
    return null;
  }
  return {
    signature: 'webhook-replay-storm',
    duplicates,
    byProvider: tallyByTag(hits, 'provider'),
    byLayer: tallyByTag(hits, 'layer'),
    windowMs: options.windowMs,
  };
}

/**
 * Takes the slowest completed checkpoint seal in the trailing window and fires when it is at
 * or past the threshold, or returns null when no seal completed or all were under it. Only
 * sealed outcomes count — a skip or retry says nothing about how the re-derivation is scaling
 * with table growth, which is what this trend watches.
 */
export function detectSlowSeal(
  signals: SignalFeed,
  now: number,
  options: { thresholdMs: number; windowMs: number },
): SlowSealFinding | null {
  const samples = signals
    .since(now - options.windowMs)
    .filter(
      (signal) =>
        signal.source === 'meter' &&
        signal.name === 'worker.checkpoint.seal_ms' &&
        signal.tags.outcome === 'sealed',
    );
  if (samples.length === 0) {
    return null;
  }
  const maxMs = samples.reduce((max, signal) => Math.max(max, signal.value), 0);
  if (maxMs < options.thresholdMs) {
    return null;
  }
  return {
    signature: 'checkpoint-seal-slow',
    maxMs,
    samples: samples.length,
    windowMs: options.windowMs,
  };
}

const INBOX_DEAD_LOG = 'worker.inbox.dead_lettered';

/**
 * Counts dead-letter inbox log signals strictly newer than `sinceExclusive` and fires at or
 * above the threshold, or returns null. Log fields are never buffered, so the dead rows' ids
 * are invisible here; the remediation lever (the store's reviveDead) picks the oldest dead
 * rows without needing them. `newestAt` is the caller's next watermark.
 */
export function detectInboxDeadLetters(
  signals: SignalFeed,
  sinceExclusive: number,
  options: { threshold: number },
): InboxDeadLetterFinding | null {
  const hits = signals
    .since(sinceExclusive + 1)
    .filter(
      (signal) => signal.source === 'log' && signal.name === INBOX_DEAD_LOG,
    );
  if (hits.length < options.threshold) {
    return null;
  }
  return {
    signature: 'inbox-dead-letter',
    deadLettered: hits.length,
    newestAt: hits.reduce((max, hit) => Math.max(max, hit.at), sinceExclusive),
  };
}

function isMismatch(signal: Signal): boolean {
  if (signal.source === 'meter') {
    return (
      signal.name === MISMATCH_METRIC && signal.tags.outcome === 'mismatch'
    );
  }
  return signal.name === MISMATCH_LOG;
}

function tallyByTag(
  hits: ReadonlyArray<Signal>,
  tag: string,
): Readonly<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (const hit of hits) {
    const key = hit.tags[tag] ?? 'unknown';
    tally[key] = (tally[key] ?? 0) + hit.value;
  }
  return tally;
}

function newestMeter(all: ReadonlyArray<Signal>, name: string): Signal | null {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const signal = all[i];
    if (signal.source === 'meter' && signal.name === name) {
      return signal;
    }
  }
  return null;
}
