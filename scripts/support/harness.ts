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

// Shared harness for the lab's performance scripts (scripts/bench.ts, scripts/scale-probe.ts), so both
// measure the same way against the same backends with the same knobs. What it standardizes:
//   - Reseed: every SQL run gets its own throwaway schema (Postgres) / database (MySQL), created fresh
//     and dropped on teardown, so no run inherits another's rows. Reuses the conformance suite's
//     isolation (test/support/adapters.ts) — JS drivers only, no psql/mysql binaries.
//   - Provable: proveEconomy re-derives every invariant after the workload, so a reported number comes
//     from a ledger that just passed its audit. Deterministic doubles make the sequential samples
//     reproducible; the concurrent SQL sample is order-nondeterministic by design.
//   - Portable: point DATABASE_URL / the BENCH_* URLs at anything (local, the compose stack, a remote
//     host); each backend's live durability settings are reported so a number's meaning is visible.
//   - Fine-tuned: every dial is an env var with a profile default, resolved in resolveConfig.
//     BENCH_SHARDS sets PLATFORM_SHARDS for the measured economy (default 1, the unsharded ledger),
//     so a run can measure the hot platform accounts split across N rows.

import { writeFile } from 'node:fs/promises';

import { createEconomy, memoryStore, workerCtxFrom } from '#src/index.ts';
import { createMysqlPool } from '#src/engines/mysql.ts';
import { loadConfig } from '#src/config.ts';
import { sha256Digest } from '#src/digest.ts';
import { allInvariantsHold } from '#src/integrity.ts';
import { merkleRoot } from '#src/chain.ts';
import { toHex } from '#src/bytes.ts';
// The chain-fork index name and continuity-trigger marker the engines match transient conflicts on,
// reused here so the bench classifies a thrown driver code (1062 / 23505 / 1644 / P0001) into the same
// real cause the retry path recognizes. setRetryObserver lets the bench count the retries the engine's
// transaction wrapper absorbs (see RetryPressure).
import {
  CHAIN_CONTINUITY_MARKER,
  CHAIN_FORK_INDEX,
  setRetryObserver,
} from '#src/engines/sql-shared.ts';
// The isolated, reseed-on-create, drop-on-close store provisioning is shared with the conformance
// matrix (test/support/adapters.ts) — the same throwaway schema/database discipline, parameterized
// by digest/clock and pool size. The harness just passes the production digest and a pool sized to
// its concurrency.
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
import type { Economy, ProveReport, WorkerCtx } from '#src/index.ts';

// The three storage backends a performance script can target. 'in-memory' always runs (no infra);
// the SQL backends run when their database is reachable, and are skipped otherwise (see tryProvision).
export type BackendName = 'in-memory' | 'postgres' | 'mysql';

// Whether the run funds subjects so every op can commit (`throughput` — any rejection is then a bug
// the bench shouts about) or deliberately oversubscribes a small subject pool to provoke contention
// (`contention` — rejections and retries are the measured signal, not noise). The mode is explicit so
// a contended number is never mistaken for a clean ceiling. See measureKind/spendKind in bench.ts.
export type BenchMode = 'throughput' | 'contention';

// Whether the policy gates (maturity hold, velocity limit, payout interval/minimum) are neutralized
// (`off` — measures pure ledger work, the historical default) or set to realistic production values
// (`on` — measures the gated cost a real op pays). The velocity *record* runs in both modes, inside
// every gated kind's money transaction; `on` additionally lets the limit deny.
export type GatesMode = 'off' | 'on';

