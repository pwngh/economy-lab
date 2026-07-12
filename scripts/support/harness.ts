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

// Shared harness for scripts/bench.ts and scripts/scale-probe.ts, so both measure the same way.
// Every SQL run gets its own throwaway schema (Postgres) / database (MySQL), dropped on teardown.
// Every knob is an env var resolved in resolveConfig, and every reported number comes from a
// ledger that just passed its invariants.

import { writeFile } from 'node:fs/promises';

import { createEconomy, memoryStore, workerCtxFrom } from '#src/index.ts';
import { createMysqlPool } from '#src/engines/mysql.ts';
import { loadConfig } from '#src/config.ts';
import {
  LOCAL_MYSQL_URL,
  LOCAL_POSTGRES_URL,
  readEnum,
  readInt,
  readIntOrNull,
  readList,
  storeUrls,
} from '#src/env.ts';
import { openPgPool } from '#src/engines/pg-driver.ts';
import { sha256Digest } from '#src/digest.ts';
import { allInvariantsHold } from '#src/integrity.ts';
import { merkleRoot } from '#src/chain.ts';
import { toHex } from '#src/bytes.ts';
import {
  CHAIN_CONTINUITY_MARKER,
  CHAIN_FORK_INDEX,
  setRetryObserver,
} from '#src/engines/sql-shared.ts';
import {
  makeIsolatedMysqlStore,
  makeIsolatedPostgresStore,
} from '#test/support/adapters.ts';
import {
  defaultPricing,
  fakeProcessor,
  fixedClock,
  fixedRates,
  noopMeter,
  seededSigner,
  sequentialIds,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Capabilities, Clock, Digest, Store } from '#src/ports.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Config } from '#src/config.ts';
import type { EnvMap } from '#src/env.ts';
import type { Economy, ProveReport, WorkerCtx } from '#src/index.ts';

// 'in-memory' always runs; a SQL backend is skipped when its database is unreachable (see tryProvision).
export type BackendName = 'in-memory' | 'postgres' | 'mysql';

// `throughput` funds every subject, so any rejection is a bug; `contention` oversubscribes a small
// subject pool on purpose, so rejections and retries are the measured signal.
export type BenchMode = 'throughput' | 'contention';

// `off` neutralizes the policy gates to measure pure ledger work; `on` sets realistic values. The
// velocity record runs in both modes; `on` only adds the deny.
export type GatesMode = 'off' | 'on';

/** Every knob the bench/scale harness reads; .env.example is held to this list. */
export const BENCH_KEYS = [
  'BENCH_PROFILE',
  'BENCH_OPS',
  'BENCH_REPS',
  'BENCH_WARMUP',
  'BENCH_CONCURRENCY',
  'BENCH_BUDGET_MS',
  'BENCH_BACKENDS',
  'BENCH_REQUIRE',
  'BENCH_OUTPUT',
  'BENCH_JSON_PATH',
  'BENCH_SEED',
  'BENCH_MODE',
  'BENCH_GATES',
  'BENCH_SHARDS',
  'BENCH_CONNS_PER_OP',
  'BENCH_POOL_HEADROOM',
  'BENCH_POOL_MAX',
  'BENCH_POSTGRES_URL',
  'BENCH_MYSQL_URL',
  'BENCH_CURVE_USERS',
  'BENCH_CURVE_REPS',
  'SEGMENTS',
  'SEG',
] as const;

export type HarnessConfig = {
  ops: number; // measured ops per throughput sample
  reps: number; // a throughput number is the best (fastest) of this many runs
  warmup: number; // discarded ops before timing, to let the JIT settle
  concurrency: number; // in-flight submits for the concurrent/pipelined sample
  budgetMs: number; // per-sample time cap, so a slow backend bounds its own run
  backends: BackendName[];
  // Backends whose absence fails the run (BENCH_REQUIRE): bench-prod sets postgres,mysql because
  // inside the compose network a skip means a dead container, not an absent database.
  required: BackendName[];
  output: 'table' | 'json' | 'both';
  jsonPath: string | null; // where JSON goes; null = stdout
  seed: number; // sequential-id seed, for reproducible ids
  profile: string;
  mode: BenchMode;
  gates: GatesMode;
  shards: number; // PLATFORM_SHARDS for the measured economy (BENCH_SHARDS); 1 = unsharded
  // Pool sizing: an in-flight op holds one connection for its money transaction (which carries the
  // velocity record); brief pool borrows ride the headroom. Cover connsPerOp*concurrency + headroom.
  connsPerOp: number;
  poolHeadroom: number; // spare connections above connsPerOp*concurrency (borrows, probes, seal)
  poolMax: number | null; // explicit pool-size override; null = derive from the formula above
  urls: { postgres: string; mysql: string };
  // Integrity-curve knobs (scripts/bench.ts): a fixed user set so accounts stay flat while postings grow.
  curveUsers: number;
  curveSizes: number[];
  curveReps: number;
  // Scale-probe knobs (scripts/scale-probe.ts): segment count and size for the history-growth curve.
  segments: number;
  segmentSize: number;
};

