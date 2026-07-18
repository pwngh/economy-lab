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

import { jsonlAuditSink, opsRuntime } from '#src/ops/index.ts';
import { fixedClock } from '#test/support/capabilities.ts';

import type { Logger, Meter } from '#src/ports.ts';

type MeterCall = { kind: 'count' | 'observe'; name: string; value: number };

function spyMeter(): { calls: MeterCall[]; meter: Meter } {
  const calls: MeterCall[] = [];
  return {
    calls,
    meter: {
      count: (name, n) => calls.push({ kind: 'count', name, value: n }),
      observe: (name, value) => calls.push({ kind: 'observe', name, value }),
    },
  };
}

function spyLogger(): { events: string[]; logger: Logger } {
  const events: string[] = [];
  return {
    events,
    logger: { log: (_level, event) => events.push(event) },
  };
}

test('the runtime forwards every call to the host sinks unchanged', () => {
  const clock = fixedClock(100);
  const { calls, meter } = spyMeter();
  const { events, logger } = spyLogger();
  const runtime = opsRuntime({ meter, logger, clock });

  runtime.meter.count('economy.submit', 2, { kind: 'spend' });
  runtime.meter.observe('economy.submit.ms', 17, { kind: 'spend' });
  runtime.logger.log('warn', 'worker.payouts.pending_past_timeout', {});

  assert.deepEqual(calls, [
    { kind: 'count', name: 'economy.submit', value: 2 },
    { kind: 'observe', name: 'economy.submit.ms', value: 17 },
  ]);
  assert.deepEqual(events, ['worker.payouts.pending_past_timeout']);
});

test('signals are stamped by the clock and windowed by since', () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: { count: () => {}, observe: () => {} },
    logger: { log: () => {} },
    clock,
  });

  runtime.meter.count('engine.retry', 1, { conflict: 'deadlock' });
  clock.advance(50);
  runtime.logger.log('error', 'worker.checkpoint.mismatch', {});

  assert.equal(runtime.signals.since(0).length, 2);
  const late = runtime.signals.since(50);
  assert.equal(late.length, 1);
  assert.deepEqual(late[0], {
    at: 50,
    source: 'log',
    name: 'worker.checkpoint.mismatch',
    value: 1,
    tags: { level: 'error' },
  });
});

test('the buffer keeps the newest signals once capacity is hit', () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime(
    {
      meter: { count: () => {}, observe: () => {} },
      logger: { log: () => {} },
      clock,
    },
    { capacity: 3 },
  );

  for (let i = 0; i < 8; i += 1) {
    clock.advance(1);
    runtime.meter.count('engine.retry', i, {});
  }

  const kept = runtime.signals.since(0);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((signal) => signal.value),
    [5, 6, 7],
  );
});

test('the jsonl sink writes one parseable line per record, bigints included', () => {
  const lines: string[] = [];
  const sink = jsonlAuditSink((line) => lines.push(line));
  sink({
    at: 7,
    signature: 'stuck-saga',
    tier: 1,
    phase: 'detected',
    subject: 'saga_1',
    detail: { ageMs: 90_000, shortfall: 4_000n },
  });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: 7,
    signature: 'stuck-saga',
    tier: 1,
    phase: 'detected',
    subject: 'saga_1',
    detail: { ageMs: 90_000, shortfall: { $bigint: '4000' } },
  });
});