export type HarnessConfig = {
  ops: number; // measured ops per throughput sample
  reps: number; // a throughput number is the best (fastest) of this many runs
  warmup: number; // discarded ops before timing, to let the JIT settle
  concurrency: number; // in-flight submits for the concurrent/pipelined sample
  budgetMs: number; // per-sample time cap, so a slow backend bounds its own run
  backends: BackendName[]; // which backends to attempt, in order
  output: 'table' | 'json' | 'both'; // human table, machine JSON, or both
  jsonPath: string | null; // where JSON goes; null = stdout
  seed: number; // sequential-id seed, for reproducible ids
  profile: string; // the named profile that set the defaults
  mode: BenchMode; // throughput (fund everything) or contention (oversubscribe on purpose)
  gates: GatesMode; // policy gates neutralized (off) or realistic (on)
  shards: number; // PLATFORM_SHARDS for the measured economy (BENCH_SHARDS); 1 = unsharded
  // Pool sizing: an in-flight op holds one pooled connection for its money transaction, which
  // carries the velocity record too. Brief pool borrows (first-use row plants, a rollback's
  // re-record) ride the headroom. The pool covers connsPerOp×concurrency + headroom, explicit
  // and asserted.
  connsPerOp: number; // pooled connections one in-flight op holds
  poolHeadroom: number; // spare connections above connsPerOp×concurrency (borrows, probes, seal)
  poolMax: number | null; // explicit pool-size override; null = derive from the formula above
  urls: { postgres: string; mysql: string }; // production-faithful: point these anywhere
  // Integrity-curve knobs (scripts/bench.ts): a fixed user set so accounts stay flat while postings grow.
  curveUsers: number;
  curveSizes: number[];
  curveReps: number;
  // Scale-probe knobs (scripts/scale-probe.ts): segment count and size for the history-growth curve.
  segments: number;
  segmentSize: number;
};