const PROFILE_NAMES = ['fast', 'default', 'thorough'] as const;
type ProfileName = (typeof PROFILE_NAMES)[number];
const PROFILES: Record<ProfileName, Partial<HarnessConfig>> = {
  fast: {
    ops: 100,
    reps: 2,
    warmup: 10,
    concurrency: 16,
    curveSizes: [500, 1000],
    segments: 4,
    segmentSize: 250,
  },
  default: {
    ops: 500,
    reps: 3,
    warmup: 50,
    concurrency: 32,
    curveSizes: [500, 1000, 2000, 4000],
    segments: 8,
    segmentSize: 500,
  },
  thorough: {
    ops: 2000,
    reps: 5,
    warmup: 200,
    concurrency: 64,
    curveSizes: [1000, 2000, 4000, 8000, 16000],
    segments: 16,
    segmentSize: 1000,
  },
};

// Parsed through the real loadConfig so the measured Config cannot drift from production (gate
// semantics: GatesMode).
function buildBenchConfig(gates: GatesMode, shards: number): Config {
  const secrets = {
    WEBHOOK_SECRET: 'bench-webhook-secret',
    SIGNING_SECRET: 'bench-signing-secret',
  };
  if (gates === 'on') {
    // Maturity stays 0 even with gates on: on the fixed clock a non-zero hold would immature every
    // payout — a clock artifact, not a measured cost.
    return loadConfig({
      ...secrets,
      MATURITY_HORIZON_CARD_MS: '0',
      MATURITY_HORIZON_CRYPTO_MS: '0',
      MATURITY_HORIZON_DEFAULT_MS: '0',
      PAYOUT_MIN_EARNED_MINOR: '1',
      PAYOUT_MIN_INTERVAL_MS: '0',
      PLATFORM_SHARDS: String(shards),
      VELOCITY_LIMIT_MINOR: '1000000000',
    });
  }
  return loadConfig({
    ...secrets,
    MATURITY_HORIZON_CARD_MS: '0',
    MATURITY_HORIZON_CRYPTO_MS: '0',
    MATURITY_HORIZON_DEFAULT_MS: '0',
    PAYOUT_MIN_EARNED_MINOR: '1',
    PAYOUT_MIN_INTERVAL_MS: '0',
    PLATFORM_SHARDS: String(shards),
    VELOCITY_LIMIT_MINOR: '1000000000000000',
  });
}

// --- Config resolution ------------------------------------------------------------

// Layering: hard defaults < named profile < explicit env var. Every knob requires >= 1 except
// warmup and poolHeadroom, where zero means "none" and is honored.
export function resolveConfig(env: EnvMap): HarnessConfig {
  const profileName = readEnum(env.BENCH_PROFILE, PROFILE_NAMES, 'default');
  const base = { ...PROFILES.default, ...PROFILES[profileName] };

  const backendList = (value: string | undefined): BackendName[] =>
    readList(value).filter(
      (s): s is BackendName =>
        s === 'in-memory' || s === 'postgres' || s === 'mysql',
    );
  const backends = backendList(
    env.BENCH_BACKENDS ?? 'in-memory,postgres,mysql',
  );

  const output = readEnum(
    env.BENCH_OUTPUT,
    ['table', 'json', 'both'] as const,
    'table',
  );
  const mode = readEnum(
    env.BENCH_MODE,
    ['throughput', 'contention'] as const,
    'throughput',
  );
  const gates = readEnum(env.BENCH_GATES, ['off', 'on'] as const, 'off');

  const one = { min: 1 };
  return {
    ops: readInt(env.BENCH_OPS, base.ops!, one),
    reps: readInt(env.BENCH_REPS, base.reps!, one),
    warmup: readInt(env.BENCH_WARMUP, base.warmup!),
    concurrency: readInt(env.BENCH_CONCURRENCY, base.concurrency!, one),
    budgetMs: readInt(env.BENCH_BUDGET_MS, 5000, one),
    backends: backends.length > 0 ? backends : ['in-memory'],
    required: backendList(env.BENCH_REQUIRE),
    output,
    jsonPath: env.BENCH_JSON_PATH ?? null,
    seed: readInt(env.BENCH_SEED, 1, one),
    profile: profileName,
    mode,
    gates,
    shards: readInt(env.BENCH_SHARDS, 1, one),
    connsPerOp: readInt(env.BENCH_CONNS_PER_OP, 1, one),
    poolHeadroom: readInt(env.BENCH_POOL_HEADROOM, 4),
    poolMax: readIntOrNull(env.BENCH_POOL_MAX, one),
    urls: resolveUrls(env),
    curveUsers: readInt(env.BENCH_CURVE_USERS, 20, one),
    curveSizes: base.curveSizes!,
    curveReps: readInt(env.BENCH_CURVE_REPS, 2, one),
    segments: readInt(env.SEGMENTS, base.segments!, one),
    segmentSize: readInt(env.SEG, base.segmentSize!, one),
  };
}

