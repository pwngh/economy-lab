/// <reference types="node" />
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

// Unit tests for the performance harness (scripts/support/harness.ts) — the bench is only trustworthy
// if its own logic is. Pins the parts a wrong answer would quietly corrupt: config layering, the
// pool-sizing assertion, the outcome/fault taxonomy, the counter delta math, the latency percentiles,
// and the retry-pressure instrumentation. DB-touching paths are exercised only for in-memory (always
// available) and skipped otherwise, matching the house pattern.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';

import { topUp, spend, requestPayout, credit } from '#test/support/builders.ts';
import {
  assertPoolSizing,
  classifyOutcome,
  classifyThrow,
  counterDelta,
  determinismRoot,
  latencyDist,
  poolSizeFor,
  requiredPoolSize,
  resolveConfig,
  resolveUrls,
  tryProvision,
} from '#scripts/support/harness.ts';
import {
  CHAIN_CONTINUITY_MARKER,
  CHAIN_FORK_INDEX,
  setRetryObserver,
  withTransientRetry,
} from '#src/engines/sql-shared.ts';

import type { HarnessConfig } from '#scripts/support/harness.ts';
import type { RetryEvent, RetryObserver } from '#src/engines/sql-shared.ts';

// An Error carrying engine-specific fields, so classifyThrow sees the same shape the drivers raise
// (mysql2 puts a numeric `errno` + `sqlMessage`; pg puts a SQLSTATE `code` + `constraint`).
function driverError(
  fields: Record<string, unknown>,
  message = 'driver error',
): Error {
  return Object.assign(new Error(message), fields);
}

describe('Bench harness: resolveConfig', () => {
  test('defaults to the default profile, all backends, throughput/gates-off, conns-per-op 2', () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.profile, 'default');
    assert.deepEqual(cfg.backends, ['in-memory', 'postgres', 'mysql']);
    assert.equal(cfg.mode, 'throughput');
    assert.equal(cfg.gates, 'off');
    assert.equal(cfg.connsPerOp, 2);
    assert.equal(cfg.poolHeadroom, 4);
    assert.equal(cfg.poolMax, null);
    assert.equal(cfg.concurrency, 32);
  });

  test('a named profile sets a coherent batch of defaults', () => {
    const fast = resolveConfig({ BENCH_PROFILE: 'fast' });
    assert.equal(fast.profile, 'fast');
    assert.equal(fast.ops, 100);
    assert.equal(fast.concurrency, 16);
  });

  test('an explicit env var overrides the profile it belongs to', () => {
    const cfg = resolveConfig({ BENCH_PROFILE: 'thorough', BENCH_OPS: '300' });
    assert.equal(cfg.profile, 'thorough');
    assert.equal(cfg.ops, 300); // explicit wins over the profile's 2000
  });

  test('an unknown profile name falls back to default', () => {
    const cfg = resolveConfig({ BENCH_PROFILE: 'bogus' });
    assert.equal(cfg.profile, 'default');
    assert.equal(cfg.ops, 500);
  });

  test('BENCH_BACKENDS is parsed and unknown names are dropped', () => {
    const cfg = resolveConfig({ BENCH_BACKENDS: 'in-memory, bogus ,postgres' });
    assert.deepEqual(cfg.backends, ['in-memory', 'postgres']);
  });

  test('an all-unknown BENCH_BACKENDS falls back to in-memory rather than nothing', () => {
    const cfg = resolveConfig({ BENCH_BACKENDS: 'bogus,nope' });
    assert.deepEqual(cfg.backends, ['in-memory']);
  });

  test('mode, gates, and the pool knobs are read from env', () => {
    const cfg = resolveConfig({
      BENCH_MODE: 'contention',
      BENCH_GATES: 'on',
      BENCH_CONNS_PER_OP: '3',
      BENCH_POOL_HEADROOM: '8',
      BENCH_POOL_MAX: '99',
    });
    assert.equal(cfg.mode, 'contention');
    assert.equal(cfg.gates, 'on');
    assert.equal(cfg.connsPerOp, 3);
    assert.equal(cfg.poolHeadroom, 8);
    assert.equal(cfg.poolMax, 99);
  });

  test('unrecognized mode/gates values fall back to the safe defaults', () => {
    const cfg = resolveConfig({ BENCH_MODE: 'sideways', BENCH_GATES: 'maybe' });
    assert.equal(cfg.mode, 'throughput');
    assert.equal(cfg.gates, 'off');
  });
});

