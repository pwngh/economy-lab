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

import { credits, noopLogger, noopMeter } from '#src/index.ts';

import { createSupervisor, opsRuntime } from '#src/ops/index.ts';
import { fixedClock } from '#test/support/capabilities.ts';
import { frozenSagaSource, noSignals, recorder } from '#test/ops/support.ts';

import type { Saga } from '#src/ports.ts';
import type { AuditRecord } from '#src/ops/index.ts';

function stuckSaga(id: string): Saga {
  return {
    id,
    userId: 'usr_seller',
    reserve: credits(40),
    rateId: 'rate_test',
    state: 'RESERVED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
  };
}

test('guardrails: cooldown suppresses, the attempt cap escalates once, then acting stops', async () => {
  const clock = fixedClock(100_000);
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: noSignals,
    sagas: frozenSagaSource([stuckSaga('saga_stuck')]),
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: {
      stuckSagaAgeMs: 1_000,
      actionCooldownMs: 5_000,
      maxActionAttempts: 3,
    },
  });

  const first = await supervisor.tick();
  assert.deepEqual(
    first.map((record) => record.phase),
    ['detected', 'decided', 'acted', 'verified'],
  );
  assert.equal(sweeps, 1);
  const verified = first.find((record) => record.phase === 'verified');
  assert.equal(verified?.detail.outcome, 'unchanged');

  const cooled = await supervisor.tick();
  assert.deepEqual(
    cooled.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(cooled[1].detail.reason, 'cooldown');
  assert.equal(sweeps, 1);

  clock.advance(6_000);
  await supervisor.tick();
  clock.advance(6_000);
  await supervisor.tick();
  assert.equal(sweeps, 3);
  assert.equal(escalations.length, 0);

  clock.advance(6_000);
  const capped = await supervisor.tick();
  assert.deepEqual(
    capped.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(sweeps, 3);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].detail.attempts, 3);

  clock.advance(6_000);
  const after = await supervisor.tick();
  assert.deepEqual(
    after.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(after[1].detail.reason, 'escalated');
  assert.equal(sweeps, 3);
  assert.equal(escalations.length, 1);
  assert.equal(
    records.filter((record) => record.phase === 'escalated').length,
    1,
  );
});

test('a tick arriving while one is in flight is skipped, not queued', async () => {
  const clock = fixedClock(100_000);
  const { records, sink } = recorder();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sweeps = 0;
  const stuck = stuckSaga('saga_slow');
  const supervisor = createSupervisor({
    clock,
    signals: noSignals,
    sagas: {
      list: async function* () {
        await gate;
        yield stuck;
      },
      load: async () => stuck,
    },
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    config: { stuckSagaAgeMs: 1_000, actionCooldownMs: 0 },
  });

  const first = supervisor.tick();
  const second = await supervisor.tick();
  assert.deepEqual(second, []);

  release();
  const firstRecords = await first;
  assert.equal(sweeps, 1);
  assert.equal(
    firstRecords.filter((record) => record.phase === 'decided').length,
    1,
  );
  assert.equal(records.length, firstRecords.length);
});

test('a healthy tick emits nothing', async () => {
  const { records, sink } = recorder();
  const supervisor = createSupervisor({
    clock: fixedClock(1_000),
    signals: noSignals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
  });

  assert.deepEqual(await supervisor.tick(), []);
  assert.deepEqual(records, []);
});

test('an integrity mismatch proves once, escalates once, and never re-fires', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  let proves = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      throw new Error('must never be called for integrity findings');
    },
    audit: sink,
    prove: async () => {
      proves += 1;
      return { chainIntact: false };
    },
    escalate: (record) => escalations.push(record),
  });

  clock.advance(10);
  runtime.meter.count('worker.checkpoint.verify', 1, { outcome: 'mismatch' });
  runtime.logger.log('error', 'worker.checkpoint.mismatch', {});

  const detectedTick = await supervisor.tick();
  assert.deepEqual(
    detectedTick.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(detectedTick[0].detail.signals, 2);
  assert.equal(proves, 1);
  assert.equal(escalations.length, 1);
  assert.deepEqual(escalations[0].detail.proof, { chainIntact: false });

  const quietTick = await supervisor.tick();
  assert.deepEqual(quietTick, []);
  assert.equal(proves, 1);
  assert.equal(records.length, 2);
});