// --- Pool sizing -----------------------------------------------------------------

// The smallest pool that will not self-deadlock (see the pool-sizing note on HarnessConfig).
export function requiredPoolSize(cfg: HarnessConfig): number {
  return cfg.connsPerOp * cfg.concurrency + cfg.poolHeadroom;
}

// BENCH_POOL_MAX wins when set (so an operator can probe an undersized pool); assertPoolSizing still checks it.
export function poolSizeFor(cfg: HarnessConfig): number {
  return cfg.poolMax ?? requiredPoolSize(cfg);
}

// Fail fast rather than hang: below connsPerOp*concurrency + 1, in-flight transactions can take
// every connection and their brief pool borrows then block forever.
export function assertPoolSizing(cfg: HarnessConfig, poolMax: number): number {
  const floor = cfg.connsPerOp * cfg.concurrency + 1;
  if (poolMax < floor) {
    throw new Error(
      `pool too small: poolMax=${poolMax} but concurrency=${cfg.concurrency} * ${cfg.connsPerOp} conns/op ` +
        `needs >= ${floor} (recommended ${requiredPoolSize(cfg)} = ${cfg.connsPerOp}*${cfg.concurrency} + ${cfg.poolHeadroom} headroom). ` +
        `In-flight transactions must leave a free connection for their brief pool borrows, ` +
        `so a pool sized below the concurrency deadlocks. Raise BENCH_POOL_MAX/BENCH_POOL_HEADROOM or lower BENCH_CONCURRENCY.`,
    );
  }
  return poolMax;
}

// The bench-specific override wins, then the shared resolver's precedence, then the compose-local
// default — so `make bench` reaches the shipped docker-compose with no env at all.
export function resolveUrls(env: EnvMap): {
  postgres: string;
  mysql: string;
} {
  const urls = storeUrls(env);
  return {
    postgres: env.BENCH_POSTGRES_URL || urls.postgres || LOCAL_POSTGRES_URL,
    mysql: env.BENCH_MYSQL_URL || urls.mysql || LOCAL_MYSQL_URL,
  };
}

// --- Provisioning: a fresh, isolated, reseeded economy per backend ----------------

// The engine's own contention counters — they count even deadlocks a retry recovered. Cumulative;
// the bench reads a delta per sample (see counterDelta).
export type EngineCounters = { deadlocks: number; lockWaits: number };

// Null when the engine has no readable counter. Held on its own connection, outside the bench's pool.
export type CounterProbe = (() => Promise<EngineCounters | null>) | null;

// `teardown` drops the throwaway schema/database (SQL) or releases the store (in-memory), so a run
// leaves nothing behind.
export type Provisioned = {
  backend: BackendName;
  label: string;
  durable: boolean; // whether a committed op survives process exit (false for in-memory)
  durability: string; // human note: engine version + the commit-durability settings, probed live
  // In-memory store runs one transaction at a time, so its concurrency is 1; SQL engines overlap
  // via the pool.
  concurrency: number;
  poolMax: number; // the pool the store was built with (1 for in-memory's serial store)
  connsPerOp: number;
  mode: BenchMode;
  gates: GatesMode;
  economy: Economy;
  store: Store; // exposed for integrity-curve work (sealCheckpoint / reverifyCheckpoint)
  workerCtx: WorkerCtx; // the runtime services a checkpoint seal/verify needs, over this same store
  counters: CounterProbe; // read the engine's own deadlock/lock-wait counters; null for in-memory
  teardown: () => Promise<void>;
};

// The digest and clock must be the same instances the store was built with, so the chain heads agree.
function assemble(
  store: Store,
  digest: Digest,
  clock: Clock,
  opts: { seed: number; gates: GatesMode; shards: number },
): { economy: Economy; workerCtx: WorkerCtx } {
  const caps: Capabilities = {
    store,
    clock,
    digest,
    ids: sequentialIds(opts.seed),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    // fixedRates is the production configuredRates under pinned values — the production rate source is measured.
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    pricing: defaultPricing(),
    config: buildBenchConfig(opts.gates, opts.shards),
  };
  return { economy: createEconomy(caps), workerCtx: workerCtxFrom(caps) };
}