// Named profiles set a coherent batch of defaults so "make it quick" or "make it thorough" is one
// knob, not six. An explicit env var still wins over the profile (see resolveConfig). 'default'
// matches the historical bench sample sizes.
const PROFILES: Record<string, Partial<HarnessConfig>> = {
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

// Build the Config the lab measures under, parsed through the real loadConfig so it can't drift from
// production. Gates are either neutralized (`off`, the default) so a burst reflects ledger work, or set
// to realistic values (`on`) to show the gated cost. The velocity *record* runs in both modes (the
// record every gated op makes, inside its money transaction); `off` only stops the limit from denying.
// `shards` becomes PLATFORM_SHARDS, so a sharded run routes the hot platform accounts exactly the way
// production would.
function buildBenchConfig(
  gates: GatesMode,
  shards: number,
): ReturnType<typeof loadConfig> {
  const secrets = {
    WEBHOOK_SECRET: 'bench-webhook-secret',
    SIGNING_SECRET: 'bench-signing-secret',
  };
  if (gates === 'on') {
    // Realistic velocity limit so the gate compares against a production-shaped ceiling. Maturity stays
    // 0: on the lab's fixed clock a non-zero hold would immature every payout (a clock artifact, not a
    // real cost), so exercising maturity needs an advancing clock — a separate run shape.
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

const intEnv = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

// Resolve every knob from env, layering: hard defaults < named profile < explicit env var. The
// profile is BENCH_PROFILE (fast|default|thorough); anything it sets can still be overridden by its
// own env var, so `BENCH_PROFILE=thorough BENCH_OPS=300` means "thorough, but 300 ops".
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): HarnessConfig {
  const profileName = env.BENCH_PROFILE ?? 'default';
  const profile = PROFILES[profileName] ?? PROFILES.default!;
  const base = { ...PROFILES.default!, ...profile };

  const backends = (env.BENCH_BACKENDS ?? 'in-memory,postgres,mysql')
    .split(',')
    .map((s) => s.trim())
    .filter(
      (s): s is BackendName =>
        s === 'in-memory' || s === 'postgres' || s === 'mysql',
    );

  const output = ((): HarnessConfig['output'] => {
    const o = env.BENCH_OUTPUT;
    return o === 'json' || o === 'both' ? o : 'table';
  })();

  const mode: BenchMode =
    env.BENCH_MODE === 'contention' ? 'contention' : 'throughput';
  const gates: GatesMode = env.BENCH_GATES === 'on' ? 'on' : 'off';

  return {
    ops: intEnv(env.BENCH_OPS, base.ops!),
    reps: intEnv(env.BENCH_REPS, base.reps!),
    warmup: intEnv(env.BENCH_WARMUP, base.warmup!),
    concurrency: intEnv(env.BENCH_CONCURRENCY, base.concurrency!),
    budgetMs: intEnv(env.BENCH_BUDGET_MS, 5000),
    backends: backends.length > 0 ? backends : ['in-memory'],
    output,
    jsonPath: env.BENCH_JSON_PATH ?? null,
    seed: intEnv(env.BENCH_SEED, 1),
    profile: profileName in PROFILES ? profileName : 'default',
    mode,
    gates,
    shards: intEnv(env.BENCH_SHARDS, 1),
    // Default to 1: the velocity record rides the money transaction, so an in-flight op holds
    // one connection. Its brief borrows ride the headroom.
    connsPerOp: intEnv(env.BENCH_CONNS_PER_OP, 1),
    poolHeadroom: intEnv(env.BENCH_POOL_HEADROOM, 4),
    poolMax: env.BENCH_POOL_MAX ? intEnv(env.BENCH_POOL_MAX, 0) || null : null,
    urls: resolveUrls(env),
    curveUsers: intEnv(env.BENCH_CURVE_USERS, 20),
    curveSizes: base.curveSizes!,
    curveReps: intEnv(env.BENCH_CURVE_REPS, 2),
    segments: intEnv(env.SEGMENTS, base.segments!),
    segmentSize: intEnv(env.SEG, base.segmentSize!),
  };
}

// --- Pool sizing -----------------------------------------------------------------

// The smallest pool that will not self-deadlock for this config (see the connsPerOp note on
// HarnessConfig): connsPerOp × concurrency, plus headroom.
export function requiredPoolSize(cfg: HarnessConfig): number {
  return cfg.connsPerOp * cfg.concurrency + cfg.poolHeadroom;
}

// The pool size to actually provision: the explicit BENCH_POOL_MAX override when set (so an operator
// can probe a deliberately undersized pool), else the derived size. Either way assertPoolSizing checks it.
export function poolSizeFor(cfg: HarnessConfig): number {
  return cfg.poolMax ?? requiredPoolSize(cfg);
}

// Fail fast (rather than hang) when a pool is too small. Below the floor connsPerOp×concurrency
// + 1, the in-flight transactions can take every connection, and their brief pool borrows then
// block forever: a silent hang that looks like a wedged database. Returns the size on success.
export function assertPoolSizing(cfg: HarnessConfig, poolMax: number): number {
  const floor = cfg.connsPerOp * cfg.concurrency + 1;
  if (poolMax < floor) {
    throw new Error(
      `pool too small: poolMax=${poolMax} but concurrency=${cfg.concurrency} × ${cfg.connsPerOp} conns/op ` +
        `needs ≥ ${floor} (recommended ${requiredPoolSize(cfg)} = ${cfg.connsPerOp}×${cfg.concurrency} + ${cfg.poolHeadroom} headroom). ` +
        `In-flight transactions must leave a free connection for their brief pool borrows, ` +
        `so a pool sized below the concurrency deadlocks. Raise BENCH_POOL_MAX/BENCH_POOL_HEADROOM or lower BENCH_CONCURRENCY.`,
    );
  }
  return poolMax;
}

// `pg` treats postgres:// and postgresql:// as the same, so accept both. Mirrors selectStore in
// src/index.ts, so the bench reaches the same database the app would.
export function resolveUrls(env: Record<string, string | undefined>): {
  postgres: string;
  mysql: string;
} {
  const dbUrl = env.DATABASE_URL ?? '';
  const dbIsPostgres =
    dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');
  const dbIsMysql = dbUrl.startsWith('mysql://');
  const pg = env.BENCH_POSTGRES_URL ?? (dbIsPostgres ? dbUrl : '');
  const my =
    env.BENCH_MYSQL_URL ?? env.MYSQL_TEST_URL ?? (dbIsMysql ? dbUrl : '');
  return {
    postgres:
      pg !== '' ? pg : 'postgres://economy:economy@localhost:5432/economy_lab',
    mysql: my !== '' ? my : 'mysql://root:economy@localhost:3306/economy_lab',
  };
}

// --- Provisioning: a fresh, isolated, reseeded economy per backend ----------------

// The engine's own contention counters, read from the database not guessed app-side: `deadlocks`
// (MySQL ER_LOCK_DEADLOCK / Postgres pg_stat_database.deadlocks) and `lockWaits` (MySQL
// ER_LOCK_WAIT_TIMEOUT; Postgres has none, stays 0). They count even deadlocks a retry recovered — the
// contention a clean number hides. Cumulative; the bench reads a Δ per sample (see counterDelta).
export type EngineCounters = { deadlocks: number; lockWaits: number };

// Reads the engine counters now, or null when the engine has no counter or the probe failed. Held open
// for the whole run on its own connection, outside the bench's pool, so it never steals a bench connection.
export type CounterProbe = (() => Promise<EngineCounters | null>) | null;

// A ready-to-drive economy plus what the harness needs to report and clean it up. `teardown` drops
// the throwaway schema/database (SQL) or releases the store (in-memory), so a run leaves nothing
// behind.
export type Provisioned = {
  backend: BackendName;
  label: string;
  durable: boolean; // whether a committed op survives process exit (false for in-memory)
  durability: string; // human note: engine version + the commit-durability settings, probed live
  // In-memory store runs one transaction at a time, so its concurrency is 1; SQL engines overlap via the pool.
  concurrency: number;
  poolMax: number; // the pool the store was built with (1 for in-memory's serial store)
  connsPerOp: number; // peak pooled connections one op holds, for the report and the sizing assertion
  mode: BenchMode; // throughput or contention — carried so the report can label the run
  gates: GatesMode; // off or on — carried so the report can label the run
  economy: Economy;
  store: Store; // exposed for integrity-curve work (sealCheckpoint / reverifyCheckpoint)
  workerCtx: WorkerCtx; // the runtime services a checkpoint seal/verify needs, over this same store
  counters: CounterProbe; // read the engine's own deadlock/lock-wait counters; null for in-memory
  teardown: () => Promise<void>;
};

// The digest and clock must be the same instances the store was built with, so the chain heads agree.
// `opts.seed` seeds the deterministic ids; `opts.gates` selects whether the policy gates are
// neutralized or realistic; `opts.shards` is the platform-shard count (see buildBenchConfig).
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
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    pricing: defaultPricing(),
    config: buildBenchConfig(opts.gates, opts.shards),
  };
  return { economy: createEconomy(caps), workerCtx: workerCtxFrom(caps) };
}