test('an engine stall escalates once and resets when acquires complete again', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: { stallGraceMs: 10_000 },
  });

  // A healthy acquire pair is not a stall.
  runtime.meter.count('engine.pool.acquire', 1, { engine: 'mysql' });
  runtime.meter.observe('engine.pool.acquire_ms', 3, { engine: 'mysql' });
  assert.deepEqual(await supervisor.tick(), []);

  // Three acquires start and never complete; within the grace period, still quiet.
  clock.advance(1_000);
  for (let i = 0; i < 3; i += 1) {
    runtime.meter.count('engine.pool.acquire', 1, { engine: 'mysql' });
  }
  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(15_000);
  const stalled = await supervisor.tick();
  assert.deepEqual(
    stalled.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(stalled[0].detail.pending, 3);
  assert.equal(escalations.length, 1);

  // Still stalled: no repeat escalation while the episode persists.
  clock.advance(15_000);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(escalations.length, 1);

  // A completion ends the episode; a later stall escalates fresh.
  runtime.meter.observe('engine.pool.acquire_ms', 31_000, { engine: 'mysql' });
  assert.deepEqual(await supervisor.tick(), []);
  clock.advance(1_000);
  runtime.meter.count('engine.pool.acquire', 1, { engine: 'mysql' });
  clock.advance(15_000);
  const again = await supervisor.tick();
  assert.equal(
    again.filter((record) => record.phase === 'escalated').length,
    1,
  );
  assert.equal(escalations.length, 2);
  assert.equal(
    records.filter((record) => record.phase === 'escalated').length,
    2,
  );
});

test('a treasury breach escalates per occurrence and never re-fires on old signals', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    escalate: (record) => escalations.push(record),
  });

  clock.advance(10);
  runtime.meter.count('worker.treasury.breach', 1, {});
  const first = await supervisor.tick();
  assert.deepEqual(
    first.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(escalations.length, 1);
  assert.deepEqual(first[0].detail.channels, ['worker.treasury.breach']);

  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(10);
  runtime.meter.count('worker.treasury.float_breach', 1, {});
  const second = await supervisor.tick();
  assert.equal(
    second.filter((record) => record.phase === 'escalated').length,
    1,
  );
  assert.equal(escalations.length, 2);
  assert.equal(records.length, 4);
});

test('a velocity rejection spike advises once per window; other rejections do not count', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    config: { anomalyWindowMs: 1_000, anomalyThreshold: 5 },
  });

  for (let i = 0; i < 4; i += 1) {
    runtime.meter.count('economy.submit', 1, {
      kind: 'spend',
      status: 'rejected',
      reason: 'INSUFFICIENT_FUNDS',
    });
  }
  assert.deepEqual(await supervisor.tick(), []);

  for (let i = 0; i < 6; i += 1) {
    runtime.meter.count('economy.submit', 1, {
      kind: 'spend',
      status: 'rejected',
      reason: 'RISK_DENIED',
    });
  }
  const spiked = await supervisor.tick();
  assert.deepEqual(
    spiked.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(spiked[0].detail.rejections, 6);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});

test('a declared watchdog escalates on silence and resets when the beat returns', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: { watchdogs: [{ signal: 'worker.sweep', everyMs: 1_000 }] },
  });

  assert.deepEqual(await supervisor.tick(), []); // watching begins here

  clock.advance(1_500);
  runtime.meter.count('worker.sweep', 1, { failed: '0' });
  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(2_500);
  const silent = await supervisor.tick();
  assert.deepEqual(
    silent.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(silent[0].subject, 'worker.sweep');
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(escalations.length, 1);

  runtime.meter.count('worker.sweep', 1, { failed: '0' });
  assert.deepEqual(await supervisor.tick(), []); // beat returned, episode reset

  clock.advance(2_500);
  const again = await supervisor.tick();
  assert.equal(
    again.filter((record) => record.phase === 'escalated').length,
    1,
  );
  assert.equal(escalations.length, 2);
  assert.equal(
    records.filter((record) => record.phase === 'escalated').length,
    2,
  );
});