describe('Bench harness: resolveUrls', () => {
  test('accepts a postgres:// DATABASE_URL as the postgres target', () => {
    const urls = resolveUrls({ DATABASE_URL: 'postgres://u@h:5432/db' });
    assert.equal(urls.postgres, 'postgres://u@h:5432/db');
  });

  test('accepts a postgresql:// DATABASE_URL too (pg treats them the same)', () => {
    const urls = resolveUrls({ DATABASE_URL: 'postgresql://u@h:5432/db' });
    assert.equal(urls.postgres, 'postgresql://u@h:5432/db');
  });

  test('a mysql:// DATABASE_URL targets mysql, and MYSQL_TEST_URL is honored', () => {
    const urls = resolveUrls({ MYSQL_TEST_URL: 'mysql://root:p@h:3306/db' });
    assert.equal(urls.mysql, 'mysql://root:p@h:3306/db');
  });

  test('falls back to local defaults when nothing is set', () => {
    const urls = resolveUrls({});
    assert.match(urls.postgres, /^postgres:\/\//);
    assert.match(urls.mysql, /^mysql:\/\//);
  });
});

describe('Bench harness: pool sizing', () => {
  const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
    ...resolveConfig({}),
    concurrency: 32,
    connsPerOp: 2,
    poolHeadroom: 4,
    poolMax: null,
    ...over,
  });

  test('requiredPoolSize covers connsPerOp × concurrency plus headroom', () => {
    assert.equal(requiredPoolSize(cfg()), 2 * 32 + 4);
    assert.equal(requiredPoolSize(cfg({ connsPerOp: 1 })), 1 * 32 + 4);
  });

  test('poolSizeFor uses the explicit override when set, else the derived size', () => {
    assert.equal(poolSizeFor(cfg()), 68);
    assert.equal(poolSizeFor(cfg({ poolMax: 200 })), 200);
  });

  test('assertPoolSizing passes at or above the floor (connsPerOp × concurrency + 1)', () => {
    assert.equal(assertPoolSizing(cfg(), 68), 68);
    assert.equal(assertPoolSizing(cfg(), 65), 65); // exactly the floor: 2×32 + 1
  });

  test('assertPoolSizing throws below the floor — the self-deadlock guard', () => {
    // 64 = 2×32 leaves no slack: the money transactions can take every connection and the velocity
    // records then block forever. This must fail fast, not hang.
    assert.throws(() => assertPoolSizing(cfg(), 64), /pool too small/);
    assert.throws(() => assertPoolSizing(cfg(), 1), /pool too small/);
  });
});

