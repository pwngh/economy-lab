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

export type DeadlockStormFinding = {
  signature: 'deadlock-storm';
  retries: number;
  windowMs: number;
};

export type StuckSagaFinding = {
  signature: 'stuck-saga';
  saga: Saga;
  ageMs: number;
};

export type IntegrityMismatchFinding = {
  signature: 'integrity-mismatch';
  at: number;
  channel: 'meter' | 'log';
};

export type EngineStallFinding = {
  signature: 'engine-stall';
  pending: number;
  oldestWaitMs: number;
};

export type TreasuryBreachFinding = {
  signature: 'treasury-breach';
  breaches: number;
  channels: ReadonlyArray<string>;
  newestAt: number;
};

export type VelocityAnomalyFinding = {
  signature: 'velocity-anomaly';
  rejections: number;
  byKind: Readonly<Record<string, number>>;
  ratePerMin: number;
  windowMs: number;
};

export type SilenceFinding = {
  signature: 'signal-silence';
  signal: string;
  silentForMs: number;
};

export type RetryExhaustionFinding = {
  signature: 'retry-exhaustion';
  exhausted: number;
  byEngine: Readonly<Record<string, number>>;
  windowMs: number;
};

export type OutboxBacklogFinding = {
  signature: 'outbox-backlog';
  ageMs: number;
  pending: number;
};

export type WebhookReplayStormFinding = {
  signature: 'webhook-replay-storm';
  duplicates: number;
  byProvider: Readonly<Record<string, number>>;
  byLayer: Readonly<Record<string, number>>;
  windowMs: number;
};

export type SlowSealFinding = {
  signature: 'checkpoint-seal-slow';
  maxMs: number;
  samples: number;
  windowMs: number;
};

export type InboxDeadLetterFinding = {
  signature: 'inbox-dead-letter';
  deadLettered: number;
  newestAt: number;
};

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

// Acquires that started and never completed are the one signal a wedged engine still gives
// off: a stalled pool emits nothing else, so the rule looks at the whole buffer rather than
// a sliding window that the stall itself would age out of.
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

// Watches signals the host declares SHOULD beat on a cadence (a worker sweep, a checkpoint
// verify). Silence is measured from the later of the last beat and when watching began, so a
// worker that never started is caught too.
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

// The gauge pair rides each relay run, so only the newest sample matters: an old high reading
// followed by a fresh low one means the backlog drained.
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

// Only completed seals carry a meaningful duration; a skip or retry says nothing about how the
// re-derivation is scaling.
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

// Log fields are never buffered, so the dead rows' ids are invisible here; the store's own
// reviveDead picks the oldest rows without needing them.
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