test('retry exhaustion escalates once per window with the per-engine tally', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: { retryExhaustionWindowMs: 1_000, retryExhaustionThreshold: 3 },
  });

  // Conflicts alone never fire the exhaustion signature.
  for (let i = 0; i < 5; i += 1) {
    runtime.meter.count('engine.retry', 1, {
      engine: 'mysql',
      outcome: 'conflict',
    });
  }
  assert.deepEqual(await supervisor.tick(), []);

  for (let i = 0; i < 3; i += 1) {
    runtime.meter.count('engine.retry', 1, {
      engine: 'mysql',
      outcome: 'exhausted',
    });
  }
  const fired = await supervisor.tick();
  assert.deepEqual(
    fired.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.deepEqual(fired[0].detail.byEngine, { mysql: 3 });
  assert.equal(escalations.length, 1);

  // Same window: suppressed even though the signals still match.
  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(2_000);
  for (let i = 0; i < 3; i += 1) {
    runtime.meter.count('engine.retry', 1, {
      engine: 'postgres',
      outcome: 'exhausted',
    });
  }
  const again = await supervisor.tick();
  assert.equal(
    again.filter((record) => record.phase === 'escalated').length,
    1,
  );
  assert.equal(escalations.length, 2);
  assert.equal(records.length, 4);
});

test('a webhook replay storm advises once per window', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    config: { webhookReplayWindowMs: 1_000, webhookReplayThreshold: 3 },
  });

  for (let i = 0; i < 4; i += 1) {
    runtime.meter.count('economy.webhook.duplicate', 1, {
      provider: 'steam',
      layer: 'replay',
    });
  }
  const stormTick = await supervisor.tick();
  assert.deepEqual(
    stormTick.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.deepEqual(stormTick[0].detail.byProvider, { steam: 4 });
  assert.equal(stormTick[1].detail.decision, 'advise');

  assert.deepEqual(await supervisor.tick(), []);
  clock.advance(2_000);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});

test('a slow checkpoint seal advises once per window on completed seals only', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    config: { sealLatencyMs: 5_000, sealLatencyWindowMs: 1_000 },
  });

  // A slow skip carries no signal about re-derivation cost.
  runtime.meter.observe('worker.checkpoint.seal_ms', 9_000, {
    outcome: 'skipped',
  });
  assert.deepEqual(await supervisor.tick(), []);

  runtime.meter.observe('worker.checkpoint.seal_ms', 6_000, {
    outcome: 'sealed',
  });
  const slow = await supervisor.tick();
  assert.deepEqual(
    slow.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(slow[0].detail.maxMs, 6_000);

  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});

test('a velocity spike past the escalation threshold escalates instead of advising', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const escalations: AuditRecord[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: {
      anomalyWindowMs: 1_000,
      anomalyThreshold: 5,
      anomalyEscalationThreshold: 10,
    },
  });

  for (let i = 0; i < 12; i += 1) {
    runtime.meter.count('economy.submit', 1, {
      kind: 'spend',
      status: 'rejected',
      reason: 'RISK_DENIED',
    });
  }
  const spiked = await supervisor.tick();
  assert.deepEqual(
    spiked.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.deepEqual(spiked[0].detail.byKind, { spend: 12 });
  assert.equal(escalations.length, 1);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});

