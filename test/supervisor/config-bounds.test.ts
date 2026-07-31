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

/**
 * The supervisor is a detector, so a knob outside its bounds does not tune a pass — it switches
 * one off, in one of two directions. Below its bound a detector's comparison is vacuously false
 * and the pass says nothing while the incident it watches for runs; at or below zero the
 * comparison is vacuously true and the pass reports an incident, and pulls its lever, on a
 * healthy system. Neither announces itself: an empty tick is what a clean tick returns.
 *
 * The two tests that open this file are those two directions, driven end to end. The cell roster
 * then holds every knob, and the positive control holds the other side — a config inside the
 * bounds still constructs and still detects, because "bad knobs are refused" is satisfiable by
 * refusing everything.
 *
 * No expected verdict here reads the bounds table. Every bad value and every refusal fragment is
 * a literal, so the gate and the table have to agree by construction rather than by sharing a
 * source.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { credits } from '#src/index.ts';
import { createSupervisor } from '#src/supervisor/index.ts';
import { defaultSupervisorConfig } from '#src/supervisor/index.ts';
import { fixedClock } from '#test/support/capabilities.ts';
import { feedOf, meterSignal, logSignal } from '#test/supervisor/support.ts';

import type { Saga } from '#src/ports.ts';
import type { AuditRecord } from '#src/supervisor/index.ts';
import type { Signal } from '#src/supervisor/index.ts';
import type { SupervisorConfig } from '#src/supervisor/index.ts';

const NOW = 10_000_000;

function saga(updatedAt: number): Saga {
  return {
    id: 'saga_payout',
    userId: 'usr_seller',
    reserve: credits(40),
    rateId: 'rate_test',
    txnId: 'txn_anchor_bounds',
    state: 'RESERVED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt,
    payoutUsd: null,
  };
}

type Run = {
  readonly built: boolean;
  readonly refusal: Error | null;
  readonly records: ReadonlyArray<AuditRecord>;
  readonly sweeps: number;
  readonly relays: number;
  readonly revives: ReadonlyArray<number>;
  readonly pages: number;
};

/**
 * Builds a supervisor on the supplied knobs and ticks it `count` times, reporting what it did
 * rather than whether it threw. A refusal and a silent tick are the two outcomes this file
 * separates, and only one of them is a defect.
 */
async function drive(
  config: Partial<SupervisorConfig>,
  options: {
    signals?: ReadonlyArray<Signal>;
    sagas?: ReadonlyArray<Saga>;
    ticks?: number;
  } = {},
): Promise<Run> {
  const records: AuditRecord[] = [];
  const revives: number[] = [];
  let sweeps = 0;
  let relays = 0;
  let pages = 0;
  const sagas = options.sagas ?? [];
  try {
    const supervisor = createSupervisor({
      clock: fixedClock(NOW),
      signals: feedOf(options.signals ?? []),
      sagas: {
        list: async function* () {
          yield* sagas;
        },
        load: async (id) => sagas.find((one) => one.id === id) ?? null,
      },
      runSweep: async () => {
        sweeps += 1;
      },
      runRelay: async () => {
        relays += 1;
      },
      reviveInbox: async (limit) => {
        revives.push(limit);
        return [];
      },
      escalate: () => {
        pages += 1;
      },
      audit: (record) => records.push(record),
      config,
    });
    for (let i = 0; i < (options.ticks ?? 1); i += 1) {
      await supervisor.tick();
    }
  } catch (error) {
    return {
      built: false,
      refusal: error as Error,
      records,
      sweeps,
      relays,
      revives,
      pages,
    };
  }
  return {
    built: true,
    refusal: null,
    records,
    sweeps,
    relays,
    revives,
    pages,
  };
}

const signatures = (run: Run): string[] =>
  [...new Set(run.records.map((record) => record.signature))].sort();

// --- The two directions, driven end to end ------------------------------------------

// A cohort probing the velocity limits: 120 RISK_DENIED rejections, which the default window and
// threshold detect and escalate. The advisory this raises reads the spike as a fraud signal first.
const CARD_TESTING: ReadonlyArray<Signal> = [
  meterSignal(NOW - 10_000, 'economy.submit', 120, {
    status: 'rejected',
    reason: 'RISK_DENIED',
    kind: 'spend',
  }),
];