// The production digest, not the test seededDigest: the chain hash is on every submit's hot path,
// so the bench must measure the code path production runs. Runs stay reproducible — SHA-256 over
// deterministic inputs is deterministic.
const digestAndClock = (): { digest: Digest; clock: Clock } => ({
  digest: sha256Digest(),
  clock: fixedClock(0),
});

async function provisionInMemory(cfg: HarnessConfig): Promise<Provisioned> {
  const { digest, clock } = digestAndClock();
  const store = memoryStore({ digest, clock });
  const { economy, workerCtx } = assemble(store, digest, clock, {
    seed: cfg.seed,
    gates: cfg.gates,
    shards: cfg.shards,
  });
  return {
    backend: 'in-memory',
    label: 'in-memory',
    durable: false,
    durability: 'volatile — process memory, not persisted',
    concurrency: 1, // serial store: one transaction at a time
    poolMax: 1,
    connsPerOp: 1,
    mode: cfg.mode,
    gates: cfg.gates,
    economy,
    store,
    workerCtx,
    counters: null,
    teardown: () => store.close(),
  };
}

async function provisionPostgres(cfg: HarnessConfig): Promise<Provisioned> {
  const { digest, clock } = digestAndClock();
  // Fit the pool to the server: a pool the server can't take dies mid-burst as opaque 53300 faults.
  // Clamp while the pool still clears the self-deadlock floor; fail fast when it doesn't.
  const desired = assertPoolSizing(cfg, poolSizeFor(cfg));
  const budget = await postgresPoolBudget(cfg.urls.postgres);
  let poolMax = desired;
  if (budget !== null && budget < desired) {
    const floor = cfg.connsPerOp * cfg.concurrency + 1; // assertPoolSizing's floor
    if (budget < floor) {
      throw new Error(
        `postgres cannot take the bench pool: the server has room for ~${budget} more client ` +
          `connections, but concurrency=${cfg.concurrency} needs >= ${floor} ` +
          `(${cfg.connsPerOp} conns/op x ${cfg.concurrency} + 1). Lower BENCH_CONCURRENCY, close ` +
          `other clients, or raise the server's max_connections.`,
      );
    }
    console.warn(
      `    pool clamped ${desired} -> ${budget} conns — the server only has room for ~${budget} more clients`,
    );
    poolMax = budget;
  }
  const store = await makeIsolatedPostgresStore({
    url: cfg.urls.postgres,
    digest,
    clock,
    poolMax,
    // Fail fast on a routable-but-stalled host so an unreachable backend is skipped, not a hang.
    connectionTimeoutMillis: 5000,
  });
  const { economy, workerCtx } = assemble(store, digest, clock, {
    seed: cfg.seed,
    gates: cfg.gates,
    shards: cfg.shards,
  });
  const probe = await makePostgresCounterProbe(cfg.urls.postgres);
  return {
    backend: 'postgres',
    label: 'postgres',
    durable: true,
    durability: await probePostgresDurability(cfg.urls.postgres),
    concurrency: cfg.concurrency,
    poolMax,
    connsPerOp: cfg.connsPerOp,
    mode: cfg.mode,
    gates: cfg.gates,
    economy,
    store,
    workerCtx,
    counters: probe.read,
    teardown: async () => {
      await probe.close();
      await store.close();
    },
  };
}

async function provisionMysql(cfg: HarnessConfig): Promise<Provisioned> {
  const { digest, clock } = digestAndClock();
  const poolMax = assertPoolSizing(cfg, poolSizeFor(cfg));
  const store = await makeIsolatedMysqlStore({
    url: cfg.urls.mysql,
    digest,
    clock,
    connectionLimit: poolMax,
  });
  const { economy, workerCtx } = assemble(store, digest, clock, {
    seed: cfg.seed,
    gates: cfg.gates,
    shards: cfg.shards,
  });
  const probe = await makeMysqlCounterProbe(cfg.urls.mysql);
  return {
    backend: 'mysql',
    label: 'mysql',
    durable: true,
    durability: await probeMysqlDurability(cfg.urls.mysql),
    concurrency: cfg.concurrency,
    poolMax,
    connsPerOp: cfg.connsPerOp,
    mode: cfg.mode,
    gates: cfg.gates,
    economy,
    store,
    workerCtx,
    counters: probe.read,
    teardown: async () => {
      await probe.close();
      await store.close();
    },
  };
}