test('an integrity episode pauses the worker and containment suppresses every tier-1 lever', async () => {
  const clock = fixedClock(100_000);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { sink } = recorder();
  let paused = 0;
  let sweeps = 0;
  let relays = 0;
  let revives = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([stuckSaga('saga_stuck')]),
    runSweep: async () => {
      sweeps += 1;
    },
    runRelay: async () => {
      relays += 1;
    },
    reviveInbox: async () => {
      revives += 1;
      return [];
    },
    pauseWorker: () => {
      paused += 1;
    },
    audit: sink,
    prove: async () => ({ conserved: false }),
    config: {
      stuckSagaAgeMs: 1_000,
      actionCooldownMs: 0,
      outboxBacklogAgeMs: 1_000,
    },
  });

  // One tick sees a mismatch, a stuck saga, an old backlog, and a dead-lettered inbox row.
  runtime.meter.count('worker.checkpoint.verify', 1, { outcome: 'mismatch' });
  runtime.meter.observe('worker.relay.backlog', 3, {});
  runtime.meter.observe('worker.relay.backlog_age_ms', 5_000, {});
  runtime.logger.log('error', 'worker.inbox.dead_lettered', {});

  const tick = await supervisor.tick();
  assert.equal(paused, 1);
  const acted = tick.filter((record) => record.phase === 'acted');
  assert.deepEqual(
    acted.map((record) => [record.signature, record.detail.action]),
    [['integrity-mismatch', 'pause']],
  );
  assert.equal(sweeps, 0);
  assert.equal(relays, 0);
  assert.equal(revives, 0);
  assert.deepEqual(
    tick
      .filter((record) => record.detail.reason === 'containment')
      .map((record) => record.signature)
      .sort(),
    ['inbox-dead-letter', 'outbox-backlog', 'stuck-saga'],
  );

  // The latch persists: later ticks still refuse every lever, and the pause never repeats.
  clock.advance(10_000);
  const later = await supervisor.tick();
  assert.equal(sweeps, 0);
  assert.equal(paused, 1);
  assert.equal(
    later.filter((record) => record.detail.reason === 'containment').length,
    2,
  );
});

test('an outbox backlog re-drives the relay under guardrails and verifies against the next gauge', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { sink } = recorder();
  const escalations: AuditRecord[] = [];
  let relays = 0;
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      sweeps += 1;
    },
    runRelay: async () => {
      relays += 1;
    },
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: {
      outboxBacklogAgeMs: 60_000,
      actionCooldownMs: 5_000,
      maxActionAttempts: 2,
    },
  });

  // A young backlog is not a finding.
  runtime.meter.observe('worker.relay.backlog', 2, {});
  runtime.meter.observe('worker.relay.backlog_age_ms', 1_000, {});
  assert.deepEqual(await supervisor.tick(), []);

  // An old backlog acts through the targeted relay lever, never the full sweep.
  clock.advance(10);
  runtime.meter.observe('worker.relay.backlog', 40, {});
  runtime.meter.observe('worker.relay.backlog_age_ms', 90_000, {});
  const acted = await supervisor.tick();
  assert.deepEqual(
    acted.map((record) => record.phase),
    ['detected', 'decided', 'acted'],
  );
  assert.equal(acted[1].detail.action, 'redriveRelay');
  assert.equal(relays, 1);
  assert.equal(sweeps, 0);

  // The stale gauge still matches, but the cooldown holds the lever.
  const cooled = await supervisor.tick();
  assert.deepEqual(
    cooled.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(cooled[1].detail.reason, 'cooldown');
  assert.equal(relays, 1);

  // A fresh lower gauge closes the loop: verified drained, and no finding remains.
  clock.advance(10);
  runtime.meter.observe('worker.relay.backlog', 0, {});
  runtime.meter.observe('worker.relay.backlog_age_ms', 5, {});
  const verified = await supervisor.tick();
  assert.deepEqual(
    verified.map((record) => [record.signature, record.phase]),
    [['outbox-backlog', 'verified']],
  );
  assert.equal(verified[0].detail.outcome, 'drained');

  // Re-drives that change nothing exhaust the cap into a permanent escalation.
  clock.advance(10_000);
  runtime.meter.observe('worker.relay.backlog_age_ms', 95_000, {});
  await supervisor.tick();
  assert.equal(relays, 2);
  clock.advance(10_000);
  runtime.meter.observe('worker.relay.backlog_age_ms', 99_000, {});
  const capped = await supervisor.tick();
  assert.deepEqual(
    capped.map((record) => record.phase),
    ['verified', 'detected', 'escalated'],
  );
  assert.equal(capped[0].detail.outcome, 'unchanged');
  assert.equal(escalations.length, 1);

  clock.advance(10_000);
  runtime.meter.observe('worker.relay.backlog_age_ms', 99_500, {});
  const after = await supervisor.tick();
  assert.deepEqual(
    after.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(after[1].detail.reason, 'escalated');
  assert.equal(relays, 2);
});