// Use the production digest (the synchronous node:crypto SHA-256, ~5x faster than Web Crypto for
// these small preimages), not the test seededDigest — the bench must measure the code path production
// runs, and the chain hash is on the hot path of every submit and every prove/seal. A fixed clock
// plus sequential ids still make a run reproducible; the digest is plain SHA-256, so its output is
// deterministic from those deterministic inputs anyway.
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
    connsPerOp: 1, // no pool; one transaction at a time
    mode: cfg.mode,
    gates: cfg.gates,
    economy,
    store,
    workerCtx,
    counters: null, // no engine deadlock counter to read
    teardown: () => store.close(),
  };
}

async function provisionPostgres(cfg: HarnessConfig): Promise<Provisioned> {
  const { digest, clock } = digestAndClock();
  // Size the pool for the concurrency (one held connection per op) and assert it before opening (see assertPoolSizing).
  // Then fit it to the server: a pool the shared server can't take dies mid-burst as opaque 53300
  // faults. Clamp while the pool still clears the self-deadlock floor; fail fast with the numbers
  // when it doesn't. The budget is a snapshot; postgresPoolBudget's reserve absorbs late arrivals.
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
      await store.close(); // drops the throwaway schema
    },
  };
}

async function provisionMysql(cfg: HarnessConfig): Promise<Provisioned> {
  const { digest, clock } = digestAndClock();
  // connectionLimit is sized for the concurrency and asserted, as Postgres' poolMax is above.
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
      await store.close(); // drops the throwaway database
    },
  };
}

