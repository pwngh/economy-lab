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

// Per-statement wall-time profiler for the hot pipeline: wraps each provisioned pool at the
// engines' driver seam (PostgresStoreOptions.pool / mysqlStore's MysqlPool), buckets time by
// statement prefix, and prints solo-vs-batched per-op cost tables. One tap covers every driver,
// incumbent or trial.
//
//   node scripts/profile-statements.ts                                # any reachable backend
//   BENCH_BACKENDS=postgres node scripts/profile-statements.ts
//   sh scripts/docker.sh run --rm bench scripts/profile-statements.ts # production-parity rig
//
// The usual BENCH_* knobs apply. Rig honesty: an in-VM database answers round trips far faster
// than a production network, so round-trip savings measured here understate production gains;
// per-statement server-side costs are rig-independent.

import { createEconomy } from '#src/economy.ts';
import { loadConfig } from '#src/config.ts';
import { sha256Digest } from '#src/digest.ts';
import { topUp, credit } from '#test/support/builders.ts';
import {
  defaultPricing,
  fakeProcessor,
  fixedClock,
  fixedRates,
  seededSigner,
  sequentialIds,
  silentMeter,
  testLogger,
  testSecrets,
} from '#test/support/capabilities.ts';
import { resolveConfig, tryProvision } from '#scripts/support/harness.ts';

import type { BackendName } from '#scripts/support/harness.ts';
import type { Economy } from '#src/contract.ts';
import type { MysqlPool } from '#src/engines/mysql.ts';
import type { PgPool } from '#src/engines/postgres.ts';
import type { Ports, Store } from '#src/ports.ts';

const cfg = resolveConfig(process.env);
const tag = `pf${process.pid.toString(36)}`;
const OPS = 192;
const BATCH_SIZE = 16;

// --- The pool tap -----------------------------------------------------------------

type Bucket = Map<string, { ms: number; count: number }>;
const active: { bucket: Bucket | null } = { bucket: null };

function record(text: string, t0: number): void {
  const bucket = active.bucket;
  if (bucket === null) {
    return;
  }
  const key = text.replace(/\s+/g, ' ').trim().slice(0, 56);
  const row = bucket.get(key) ?? { ms: 0, count: 0 };
  row.ms += performance.now() - t0;
  row.count += 1;
  bucket.set(key, row);
}

function observed<T>(text: string, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  return run().finally(() => record(text, t0));
}

// Every statement crosses the pool seam, on the pool itself or on a checked-out connection, so
// wrapping both paths observes the store's entire wire without touching any driver internals.
function tappedPgPool(pool: PgPool): PgPool {
  return {
    query: (text, values) => observed(text, () => pool.query(text, values)),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, values) =>
          observed(text, () => client.query(text, values)),
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

function tappedMysqlPool(pool: MysqlPool): MysqlPool {
  return {
    query: (sql, params) => observed(sql, () => pool.query(sql, params)),
    getConnection: async () => {
      const conn = await pool.getConnection();
      // `connection` is the engine's per-connection identity key (one-time session setup);
      // pass the borrowed wrapper's own through so the tap never changes that identity.
      const core = (conn as { connection?: object }).connection;
      const borrowed = {
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          observed(sql, () => conn.query(sql, params)),
        release: () => conn.release(),
        ...(core ? { connection: core } : {}),
      };
      return borrowed;
    },
    end: () => pool.end(),
  };
}

// --- The measured workload --------------------------------------------------------

function economyOf(store: Store): Economy {
  const config = loadConfig({
    MATURITY_HORIZON_CARD_MS: '0',
    MATURITY_HORIZON_CRYPTO_MS: '0',
    MATURITY_HORIZON_DEFAULT_MS: '0',
    VELOCITY_LIMIT_MINOR: '1000000000000000',
    PLATFORM_SHARDS: String(cfg.shards),
  });
  const ports: Ports = {
    store,
    clock: fixedClock(0),
    ids: sequentialIds(cfg.seed),
    digest: sha256Digest(),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    pricing: defaultPricing(),
    logger: testLogger(),
    meter: silentMeter(),
    config,
    secrets: testSecrets(),
  };
  return createEconomy(ports);
}

function report(label: string, bucket: Bucket, ops: number): void {
  const rows = [...bucket].sort((a, b) => b[1].ms - a[1].ms).slice(0, 14);
  process.stdout.write(`  --- ${label} (per-op over ${ops} ops) ---\n`);
  for (const [sql, { ms, count }] of rows) {
    process.stdout.write(
      `    ${(ms / ops).toFixed(3)}ms/op  x${(count / ops).toFixed(1)}  ${sql}\n`,
    );
  }
}

async function profile(backend: BackendName): Promise<void> {
  const provisioned = await tryProvision(backend, cfg, {
    pg: tappedPgPool,
    mysql: tappedMysqlPool,
  });
  if (provisioned === null) {
    process.stdout.write(`${backend}: unavailable\n`);
    return;
  }
  try {
    process.stdout.write(`${backend}  durability: ${provisioned.durability}\n`);
    const economy = economyOf(provisioned.store);
    let n = 0;
    // Fresh users measure the first-use path (probes, plants); repeat users measure steady
    // state, where the known-accounts cache has emptied the first-use statements.
    const repeatPool = Array.from(
      { length: BATCH_SIZE },
      (_, i) => `usr_${tag}_${backend}_repeat_${i}`,
    );
    const makeTopUp = (fresh: boolean): ReturnType<typeof topUp> =>
      topUp({
        userId: fresh
          ? `usr_${tag}_${backend}_${n++}`
          : repeatPool[n++ % repeatPool.length]!,
        amount: credit('10.00'),
      });
    for (let i = 0; i < cfg.warmup; i += 1) {
      await economy.submit(makeTopUp(true));
    }
    for (const user of repeatPool) {
      await economy.submit(topUp({ userId: user, amount: credit('10.00') }));
    }

    const phases: Array<{ label: string; batch: number; fresh: boolean }> = [
      { label: 'solo fresh', batch: 1, fresh: true },
      { label: 'solo repeat', batch: 1, fresh: false },
      { label: `batch x${BATCH_SIZE} fresh`, batch: BATCH_SIZE, fresh: true },
      { label: `batch x${BATCH_SIZE} repeat`, batch: BATCH_SIZE, fresh: false },
    ];
    const totals: string[] = [];
    const buckets: Array<{ label: string; bucket: Bucket }> = [];
    for (const phase of phases) {
      const bucket: Bucket = new Map();
      active.bucket = bucket;
      const t0 = performance.now();
      if (phase.batch === 1) {
        for (let i = 0; i < OPS; i += 1) {
          await economy.submit(makeTopUp(phase.fresh));
        }
      } else {
        for (let i = 0; i < OPS; i += phase.batch) {
          await economy.submitBatch(
            Array.from({ length: phase.batch }, () => makeTopUp(phase.fresh)),
          );
        }
      }
      const ms = performance.now() - t0;
      active.bucket = null;
      totals.push(`${phase.label} ${(ms / OPS).toFixed(2)}ms/op`);
      buckets.push({ label: phase.label, bucket });
    }

    process.stdout.write(`  totals: ${totals.join('  ')}\n`);
    for (const { label, bucket } of buckets) {
      report(label, bucket, OPS);
    }
  } finally {
    await provisioned.teardown();
  }
}

for (const backend of cfg.backends) {
  if (backend !== 'in-memory') {
    await profile(backend);
  }
}