test('the outbox re-drive falls back to the full sweep when no relay lever is wired', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { sink } = recorder();
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    config: { outboxBacklogAgeMs: 1_000 },
  });

  runtime.meter.observe('worker.relay.backlog_age_ms', 5_000, {});
  const acted = await supervisor.tick();
  assert.equal(acted[1].detail.action, 'runOnce');
  assert.equal(sweeps, 1);
});

test('inbox dead letters revive under episode guardrails; without the lever the pass only reports', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { sink } = recorder();
  const escalations: AuditRecord[] = [];
  const reviveCalls: number[] = [];
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    reviveInbox: async (limit) => {
      reviveCalls.push(limit);
      return [{ id: 'ibx_1' }];
    },
    audit: sink,
    escalate: (record) => escalations.push(record),
    config: {
      inboxReviveLimit: 5,
      actionCooldownMs: 0,
      maxActionAttempts: 2,
    },
  });

  clock.advance(10);
  runtime.logger.log('error', 'worker.inbox.dead_lettered', {});
  const first = await supervisor.tick();
  assert.deepEqual(
    first.map((record) => record.phase),
    ['detected', 'decided', 'acted', 'verified'],
  );
  assert.deepEqual(first[1].detail, {
    decision: 'act',
    action: 'reviveInbox',
    limit: 5,
  });
  assert.deepEqual(first[2].detail.revived, ['ibx_1']);
  assert.equal(first[3].detail.outcome, 'revived');
  assert.deepEqual(reviveCalls, [5]);

  // The watermark advanced: no new signals, no new episode.
  assert.deepEqual(await supervisor.tick(), []);

  // A second episode spends the second attempt; the third escalates permanently.
  clock.advance(10);
  runtime.logger.log('error', 'worker.inbox.dead_lettered', {});
  await supervisor.tick();
  assert.equal(reviveCalls.length, 2);
  clock.advance(10);
  runtime.logger.log('error', 'worker.inbox.dead_lettered', {});
  const capped = await supervisor.tick();
  assert.deepEqual(
    capped.map((record) => record.phase),
    ['detected', 'escalated'],
  );
  assert.equal(escalations.length, 1);
  assert.equal(reviveCalls.length, 2);

  clock.advance(10);
  runtime.logger.log('error', 'worker.inbox.dead_lettered', {});
  const after = await supervisor.tick();
  assert.equal(after[1].detail.reason, 'escalated');
  assert.equal(reviveCalls.length, 2);
});

test('without a revive lever the inbox pass reports and suppresses, once per episode', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {},
    audit: sink,
  });

  clock.advance(10);
  runtime.logger.log('error', 'worker.inbox.dead_lettered', {});
  const tick = await supervisor.tick();
  assert.deepEqual(
    tick.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.deepEqual(tick[1].detail, {
    decision: 'suppressed',
    reason: 'no-lever',
  });
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});

test('a deadlock storm advises once per window and takes no action', async () => {
  const clock = fixedClock(0);
  const runtime = opsRuntime({
    meter: noopMeter(),
    logger: noopLogger(),
    clock,
  });
  const { records, sink } = recorder();
  let sweeps = 0;
  const supervisor = createSupervisor({
    clock,
    signals: runtime.signals,
    sagas: frozenSagaSource([]),
    runSweep: async () => {
      sweeps += 1;
    },
    audit: sink,
    config: { deadlockWindowMs: 1_000, deadlockThreshold: 20 },
  });

  for (let i = 0; i < 25; i += 1) {
    runtime.meter.count('engine.retry', 1, { conflict: 'deadlock' });
  }

  const stormTick = await supervisor.tick();
  assert.deepEqual(
    stormTick.map((record) => record.phase),
    ['detected', 'decided'],
  );
  assert.equal(stormTick[0].detail.retries, 25);
  assert.equal(stormTick[1].detail.decision, 'advise');
  assert.equal(sweeps, 0);

  assert.deepEqual(await supervisor.tick(), []);

  clock.advance(2_000);
  assert.deepEqual(await supervisor.tick(), []);
  assert.equal(records.length, 2);
});