describe('Bench harness: classifyOutcome', () => {
  test('a committed submit is committed', () => {
    assert.deepEqual(
      classifyOutcome({ status: 'committed', transaction: {} }),
      {
        status: 'committed',
      },
    );
  });

  test('a duplicate submit is its own category (a reused id, not a rejection)', () => {
    assert.deepEqual(
      classifyOutcome({ status: 'duplicate', transaction: {} }),
      {
        status: 'duplicate',
      },
    );
  });

  test('a rejection carries its reason code as data', () => {
    assert.deepEqual(
      classifyOutcome({ status: 'rejected', reason: 'INSUFFICIENT_FUNDS' }),
      { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' },
    );
  });

  test('an unexpected shape is treated as a rejection, never as committed', () => {
    assert.deepEqual(classifyOutcome(null), {
      status: 'rejected',
      reason: 'rejected',
    });
    assert.deepEqual(classifyOutcome({ status: 'weird' }), {
      status: 'rejected',
      reason: 'rejected',
    });
  });
});

describe('Bench harness: classifyThrow (real cause, never a blanket "deadlock")', () => {
  test('MySQL deadlock (errno 1213) and lock-wait (1205)', () => {
    assert.equal(classifyThrow(driverError({ errno: 1213 })).klass, 'deadlock');
    assert.equal(
      classifyThrow(driverError({ errno: 1205 })).klass,
      'lock-wait-timeout',
    );
  });

  test('MySQL 1062 is chain-fork ONLY on the chain-head index, else a real duplicate', () => {
    const fork = driverError(
      {
        errno: 1062,
        sqlMessage: `Duplicate entry 'x' for key '${CHAIN_FORK_INDEX}'`,
      },
      `Duplicate entry 'x' for key '${CHAIN_FORK_INDEX}'`,
    );
    assert.equal(classifyThrow(fork).klass, 'chain-fork');
    const realDup = driverError({
      errno: 1062,
      sqlMessage: "Duplicate entry for key 'idempotency.PRIMARY'",
    });
    assert.equal(classifyThrow(realDup).klass, 'other-fault');
  });

  test('MySQL 1644 is chain-continuity only with the continuity marker', () => {
    const cont = driverError({
      errno: 1644,
      sqlMessage: `${CHAIN_CONTINUITY_MARKER}: head moved`,
    });
    assert.equal(classifyThrow(cont).klass, 'chain-continuity');
    const otherSignal = driverError({
      errno: 1644,
      sqlMessage: 'conservation broken',
    });
    assert.equal(classifyThrow(otherSignal).klass, 'other-fault');
  });

  test('Postgres SQLSTATEs: 40P01 deadlock, 40001 serialization', () => {
    assert.equal(
      classifyThrow(driverError({ code: '40P01' })).klass,
      'deadlock',
    );
    assert.equal(
      classifyThrow(driverError({ code: '40001' })).klass,
      'serialization',
    );
  });

  test('Postgres 23505 is chain-fork only on the chain-head constraint', () => {
    assert.equal(
      classifyThrow(
        driverError({ code: '23505', constraint: CHAIN_FORK_INDEX }),
      ).klass,
      'chain-fork',
    );
    assert.equal(
      classifyThrow(
        driverError({ code: '23505', constraint: 'idempotency_pkey' }),
      ).klass,
      'other-fault',
    );
  });

  test('Postgres P0001 is chain-continuity only with the marker', () => {
    assert.equal(
      classifyThrow(
        driverError(
          { code: 'P0001' },
          `${CHAIN_CONTINUITY_MARKER}: stale head`,
        ),
      ).klass,
      'chain-continuity',
    );
    assert.equal(
      classifyThrow(driverError({ code: 'P0001' }, 'conservation: off by one'))
        .klass,
      'other-fault',
    );
  });

  test('a pool/connection-acquisition timeout is its own class, not a deadlock', () => {
    const timeout = new Error('timeout exceeded when trying to connect');
    assert.equal(classifyThrow(timeout).klass, 'pool-timeout');
  });

  test('the raw driver code is always preserved in the label', () => {
    assert.equal(
      classifyThrow(driverError({ errno: 1213 })).label,
      'deadlock (errno 1213)',
    );
    assert.equal(
      classifyThrow(driverError({ code: '40P01' })).label,
      'deadlock (40P01)',
    );
    assert.equal(classifyThrow(new Error('x')).label, 'other-fault (fault)');
  });
});

describe('Bench harness: counterDelta', () => {
  test('after − before, per field', () => {
    assert.deepEqual(
      counterDelta(
        { deadlocks: 5, lockWaits: 1 },
        { deadlocks: 9, lockWaits: 4 },
      ),
      { deadlocks: 4, lockWaits: 3 },
    );
  });

  test('floors at 0 so a counter reset never reports a negative delta', () => {
    assert.deepEqual(
      counterDelta(
        { deadlocks: 9, lockWaits: 2 },
        { deadlocks: 5, lockWaits: 2 },
      ),
      { deadlocks: 0, lockWaits: 0 },
    );
  });

  test('a missing endpoint yields null (reported as n/a, never a fabricated number)', () => {
    assert.equal(counterDelta(null, { deadlocks: 1, lockWaits: 0 }), null);
    assert.equal(counterDelta({ deadlocks: 1, lockWaits: 0 }, null), null);
  });
});

describe('Bench harness: latencyDist', () => {
  test('empty input is all zeros', () => {
    assert.deepEqual(latencyDist([]), {
      count: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });

  test('nearest-rank percentiles over a known distribution', () => {
    const d = latencyDist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(d.count, 10);
    assert.equal(d.p50, 5); // ceil(0.50×10)=5th value
    assert.equal(d.p95, 10); // ceil(0.95×10)=10th value
    assert.equal(d.p99, 10);
    assert.equal(d.max, 10);
  });

  test('unsorted input is sorted before ranking', () => {
    const d = latencyDist([10, 1, 5, 3, 9, 2, 8, 4, 7, 6]);
    assert.equal(d.p50, 5);
    assert.equal(d.max, 10);
  });
});

describe('Bench harness: retry-pressure instrumentation (withTransientRetry)', () => {
  // A transient marker the way the engines' isTransientConflict would recognize one.
  const isTransient = (e: unknown): boolean =>
    (e as { transient?: boolean } | null)?.transient === true;
  const transientError = (): Error =>
    Object.assign(new Error('transient conflict'), { transient: true });

  test('counts each retry and a single recovery when the attempt finally commits', async () => {
    const events: RetryEvent[] = [];
    const prev = setRetryObserver((e) => events.push(e));
    try {
      let calls = 0;
      const result = await withTransientRetry(
        async () => {
          calls += 1;
          if (calls < 3) throw transientError(); // fail twice, then succeed
          return 'committed';
        },
        isTransient,
        5,
      );
      assert.equal(result, 'committed');
    } finally {
      setRetryObserver(prev);
    }
    assert.equal(events.filter((e) => e.type === 'retry').length, 2);
    assert.equal(events.filter((e) => e.type === 'recovered').length, 1);
    assert.equal(events.filter((e) => e.type === 'exhausted').length, 0);
  });

  test('a non-transient fault is neither retried nor observed, and propagates on the first throw', async () => {
    const events: RetryEvent[] = [];
    const prev = setRetryObserver((e) => events.push(e));
    let calls = 0;
    try {
      await assert.rejects(
        withTransientRetry(
          async () => {
            calls += 1;
            throw new Error('domain fault'); // not transient
          },
          isTransient,
          5,
        ),
      );
    } finally {
      setRetryObserver(prev);
    }
    assert.equal(calls, 1); // thrown once, never retried
    assert.equal(events.length, 0);
  });

  test('emits exhausted and rethrows when a persistent transient burns the budget', async () => {
    const events: RetryEvent[] = [];
    const prev = setRetryObserver((e) => events.push(e));
    try {
      await assert.rejects(
        withTransientRetry(
          async () => {
            throw transientError();
          },
          isTransient,
          3,
        ),
      );
    } finally {
      setRetryObserver(prev);
    }
    // maxAttempts=3 → tries 1 and 2 retry, try 3 exhausts.
    assert.equal(events.filter((e) => e.type === 'retry').length, 2);
    assert.equal(events.filter((e) => e.type === 'exhausted').length, 1);
    assert.equal(events.filter((e) => e.type === 'recovered').length, 0);
  });

  test('setRetryObserver returns the previous observer so it can be restored', () => {
    const a: RetryObserver = () => {};
    const restoredToA = setRetryObserver(a);
    const restoredToPrev = setRetryObserver(restoredToA);
    assert.equal(restoredToPrev, a);
  });
});

describe('Bench harness: in-memory provisioning + determinism root', () => {
  test('provisions in-memory with no engine counters and a serial pool', async () => {
    const cfg = resolveConfig({ BENCH_BACKENDS: 'in-memory' });
    const p = await tryProvision('in-memory', cfg);
    assert.notEqual(p, null);
    try {
      assert.equal(p!.counters, null); // no engine deadlock counter to read
      assert.equal(p!.poolMax, 1); // serial store, one transaction at a time
      assert.equal(p!.connsPerOp, 1);
    } finally {
      await p!.teardown();
    }
  });

  test('the same fixed op sequence yields the same Merkle root (the cross-engine oracle is stable)', async () => {
    const cfg = resolveConfig({ BENCH_BACKENDS: 'in-memory' });
    const run = async (): Promise<string> => {
      const p = await tryProvision('in-memory', cfg);
      assert.notEqual(p, null);
      after(async () => p!.teardown());
      await p!.economy.submit(
        topUp({ userId: 'd_a', amount: credit('100.00') }),
      );
      await p!.economy.submit(
        spend({
          buyerId: 'd_a',
          sku: 'd_sku',
          price: credit('10.00'),
          orderId: 'd_ord_0',
          recipients: [{ sellerId: 'd_c', shareBps: 10_000 }],
        }),
      );
      await p!.economy.submit(
        requestPayout({ userId: 'd_c', amount: credit('1.00') }),
      );
      return determinismRoot(p!);
    };
    const first = await run();
    const second = await run();
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/); // a 32-byte hex digest
  });
});