// Every incident at once, one per configurable pass, for the positive control.
const EVERY_INCIDENT: ReadonlyArray<Signal> = [
  meterSignal(NOW - 10_000, 'engine.retry', 25, { outcome: 'conflict' }),
  meterSignal(NOW - 10_000, 'engine.retry', 6, {
    engine: 'pg',
    outcome: 'exhausted',
  }),
  ...CARD_TESTING,
  meterSignal(NOW - 10_000, 'economy.webhook.duplicate', 25, {
    provider: 'tilia',
    layer: 'inbox',
  }),
  meterSignal(NOW - 10_000, 'worker.checkpoint.seal_ms', 9_000, {
    outcome: 'sealed',
  }),
  meterSignal(NOW - 10_000, 'worker.relay.backlog_age_ms', 600_000),
  meterSignal(NOW - 10_000, 'worker.relay.backlog', 40),
  meterSignal(NOW - 30_000, 'engine.pool.acquire', 1, { engine: 'pg' }),
  logSignal(NOW - 10_000, 'worker.inbox.dead_lettered'),
  logSignal(NOW - 9_000, 'worker.inbox.dead_lettered'),
];

describe('a SupervisorConfig reaches a detection pass only through the bounds check', () => {
  test('a window below the bound cannot supervise, because the pass it feeds says nothing while a fraud spike runs', async () => {
    const run = await drive(
      { anomalyWindowMs: -1 },
      {
        signals: CARD_TESTING,
        ticks: 10,
      },
    );

    if (run.built) {
      assert.deepEqual(
        { records: run.records.length, pages: run.pages },
        { records: 2, pages: 1 },
        'the supervisor was built on a window of -1 and said nothing about 120 RISK_DENIED rejections across ten ticks',
      );
    }

    assert.ok(
      run.refusal,
      'createSupervisor supervised on anomalyWindowMs: -1',
    );
    assert.equal(
      (run.refusal as { code?: string }).code,
      'CONFIG.INVALID',
      'the refusal carries the config fault code',
    );
    assert.ok(
      run.refusal.message.includes(
        'config.anomalyWindowMs must be a whole number from 1 to 86400000',
      ),
      `the refusal has to hand over the knob and the range; it said "${run.refusal.message}"`,
    );
  });

  test('a threshold below the bound cannot supervise, because the pass it feeds revives an inbox that has nothing dead in it', async () => {
    const run = await drive({ inboxDeadLetterThreshold: 0 }, { ticks: 10 });

    if (run.built) {
      assert.deepEqual(
        { records: run.records.length, revives: run.revives },
        { records: 0, revives: [] },
        'the supervisor was built on a threshold of 0 and opened revive episodes on a healthy inbox',
      );
    }

    assert.ok(
      run.refusal,
      'createSupervisor supervised on inboxDeadLetterThreshold: 0',
    );
    assert.ok(
      run.refusal.message.includes(
        'config.inboxDeadLetterThreshold must be a whole number of at least 1',
      ),
      `the refusal has to hand over the knob and the range; it said "${run.refusal.message}"`,
    );
  });

  // --- The roster ---------------------------------------------------------------------

  /**
   * Every knob, with values outside its bound and the sentence each refusal has to hand a caller.
   * Keyed by `keyof SupervisorConfig`, so a knob added to the type leaves this roster short a key
   * and fails the typecheck rather than arriving unchecked.
   *
   * `accepted` is the other half: a value inside the bound that must still build. Without it the
   * whole roster is satisfied by a supervisor that refuses everything.
   */
  const KNOB_CELLS: Readonly<
    Record<
      keyof SupervisorConfig,
      {
        readonly refused: ReadonlyArray<{
          readonly value: unknown;
          readonly fragment: string;
        }>;
        readonly accepted: unknown;
      }
    >
  > = {
    stuckSagaAgeMs: {
      refused: [
        {
          value: 0,
          fragment:
            'config.stuckSagaAgeMs must be a whole number from 1 to 86400000; it was 0.',
        },
        {
          value: Number.NaN,
          fragment:
            'config.stuckSagaAgeMs must be a whole number from 1 to 86400000; it was NaN.',
        },
        {
          value: 86_400_001,
          fragment:
            'config.stuckSagaAgeMs must be a whole number from 1 to 86400000; it was 86400001.',
        },
      ],
      accepted: 600_000,
    },
    actionCooldownMs: {
      refused: [
        {
          value: -1,
          fragment:
            'config.actionCooldownMs must be a whole number from 0 to 86400000; it was -1.',
        },
      ],
      // Zero is inside the bound on purpose: no spacing between actions is a choice, and three
      // tests in this suite already make it.
      accepted: 0,
    },
    maxActionAttempts: {
      refused: [
        {
          value: 0,
          fragment:
            'config.maxActionAttempts must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 3,
    },
    deadlockMetric: {
      refused: [
        {
          value: '',
          fragment:
            'config.deadlockMetric must be a non-empty meter name; it was "".',
        },
        {
          value: 7,
          fragment:
            'config.deadlockMetric must be a non-empty meter name; it was 7.',
        },
      ],
      accepted: 'engine.retry',
    },
    deadlockWindowMs: {
      refused: [
        {
          value: -1,
          fragment:
            'config.deadlockWindowMs must be a whole number from 1 to 86400000; it was -1.',
        },
      ],
      accepted: 60_000,
    },
    deadlockThreshold: {
      refused: [
        {
          value: 0,
          fragment:
            'config.deadlockThreshold must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 20,
    },
    stallGraceMs: {
      refused: [
        {
          value: 0,
          fragment:
            'config.stallGraceMs must be a whole number from 1 to 86400000; it was 0.',
        },
      ],
      accepted: 10_000,
    },
    anomalyWindowMs: {
      refused: [
        {
          value: -1,
          fragment:
            'config.anomalyWindowMs must be a whole number from 1 to 86400000; it was -1.',
        },
        {
          value: Number.POSITIVE_INFINITY,
          fragment:
            'config.anomalyWindowMs must be a whole number from 1 to 86400000; it was Infinity.',
        },
      ],
      accepted: 300_000,
    },
    anomalyThreshold: {
      refused: [
        {
          value: 0,
          fragment:
            'config.anomalyThreshold must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 20,
    },
    anomalyEscalationThreshold: {
      refused: [
        {
          value: 0,
          fragment:
            'config.anomalyEscalationThreshold must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 100,
    },
    retryExhaustionWindowMs: {
      refused: [
        {
          value: -1,
          fragment:
            'config.retryExhaustionWindowMs must be a whole number from 1 to 86400000; it was -1.',
        },
      ],
      accepted: 300_000,
    },
    retryExhaustionThreshold: {
      refused: [
        {
          value: 0,
          fragment:
            'config.retryExhaustionThreshold must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 5,
    },
    outboxBacklogAgeMs: {
      refused: [
        {
          value: 0,
          fragment:
            'config.outboxBacklogAgeMs must be a whole number from 1 to 86400000; it was 0.',
        },
      ],
      accepted: 300_000,
    },
    webhookReplayWindowMs: {
      refused: [
        {
          value: -1,
          fragment:
            'config.webhookReplayWindowMs must be a whole number from 1 to 86400000; it was -1.',
        },
      ],
      accepted: 60_000,
    },
    webhookReplayThreshold: {
      refused: [
        {
          value: 0,
          fragment:
            'config.webhookReplayThreshold must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 20,
    },
    sealLatencyMs: {
      refused: [
        {
          value: 0,
          fragment:
            'config.sealLatencyMs must be a whole number from 1 to 86400000; it was 0.',
        },
      ],
      accepted: 5_000,
    },
    sealLatencyWindowMs: {
      refused: [
        {
          value: -1,
          fragment:
            'config.sealLatencyWindowMs must be a whole number from 1 to 86400000; it was -1.',
        },
      ],
      accepted: 300_000,
    },
    inboxDeadLetterThreshold: {
      refused: [
        {
          value: 0,
          fragment:
            'config.inboxDeadLetterThreshold must be a whole number of at least 1; it was 0.',
        },
      ],
      accepted: 1,
    },
    inboxReviveLimit: {
      refused: [
        {
          value: 0,
          fragment:
            'config.inboxReviveLimit must be a whole number of at least 1; it was 0.',
        },
        {
          value: -1,
          fragment:
            'config.inboxReviveLimit must be a whole number of at least 1; it was -1.',
        },
      ],
      accepted: 10,
    },
    watchdogs: {
      refused: [
        {
          value: [{ signal: 'worker.sweep', everyMs: -1 }],
          fragment:
            'config.watchdogs[0].everyMs must be a whole number from 1 to 86400000; it was -1.',
        },
        {
          value: [{ signal: '', everyMs: 60_000 }],
          fragment:
            'config.watchdogs[0].signal must be a non-empty meter name; it was "".',
        },
        {
          value: 'worker.sweep',
          fragment:
            'config.watchdogs must be a list of { signal, everyMs }; it was "worker.sweep".',
        },
      ],
      accepted: [{ signal: 'worker.sweep', everyMs: 60_000 }],
    },
  };

  // Driven with no tick at all, so every cell also holds the refusal to construction time: a
  // supervisor built on a knob nobody chose must not exist to be started.
  test('every knob outside its bound is refused at construction, naming the knob and the range', async () => {
    let examined = 0;
    for (const [knob, cell] of Object.entries(KNOB_CELLS)) {
      for (const bad of cell.refused) {
        const run = await drive(
          { [knob]: bad.value } as Partial<SupervisorConfig>,
          {
            ticks: 0,
          },
        );
        assert.ok(
          run.refusal,
          `${knob}: ${String(bad.value)} built a supervisor`,
        );
        assert.equal(
          (run.refusal as { code?: string }).code,
          'CONFIG.INVALID',
          `${knob} threw something other than the config fault: ${run.refusal.message}`,
        );
        assert.ok(
          run.refusal.message.includes(bad.fragment),
          `${knob} has to hand over "${bad.fragment}"; it said "${run.refusal.message}"`,
        );
        examined += 1;
      }
    }
    assert.equal(examined, 27, `drove ${examined} out-of-bound values`);
    assert.equal(
      Object.keys(KNOB_CELLS).length,
      20,
      `covered ${Object.keys(KNOB_CELLS).length} knobs`,
    );
  });

  test('every knob inside its bound still builds a supervisor', async () => {
    let examined = 0;
    for (const [knob, cell] of Object.entries(KNOB_CELLS)) {
      const run = await drive({
        [knob]: cell.accepted,
      } as Partial<SupervisorConfig>);
      assert.equal(
        run.refusal,
        null,
        `${knob} refused a value inside its bound: ${run.refusal?.message}`,
      );
      examined += 1;
    }
    assert.equal(examined, 20, `drove ${examined} in-bound values`);
  });

  test('the defaults every unset field falls back to are inside the bounds', async () => {
    const run = await drive(defaultSupervisorConfig);
    assert.equal(
      run.refusal,
      null,
      `defaultSupervisorConfig is outside its own table: ${run.refusal?.message}`,
    );
    assert.equal(
      Object.keys(defaultSupervisorConfig).length,
      20,
      'the defaults carry one value per knob',
    );
  });

  // --- The positive control -----------------------------------------------------------

  test('a SupervisorConfig inside its bounds still detects every signature and still pulls every lever', async () => {
    const run = await drive(
      { watchdogs: [{ signal: 'worker.sweep', everyMs: 60_000 }] },
      { signals: EVERY_INCIDENT, sagas: [saga(NOW - 600_000)] },
    );

    assert.equal(run.refusal, null, `the control was refused: ${run.refusal}`);
    assert.deepEqual(signatures(run), [
      'checkpoint-seal-slow',
      'deadlock-storm',
      'engine-stall',
      'inbox-dead-letter',
      'outbox-backlog',
      'retry-exhaustion',
      'stuck-saga',
      'velocity-anomaly',
      'webhook-replay-storm',
    ]);
    assert.deepEqual(
      {
        records: run.records.length,
        sweeps: run.sweeps,
        relays: run.relays,
        revives: run.revives,
        pages: run.pages,
      },
      { records: 23, sweeps: 1, relays: 1, revives: [10], pages: 3 },
      'a config inside the bounds has to detect, act and page exactly as it did before the check',
    );
  });
});