// Returns null when the backend's database is unreachable — a skip, not a failure; the rest of the
// run proceeds.
export async function tryProvision(
  backend: BackendName,
  cfg: HarnessConfig,
): Promise<Provisioned | null> {
  try {
    if (cfg.shards > 1) {
      console.warn(`    shards ${cfg.shards}`);
    }
    if (backend === 'in-memory') return await provisionInMemory(cfg);
    if (backend === 'postgres') return await provisionPostgres(cfg);
    return await provisionMysql(cfg);
  } catch (e) {
    console.warn(
      `    SKIP ${backend}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// --- Durability probes: report whether the measured commit is as durable as production ------------

// synchronous_commit and fsync decide whether COMMIT waits for a real disk flush. On macOS, fsync
// does not issue F_FULLFSYNC, so a "durable" local commit is far cheaper than the same setting on
// Linux — which is why the settings are printed.
async function probePostgresDurability(url: string): Promise<string> {
  try {
    const pool = await openPgPool({
      connectionString: url,
      connectionTimeoutMillis: 5000,
    });
    try {
      const ver = (await pool.query('show server_version')).rows[0]
        ?.server_version;
      const sc = (await pool.query('show synchronous_commit')).rows[0]
        ?.synchronous_commit;
      const fsync = (await pool.query('show fsync')).rows[0]?.fsync;
      return `PostgreSQL ${ver}; synchronous_commit=${sc}, fsync=${fsync}`;
    } finally {
      await pool.end();
    }
  } catch {
    return 'durability settings unavailable';
  }
}

// Subtracted from the budget for clients that may connect between the check and the pool filling
// (another run, a psql session, superuser slots).
const POOL_BUDGET_RESERVE = 8;

// How many more client connections the server can take right now; null when the probe fails, so an
// unreadable server changes nothing — the pool is then sized by the formula alone.
async function postgresPoolBudget(url: string): Promise<number | null> {
  try {
    const pool = await openPgPool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      const max = Number(
        (await pool.query('show max_connections')).rows[0]?.max_connections,
      );
      const used = Number(
        (
          await pool.query(
            "select count(*) as used from pg_stat_activity where backend_type = 'client backend'",
          )
        ).rows[0]?.used,
      );
      if (!Number.isFinite(max) || !Number.isFinite(used)) {
        return null;
      }
      return max - used - POOL_BUDGET_RESERVE;
    } finally {
      await pool.end();
    }
  } catch {
    return null;
  }
}

// innodb_flush_log_at_trx_commit=1 and sync_binlog=1 each fsync per commit — with log_bin ON that
// is two fsyncs per commit — so surface all three.
async function probeMysqlDurability(url: string): Promise<string> {
  let pool: Awaited<ReturnType<typeof createMysqlPool>> | undefined;
  try {
    pool = await createMysqlPool(url, { connectionLimit: 1 });
    const [rows] = (await pool.query(
      'select @@version v, @@innodb_flush_log_at_trx_commit f, @@sync_binlog s, @@log_bin l',
    )) as unknown as [Array<Record<string, unknown>>];
    const r = rows[0] ?? {};
    return `MySQL ${r.v}; innodb_flush_log_at_trx_commit=${r.f}, sync_binlog=${r.s}, log_bin=${r.l}`;
  } catch {
    return 'durability settings unavailable';
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

// --- Engine contention counters ----------------------------------------------------
//
// Isolation caveat: MySQL's counter is server-global, Postgres' per-database — a delta is honest
// only while the bench is the sample's sole writer.

// Postgres exposes detected deadlocks as a per-database counter in pg_stat_database; it has no
// lock-wait-timeout counter, so lockWaits stays 0. Each read is its own transaction, so it sees fresh stats.
async function makePostgresCounterProbe(
  url: string,
): Promise<{ read: CounterProbe; close: () => Promise<void> }> {
  const pool = await openPgPool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  // Confirm the counter is readable up front; an unreadable counter means no probe, not a failed run.
  try {
    await pool.query(
      'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()',
    );
  } catch {
    await pool.end().catch(() => {});
    return { read: null, close: async () => {} };
  }
  return {
    read: async () => {
      try {
        const { rows } = await pool.query(
          'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()',
        );
        return { deadlocks: Number(rows[0]?.deadlocks ?? 0), lockWaits: 0 };
      } catch {
        return null;
      }
    },
    close: () => pool.end().catch(() => {}),
  };
}

// MySQL exposes server-global per-error counts in performance_schema (ER_LOCK_DEADLOCK,
// ER_LOCK_WAIT_TIMEOUT). Returns null on read if performance_schema is off, so the report says "n/a"
// rather than a wrong zero.
async function makeMysqlCounterProbe(
  url: string,
): Promise<{ read: CounterProbe; close: () => Promise<void> }> {
  const SQL =
    'SELECT error_name, sum_error_raised FROM performance_schema.events_errors_summary_global_by_error ' +
    "WHERE error_name IN ('ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT')";
  let pool: Awaited<ReturnType<typeof createMysqlPool>> | undefined;
  try {
    pool = await createMysqlPool(url, { connectionLimit: 1 });
    await pool.query(SQL);
  } catch {
    if (pool) await pool.end().catch(() => {});
    return { read: null, close: async () => {} };
  }
  const open = pool;
  return {
    read: async () => {
      try {
        const [rows] = (await open.query(SQL)) as unknown as [
          Array<Record<string, unknown>>,
        ];
        let deadlocks = 0;
        let lockWaits = 0;
        for (const r of rows) {
          const n = Number(r.sum_error_raised ?? 0);
          if (r.error_name === 'ER_LOCK_DEADLOCK') deadlocks = n;
          else if (r.error_name === 'ER_LOCK_WAIT_TIMEOUT') lockWaits = n;
        }
        return { deadlocks, lockWaits };
      } catch {
        return null;
      }
    },
    close: () => open.end().catch(() => {}),
  };
}

// After - before, floored at 0 per field so a counter reset never reports a negative delta; null
// when either endpoint is missing, so the report shows "n/a" rather than a fabricated number.
export function counterDelta(
  before: EngineCounters | null,
  after: EngineCounters | null,
): EngineCounters | null {
  if (!before || !after) return null;
  return {
    deadlocks: Math.max(0, after.deadlocks - before.deadlocks),
    lockWaits: Math.max(0, after.lockWaits - before.lockWaits),
  };
}

// --- Timing ------------------------------------------------------------------------

const nowMs = (): number => performance.now();

// The fastest of `reps` runs is the cleanest single number under GC and JIT noise.
export async function bestMs(
  reps: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = nowMs();
    await fn();
    best = Math.min(best, nowMs() - t0);
  }
  return best;
}

// A rejected op writes no legs and is far cheaper than a commit, so timing it would inflate the
// rate; every timer counts committed ops only.
export const isCommitted = (r: unknown): boolean =>
  (r as { status?: string } | null)?.status === 'committed';

// --- Outcome / fault classification ------------------------------------------------
//
// A submit ends exactly one of four ways: `committed` (money moved), `duplicate` (idempotency
// replay), `rejected` (a normal "no", no money moved), or a thrown fault (see classifyThrow).
export type OutcomeClass =
  | { status: 'committed' }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

export function classifyOutcome(out: unknown): OutcomeClass {
  const o = out as { status?: string; reason?: string } | null;
  if (o?.status === 'committed') return { status: 'committed' };
  if (o?.status === 'duplicate') return { status: 'duplicate' };
  return { status: 'rejected', reason: o?.reason ?? 'rejected' };
}

// Prefer mysql2's numeric `errno`, then pg's SQLSTATE `code`, so the report shows the real driver code.
function throwCode(err: unknown): string {
  const e = err as { errno?: unknown; code?: unknown } | null;
  if (e?.errno !== undefined && e?.errno !== null) return `errno ${e.errno}`;
  if (e?.code !== undefined && e?.code !== null) return String(e.code);
  return 'fault';
}

// Mapped to the same categories the engines' isTransientConflict recognizes, so the bench never
// prints "deadlock" for what is actually a chain-fork or pool starvation. A `threw` op escaped the
// engine's retry budget (or was never retryable).
export type ThrowClass =
  | 'deadlock'
  | 'lock-wait-timeout'
  | 'serialization'
  | 'chain-fork'
  | 'chain-continuity'
  | 'pool-timeout'
  | 'other-fault';

export type ThrowInfo = { klass: ThrowClass; code: string; label: string };

// 1062/1644 are the chain races only when the message names the fork index / continuity marker —
// else a real duplicate or conservation fault that must not be softened. Null when not a MySQL error.
function mysqlThrowClass(errno: unknown, text: string): ThrowClass | null {
  if (errno === 1213) return 'deadlock';
  if (errno === 1205) return 'lock-wait-timeout';
  if (errno === 1062)
    return text.includes(CHAIN_FORK_INDEX) ? 'chain-fork' : 'other-fault';
  if (errno === 1644)
    return text.includes(CHAIN_CONTINUITY_MARKER)
      ? 'chain-continuity'
      : 'other-fault';
  return null;
}

// pg surfaces the conflict as a SQLSTATE `code`; 23505 is the chain fork only on the chain-head
// constraint, and P0001 is continuity only with the marker (else a real conservation/balance fault).
// Returns null when this is not a matching Postgres error.
function pgThrowClass(
  code: unknown,
  constraint: unknown,
  text: string,
): ThrowClass | null {
  if (code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization';
  if (code === '23505')
    return constraint === CHAIN_FORK_INDEX ? 'chain-fork' : 'other-fault';
  if (code === 'P0001')
    return text.includes(CHAIN_CONTINUITY_MARKER)
      ? 'chain-continuity'
      : 'other-fault';
  return null;
}

// A connection-acquisition timeout: pg rejects with this exact message and no SQLSTATE; mysql2 surfaces
// a pool/queue-limit code. This is the symptom of a pool too small for the concurrency.
function isPoolTimeout(code: unknown, text: string): boolean {
  return (
    text.includes('timeout exceeded when trying to connect') ||
    code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    code === 'ER_CON_COUNT_ERROR'
  );
}

export function classifyThrow(err: unknown): ThrowInfo {
  const e = err as {
    errno?: unknown;
    code?: unknown;
    constraint?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  } | null;
  const text = String(e?.sqlMessage ?? e?.message ?? '');
  const raw = throwCode(err);
  const klass: ThrowClass =
    mysqlThrowClass(e?.errno, text) ??
    pgThrowClass(e?.code, e?.constraint, text) ??
    (isPoolTimeout(e?.code, text) ? 'pool-timeout' : 'other-fault');
  return { klass, code: raw, label: `${klass} (${raw})` };
}

// --- Latency distribution ----------------------------------------------------------
//
// A best-of-N mean hides the stalls a stress bench exists to expose, so the per-op latency
// distribution (committed ops only) is reported too.
export type LatencyDist = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

// Nearest-rank percentile over an ascending-sorted array; p in [0,100]. Empty input is 0.
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

export function latencyDist(samples: number[]): LatencyDist {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

// --- Retry pressure ----------------------------------------------------------------
//
// What withTransientRetry absorbed during a sample: `recovered` ops retried then committed;
// `exhausted` ops ran out the budget and threw (also counted in the `threw` tally).
export type RetryPressure = {
  retries: number;
  recovered: number;
  exhausted: number;
};

// One op at a time, best of `reps`, each rep capped at `budgetMs` — the latency-bound number.
// Committed ops only; any non-commit is surfaced loudly.
export async function measureSequential(
  cfg: HarnessConfig,
  perOp: (k: number) => Promise<unknown>,
): Promise<number> {
  let bestPerOp = Infinity;
  let rejected = 0;
  for (let r = 0; r < cfg.reps; r++) {
    const t0 = nowMs();
    let done = 0;
    for (let i = 0; i < cfg.ops; i++) {
      if (isCommitted(await perOp(r * cfg.ops + i))) done += 1;
      else rejected += 1;
      if (nowMs() - t0 > cfg.budgetMs) break;
    }
    if (done > 0) bestPerOp = Math.min(bestPerOp, (nowMs() - t0) / done);
  }
  if (rejected > 0) {
    console.warn(
      `      WARNING: ${rejected} ops did not commit — the rate is over committed ops only; check funding/gates`,
    );
  }
  return bestPerOp === Infinity ? 0 : 1000 / bestPerOp;
}

// Throughput over committed ops, plus the breakdown to trust it. `errors` is rejected+threw combined.
export type ConcurrentResult = {
  rate: number;
  completed: number;
  committed: number;
  duplicate: number;
  rejected: number;
  threw: number;
  rejectReasons: Record<string, number>;
  throwClasses: Record<string, number>;
  errors: number;
  latency: LatencyDist;
  retries: RetryPressure;
  dbCounters: EngineCounters | null;
};

// Up to `concurrency` submits in flight, refilled as each completes, best of `reps`, capped at
// `budgetMs`. In-flight ops let a durable SQL engine overlap round trips and group-commit, so con
// can beat seq. A perOp that throws is classified and the run continues; committed ops only.
export async function measureConcurrent(
  cfg: HarnessConfig,
  concurrency: number,
  perOp: (k: number) => Promise<unknown>,
  counters?: CounterProbe,
): Promise<ConcurrentResult> {
  const inFlight = Math.max(1, concurrency);
  let bestPerOp = Infinity;
  let lastCompleted = 0;
  let committed = 0;
  let duplicate = 0;
  let rejected = 0;
  let threw = 0;
  const rejectReasons: Record<string, number> = {};
  const throwClasses: Record<string, number> = {};
  const latencies: number[] = [];

  // Scope the observer and counter delta to this sample; the previous observer is restored in `finally`.
  const retries: RetryPressure = { retries: 0, recovered: 0, exhausted: 0 };
  const prevObserver = setRetryObserver((event) => {
    if (event.type === 'retry') retries.retries += 1;
    else if (event.type === 'recovered') retries.recovered += 1;
    else if (event.type === 'exhausted') retries.exhausted += 1;
  });
  const before = counters ? await counters() : null;

  try {
    for (let r = 0; r < cfg.reps; r++) {
      const t0 = nowMs();
      let next = 0;
      let done = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          if (i >= cfg.ops || nowMs() - t0 > cfg.budgetMs) return;
          // Latency includes queueing within the in-flight window; recorded for committed ops only.
          const started = nowMs();
          try {
            const out = await perOp(r * cfg.ops + i);
            const klass = classifyOutcome(out);
            if (klass.status === 'committed') {
              done += 1;
              committed += 1;
              latencies.push(nowMs() - started);
            } else if (klass.status === 'duplicate') {
              duplicate += 1;
            } else {
              rejected += 1;
              rejectReasons[klass.reason] =
                (rejectReasons[klass.reason] ?? 0) + 1;
            }
          } catch (error) {
            threw += 1;
            const { label } = classifyThrow(error);
            throwClasses[label] = (throwClasses[label] ?? 0) + 1;
          }
        }
      };
      await Promise.all(Array.from({ length: inFlight }, worker));
      if (done > 0) bestPerOp = Math.min(bestPerOp, (nowMs() - t0) / done);
      lastCompleted = done;
    }
  } finally {
    setRetryObserver(prevObserver);
  }

  const after = counters ? await counters() : null;
  return {
    rate: bestPerOp === Infinity ? 0 : 1000 / bestPerOp,
    completed: lastCompleted,
    committed,
    duplicate,
    rejected,
    threw,
    rejectReasons,
    throwClasses,
    errors: rejected + threw,
    latency: latencyDist(latencies),
    retries,
    dbCounters: counterDelta(before, after),
  };
}

// --- Provability -------------------------------------------------------------------

export type ProveResult = { ok: boolean; report: ProveReport };

// Re-derive every invariant over the whole ledger: a reported number comes from a ledger that just
// passed its own audit.
export async function proveEconomyOrReport(
  economy: Economy,
): Promise<ProveResult> {
  const report = await economy.read.prove();
  return { ok: allInvariantsHold(report), report };
}

// Prints the verdict under the caller's label and returns pass/fail so the caller can flip its exit code.
export async function proveGate(
  p: Provisioned,
  label: string,
): Promise<boolean> {
  const { ok, report } = await proveEconomyOrReport(p.economy);
  if (ok) {
    console.warn(`${label}PASS — every invariant holds`);
  } else {
    console.warn(`${label}FAIL — ${JSON.stringify(report)}`);
  }
  return ok;
}

// --- Cross-engine determinism ------------------------------------------------------

// The Merkle root over every account's chain head — equal hex means byte-identical ledgers, since
// merkleRoot sorts leaves by account id. Only meaningful over a fixed sequence; the concurrent
// sample is order-nondeterministic.
export async function determinismRoot(p: Provisioned): Promise<string> {
  const heads: Array<readonly [AccountRef, string]> = [];
  for await (const pair of p.store.ledger.heads()) heads.push(pair);
  return toHex(await merkleRoot(p.workerCtx.digest, heads));
}

// --- Output ------------------------------------------------------------------------

export const num = (n: number): string => Math.round(n).toLocaleString('en-US');
export const rate = (n: number | null): string => (n === null ? 'n/a' : num(n));
export const ms = (n: number): string => n.toFixed(n < 10 ? 2 : 1);

// Parse the URL so the WHOLE password is masked even when it contains a literal `@` or `:` (a regex
// stopping at the first `@` would leak the tail); fall back to substitution when it doesn't parse.
export const maskUrl = (url: string): string => {
  try {
    const u = new URL(url);
    if (!u.password) return url;
    u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:[^:@/]*@/, ':***@');
  }
};

export function urlFor(cfg: HarnessConfig, backend: BackendName): string {
  return maskUrl(backend === 'postgres' ? cfg.urls.postgres : cfg.urls.mysql);
}

export function printTable(
  title: string,
  headers: string[],
  rows: string[][],
): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ');
  console.warn(`\n${title}`);
  console.warn(line(headers));
  console.warn(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.warn(line(r));
}

// Writes to BENCH_JSON_PATH when set, else stdout — human narration goes to stderr via console.warn,
// so stdout stays machine-clean.
export async function emitJson(
  cfg: HarnessConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  if (cfg.output === 'table') return;
  const body = JSON.stringify(
    {
      tool: 'economy-lab',
      node: process.version,
      profile: cfg.profile,
      ...payload,
    },
    null,
    2,
  );
  if (cfg.jsonPath) {
    await writeFile(cfg.jsonPath, body + '\n');
    console.warn(`\nwrote JSON results to ${cfg.jsonPath}`);
  } else {
    process.stdout.write(body + '\n');
  }
}
