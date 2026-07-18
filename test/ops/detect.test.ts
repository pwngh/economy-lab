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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectInboxDeadLetters,
  detectOutboxBacklog,
  detectRetryExhaustion,
  detectSlowSeal,
  detectVelocityAnomaly,
  detectWebhookReplayStorm,
} from '#src/ops/index.ts';
import { feedOf, logSignal, meterSignal } from '#test/ops/support.ts';

test('retry exhaustion sums only exhausted outcomes inside the window, tallied per engine', () => {
  const feed = feedOf([
    // Conflicts recover; they are pressure, not faults, and never count here.
    meterSignal(50, 'engine.retry', 10, {
      engine: 'mysql',
      outcome: 'conflict',
    }),
    meterSignal(60, 'engine.retry', 2, {
      engine: 'mysql',
      outcome: 'exhausted',
    }),
    meterSignal(70, 'engine.retry', 3, {
      engine: 'postgres',
      outcome: 'exhausted',
    }),
    // Outside the window.
    meterSignal(0, 'engine.retry', 9, {
      engine: 'mysql',
      outcome: 'exhausted',
    }),
  ]);

  assert.equal(
    detectRetryExhaustion(feed, 100, { windowMs: 90, threshold: 6 }),
    null,
  );

  const finding = detectRetryExhaustion(feed, 100, {
    windowMs: 90,
    threshold: 5,
  });
  assert.deepEqual(finding, {
    signature: 'retry-exhaustion',
    exhausted: 5,
    byEngine: { mysql: 2, postgres: 3 },
    windowMs: 90,
  });
});

test('outbox backlog reads only the newest gauge sample, so a drained backlog clears the finding', () => {
  const stale = feedOf([
    meterSignal(10, 'worker.relay.backlog', 40),
    meterSignal(10, 'worker.relay.backlog_age_ms', 900_000),
    // A later relay run drained it.
    meterSignal(20, 'worker.relay.backlog', 0),
    meterSignal(20, 'worker.relay.backlog_age_ms', 5),
  ]);
  assert.equal(detectOutboxBacklog(stale, { ageMs: 300_000 }), null);

  const growing = feedOf([
    meterSignal(10, 'worker.relay.backlog_age_ms', 5),
    meterSignal(20, 'worker.relay.backlog', 17),
    meterSignal(20, 'worker.relay.backlog_age_ms', 600_000),
  ]);
  assert.deepEqual(detectOutboxBacklog(growing, { ageMs: 300_000 }), {
    signature: 'outbox-backlog',
    ageMs: 600_000,
    pending: 17,
  });

  assert.equal(detectOutboxBacklog(feedOf([]), { ageMs: 300_000 }), null);
});

test('webhook replay storm counts duplicates in the window and tallies provider and layer', () => {
  const signals = [
    meterSignal(10, 'economy.webhook.duplicate', 1, {
      provider: 'steam',
      layer: 'replay',
    }),
    meterSignal(20, 'economy.webhook.duplicate', 1, {
      provider: 'steam',
      layer: 'replay',
    }),
    meterSignal(30, 'economy.webhook.duplicate', 1, {
      provider: 'apple',
      layer: 'inbox',
    }),
  ];

  assert.equal(
    detectWebhookReplayStorm(feedOf(signals), 100, {
      windowMs: 100,
      threshold: 4,
    }),
    null,
  );

  const finding = detectWebhookReplayStorm(feedOf(signals), 100, {
    windowMs: 100,
    threshold: 3,
  });
  assert.deepEqual(finding, {
    signature: 'webhook-replay-storm',
    duplicates: 3,
    byProvider: { steam: 2, apple: 1 },
    byLayer: { replay: 2, inbox: 1 },
    windowMs: 100,
  });
});

test('slow seal looks at completed seals only and reports the window max', () => {
  const feed = feedOf([
    meterSignal(10, 'worker.checkpoint.seal_ms', 9_000, { outcome: 'skipped' }),
    meterSignal(20, 'worker.checkpoint.seal_ms', 2_000, { outcome: 'sealed' }),
    meterSignal(30, 'worker.checkpoint.seal_ms', 6_500, { outcome: 'sealed' }),
  ]);

  assert.equal(
    detectSlowSeal(feed, 100, { thresholdMs: 7_000, windowMs: 100 }),
    null,
  );
  assert.deepEqual(
    detectSlowSeal(feed, 100, { thresholdMs: 5_000, windowMs: 100 }),
    {
      signature: 'checkpoint-seal-slow',
      maxMs: 6_500,
      samples: 2,
      windowMs: 100,
    },
  );
});

test('inbox dead letters count log signals past the watermark against the threshold', () => {
  const feed = feedOf([
    logSignal(10, 'worker.inbox.dead_lettered'),
    logSignal(20, 'worker.inbox.dead_lettered'),
    // Other dead-letter families do not count.
    logSignal(30, 'worker.relay.dead_lettered'),
  ]);

  assert.equal(detectInboxDeadLetters(feed, 15, { threshold: 2 }), null);
  assert.deepEqual(detectInboxDeadLetters(feed, -1, { threshold: 2 }), {
    signature: 'inbox-dead-letter',
    deadLettered: 2,
    newestAt: 20,
  });
});

test('velocity anomaly carries the per-kind tally and the per-minute rate', () => {
  const feed = feedOf([
    meterSignal(10, 'economy.submit', 1, {
      kind: 'spend',
      status: 'rejected',
      reason: 'RISK_DENIED',
    }),
    meterSignal(20, 'economy.submit', 1, {
      kind: 'topUp',
      status: 'rejected',
      reason: 'RISK_DENIED',
    }),
    meterSignal(30, 'economy.submit', 1, {
      kind: 'spend',
      status: 'rejected',
      reason: 'RISK_DENIED',
    }),
  ]);

  const finding = detectVelocityAnomaly(feed, 60_000, {
    windowMs: 60_000,
    threshold: 3,
  });
  assert.deepEqual(finding, {
    signature: 'velocity-anomaly',
    rejections: 3,
    byKind: { spend: 2, topUp: 1 },
    ratePerMin: 3,
    windowMs: 60_000,
  });
});