// Provision one backend, or return null when its database is unreachable (refused connection,
// missing role, unmigrated host). An unreachable SQL backend is a skip, not a failure, exactly as
// `make smoke` treats it — the rest of the run still proceeds.
export async function tryProvision(
  backend: BackendName,
  cfg: HarnessConfig,
): Promise<Provisioned | null> {
  try {
    // A sharded run says so next to the backend's connection/durability lines. At the default of 1
    // the output is unchanged, byte for byte.
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

// Postgres durability is whatever the server is configured for. A bench number only means what its
// durability says it means, so surface it: synchronous_commit and fsync are the two switches that
// decide whether COMMIT waits for a real disk flush. (On macOS, fsync does not issue F_FULLFSYNC, so
// a "durable" local commit is far cheaper than the same setting on Linux — which is exactly why this
// is worth printing.)
async function probePostgresDurability(url: string): Promise<string> {
  try {
    // Variable specifier so the type-checker doesn't try to resolve this optional, untyped driver at
    // build time — the same trick createMysqlPool uses for mysql2.
    const specifier = 'pg';
    const pg = (await import(/* @vite-ignore */ specifier)) as unknown as {
      Pool: new (c: {
        connectionString: string;
        connectionTimeoutMillis?: number;
      }) => {
        query: (
          sql: string,
        ) => Promise<{ rows: Array<Record<string, string>> }>;
        end: () => Promise<void>;
      };
    };
    const pool = new pg.Pool({
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

// Clients that may connect between the budget check and the pool filling up (another run starting,
// a psql session, superuser slots). Subtracted from the budget so the check doesn't hand out the
// server's last few connections.
const POOL_BUDGET_RESERVE = 8;

// How many more client connections the server can take right now: max_connections minus the clients
// already connected, minus the reserve above. Null when the probe fails (no permissions, unreachable),
// so an unreadable server changes nothing — the pool is then sized by the formula alone, as before.
async function postgresPoolBudget(url: string): Promise<number | null> {
  try {
    const specifier = 'pg';
    const pg = (await import(/* @vite-ignore */ specifier)) as unknown as {
      Pool: new (c: {
        connectionString: string;
        max?: number;
        connectionTimeoutMillis?: number;
      }) => {
        query: (
          sql: string,
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
        end: () => Promise<void>;
      };
    };
    const pool = new pg.Pool({
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

// MySQL durability is set by two switches: innodb_flush_log_at_trx_commit=1 flushes+fsyncs the redo
// log per commit, and sync_binlog=1 fsyncs the binary log per commit — so with log_bin ON that is two
// fsyncs per commit. Surface all three, over a brief single connection (these are server globals).
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
// The only honest deadlock number is the database's own counter (the app can't see one a retry already
// recovered). Each probe holds one connection for the whole run, outside the bench's pool, and the
// bench takes a Δ per sample. Isolation caveat: MySQL's counter is server-global, Postgres' is
// per-database; the Δ is honest as long as the bench is the only writer for the sample's duration,
// which holds for a normal `make bench` run.

// Postgres exposes detected deadlocks as a per-database counter in pg_stat_database; it has no
// lock-wait-timeout counter, so lockWaits stays 0. Each read is its own transaction, so it sees fresh stats.
async function makePostgresCounterProbe(
  url: string,
): Promise<{ read: CounterProbe; close: () => Promise<void> }> {
  const specifier = 'pg';
  const pg = (await import(/* @vite-ignore */ specifier)) as unknown as {
    Pool: new (c: {
      connectionString: string;
      max?: number;
      connectionTimeoutMillis?: number;
    }) => {
      query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
      end: () => Promise<void>;
    };
  };
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  // Confirm the counter is readable up front; if it is not (permissions, an ancient server), report no
  // probe rather than failing the whole run, so the bench still prints its other numbers.
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

// The change in the engine's counters across a sample: after − before, floored at 0 per field so a
// counter reset (or a missing read) can never report a negative or spurious delta. Returns null when
// either endpoint is missing, so the report shows "n/a" rather than a fabricated number.
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

// Run `fn` `reps` times and return the fastest, in ms. The fastest run is the cleanest single number
// under GC and JIT noise.
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

// True only when a submit actually committed. `economy.submit()` returns `{status:'rejected'|
// 'duplicate'}` without throwing, and a rejected op writes no legs and is far cheaper than a commit —
// so counting it as a timed op would inflate the rate with work that never happened. Every timer
// counts committed ops only.
export const isCommitted = (r: unknown): boolean =>
  (r as { status?: string } | null)?.status === 'committed';

// --- Outcome / fault classification ------------------------------------------------
//
// A submit ends in exactly one of four ways, and conflating them is how the old bench lied: `committed`
// (money moved), `duplicate` (an idempotency replay — should be 0 with unique ids), `rejected` (a normal
// "no" with a RejectionCode, no money moved), or a thrown fault (classified by classifyThrow).
export type OutcomeClass =
  | { status: 'committed' }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

export function classifyOutcome(out: unknown): OutcomeClass {
  const o = out as { status?: string; reason?: string } | null;
  if (o?.status === 'committed') return { status: 'committed' };
  if (o?.status === 'duplicate') return { status: 'duplicate' };
  // Anything else is a rejection; carry its reason, defaulting only if the shape is unexpected.
  return { status: 'rejected', reason: o?.reason ?? 'rejected' };
}

// Engine-agnostic raw label for a thrown fault: prefer mysql2's numeric `errno`, then pg's SQLSTATE
// `code`, so the report can always show the real driver code (e.g. "errno 1062", "40P01") rather than
// a guessed category. classifyThrow wraps this with the semantic class.
function throwCode(err: unknown): string {
  const e = err as { errno?: unknown; code?: unknown } | null;
  if (e?.errno !== undefined && e?.errno !== null) return `errno ${e.errno}`;
  if (e?.code !== undefined && e?.code !== null) return String(e.code);
  return 'fault';
}

// The real cause of a thrown fault, mapped to the SAME categories the engines' own isTransientConflict
// recognizes — so the bench never prints "deadlock" for what is actually a chain-fork or pool
// starvation. A `threw` op escaped the engine's retry budget (or was never retryable); under correct
// funding and pool sizing this set is small. Per-engine code mappings are in mysqlThrowClass /
// pgThrowClass / isPoolTimeout below.
export type ThrowClass =
  | 'deadlock'
  | 'lock-wait-timeout'
  | 'serialization'
  | 'chain-fork'
  | 'chain-continuity'
  | 'pool-timeout'
  | 'other-fault';

export type ThrowInfo = { klass: ThrowClass; code: string; label: string };

// mysql2 surfaces the conflict as a numeric `errno`; the 1062/1644 cases are only the chain races when
// the message names the fork index / continuity marker (else they are a genuine duplicate or a real
// conservation/balance fault, which must not be softened). Returns null when this is not a MySQL error.
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
// A best-of-N mean hides the stalls a stress bench exists to expose, so the bench also reports the per-op
// latency distribution (over committed ops only). A fat p99/max next to a healthy p50 is contention the
// mean would have smoothed away.
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
// What withTransientRetry absorbed during a sample (via setRetryObserver): `retries` total re-attempts,
// `recovered` ops that retried then committed (the hidden cost of a clean-looking number), `exhausted`
// ops that retried out the budget then threw (also in the `threw` tally). The contention throughput hides.
export type RetryPressure = {
  retries: number;
  recovered: number;
  exhausted: number;
};

// Sequential throughput in ops/sec: one op at a time, best of `reps`, each capped at `budgetMs`. The
// latency-bound number — each op pays a full round trip + commit with nothing overlapped. Only committed
// ops count; any non-commit is surfaced loudly, since a correctly-funded run should have none.
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

// What a concurrent sample produced: throughput over committed ops, plus the breakdown to trust it.
// Every op is tallied into committed / duplicate / rejected / threw (classifyOutcome + classifyThrow),
// with `rejectReasons` / `throwClasses` naming which. `latency`, `retries`, and `dbCounters` carry what
// the app can't see itself (the engine's own deadlock Δ included). `errors` is the legacy rejected+threw.
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

// Concurrent (pipelined) throughput: up to `concurrency` submits in flight, refilled as each completes,
// best of `reps`, capped at `budgetMs`. In-flight ops let a durable SQL engine overlap round trips and
// group-commit, so it can beat the sequential rate; in-memory (serial, concurrency 1) tracks sequential.
// A perOp that throws is classified and the run continues; the rate is over committed ops only.
//
// `counters`, when given, is read before and after the sample for the engine's own deadlock Δ. The retry
// observer is installed for the sample and restored after, so its retries never leak into another tally.
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

  // Capture the retry pressure withTransientRetry absorbs, and the engine's own deadlock counter, only
  // across this sample. setRetryObserver returns the previous observer so it is restored in `finally`.
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
          // Time each op around the submit so the latency distribution is the real cost under load
          // (queueing within the in-flight window included), recorded for committed ops only.
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

// Re-derive every invariant over the whole ledger (conservation, backing, no overdraft, an intact
// hash chain re-walked from genesis, and balances that match their legs). This is the lab's "very
// provable" guarantee: a reported throughput always comes from a ledger that just passed its own audit.
export async function proveEconomyOrReport(
  economy: Economy,
): Promise<ProveResult> {
  const report = await economy.read.prove();
  return { ok: allInvariantsHold(report), report };
}

// --- Cross-engine determinism ------------------------------------------------------

// The deterministic fingerprint of a ledger: the Merkle root over every account's chain head, as hex.
// It is reproducible across engines (merkleRoot sorts leaves by account id), so running the IDENTICAL
// sequential sequence on each backend and comparing this value is a true agreement check — equal hex ⟺
// byte-identical ledgers. Uses store.ledger.heads() directly (economy.read exposes no root); only
// meaningful over a fixed sequence, since the concurrent sample is order-nondeterministic.
export async function determinismRoot(p: Provisioned): Promise<string> {
  const heads: Array<readonly [AccountRef, string]> = [];
  for await (const pair of p.store.ledger.heads()) heads.push(pair);
  return toHex(await merkleRoot(p.workerCtx.digest, heads));
}

// --- Output ------------------------------------------------------------------------

export const num = (n: number): string => Math.round(n).toLocaleString('en-US');
export const rate = (n: number | null): string => (n === null ? 'n/a' : num(n));
export const ms = (n: number): string => n.toFixed(n < 10 ? 2 : 1);

// Hide a DSN password before logging a connection string. Parse the URL so the WHOLE password is
// masked even when it contains a literal `@` or `:` (a regex that stops at the first `@` would leak
// the tail); fall back to the simple substitution if the string doesn't parse as a URL.
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

// Emit the machine-readable result when JSON output is on. A stable JSON shape lets a CI job track a
// regression over time or assert a floor, which a console table cannot. Writes to BENCH_JSON_PATH
// when set, else to stdout (so stdout stays clean of the human narration, which goes to stderr via
// console.warn).
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
