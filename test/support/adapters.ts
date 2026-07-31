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

// The engine stores here come from `@pwngh/economy-postgres` and `@pwngh/economy-mysql`, which
// resolve through their exports maps into `dist`. So a suite that takes a store from this file
// runs against the last build of `src/`, however many `#src/*` specifiers its own import list
// carries. Both runners refuse such a file while the emit is behind its source; the classifier
// is scripts/support/dist-reach.ts.

import { memoryStore } from '#src/adapters/memory.ts';
import { postgresStore } from '@pwngh/economy-postgres';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '@pwngh/economy-mysql';
import { httpStore, createStoreServer } from '#src/adapters/http.ts';
import { createMariadbPool } from '@pwngh/economy-mysql/mariadb';
import { loadPg, openPgPool } from '@pwngh/economy-postgres/driver';
import { LOCAL_POSTGRES_URL, storeUrls } from '#src/env.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';
import { postgresJsPool } from '#test/support/wire-trial.ts';
import {
  THROWAWAY_NAME,
  freshName,
  onThrowawayDatabase,
  safeDatabaseName,
  withDatabase,
} from '#test/support/throwaway-database.ts';

import type { EnvMap } from '#src/env.ts';
import type { MysqlPool } from '@pwngh/economy-mysql';
import type { PgPool } from '@pwngh/economy-postgres';
import type { Clock, Digest, Store } from '#src/ports.ts';

/** One matrix adapter: a test-title name and a factory returning a fresh, isolated store. */
export type AdapterCase = {
  name: string;
  makeStore: () => Promise<Store>;
};

// --- Test-suite URL policy ----------------------------------------------------------

/**
 * The suite URL policy over src/env.ts: Postgres falls back to the compose-local default (each
 * suite's reachability probe turns absence into a skip); MySQL runs only when something names it.
 */
export function testPostgresUrl(env: EnvMap): string {
  return storeUrls(env).postgres ?? LOCAL_POSTGRES_URL;
}

/** As {@link testPostgresUrl}; null (nothing names MySQL) means the suite skips or registers nothing. */
export function testMysqlUrl(env: EnvMap): string | null {
  return storeUrls(env).mysql;
}

// --- Throwaway names ------------------------------------------------------------------

// How a throwaway namespace is named, checked and lifecycled lives in one dependency-free file,
// because packages/mysql's own suite reads it too. Re-exported here so a rig that already knows
// this module keeps its one import.
export { freshName, safeDatabaseName, withDatabase };

/** {@link onThrowawayDatabase} bound to the driver the lab's rigs take from the built package. */
export function onThrowawayMysqlDatabase<T>(
  serverUrl: string,
  work: (pool: MysqlPool) => Promise<T>,
): Promise<T> {
  return onThrowawayDatabase(
    { serverUrl, database: freshName('el_tmp'), openPool: createMysqlPool },
    work,
  );
}

// --- Stale-namespace sweep ---------------------------------------------------------

// A killed run never drops its throwaway namespace, so el_* leftovers accumulate. The sweep
// drops a namespace whose creating pid is gone and whose stamp is old; rigs/db-clean.ts runs
// it on demand (--all drops every match), the store factories below run it once per process.

// Whole databases two integration suites create, named by pid alone (no stamp): stale exactly
// when their pid is gone.
const PID_DATABASE = /^(?:tilia_payees_it|taskq_lab_it)_(\d+)$/;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A compose-run bench creates namespaces under a container pid this host cannot see, so age
// gates the pid check; a day old is abandoned regardless of pid.
const SWEEP_GRACE_MS = 30 * 60_000;
const SWEEP_ABANDONED_MS = 24 * 60 * 60_000;

// Applies the orphan rule to one namespace name; non-matching names are never touched.
export function isStaleThrowaway(name: string, all = false): boolean {
  const throwaway = THROWAWAY_NAME.exec(name);
  if (throwaway) {
    if (all) {
      return true;
    }
    const age = Date.now() - Number.parseInt(throwaway[2]!, 36);
    if (!Number.isFinite(age) || age < 0) {
      return false;
    }
    if (age > SWEEP_ABANDONED_MS) {
      return true;
    }
    return age > SWEEP_GRACE_MS && !pidAlive(Number(throwaway[1]));
  }
  const pidDb = PID_DATABASE.exec(name);
  if (pidDb) {
    return all || !pidAlive(Number(pidDb[1]));
  }
  return false;
}

/**
 * Drops every stale throwaway namespace reachable through a Postgres URL: el_* schemas in the
 * connected database, plus the pid-named integration databases. Returns the names it dropped.
 */
export async function sweepStalePostgres(
  url: string,
  all = false,
): Promise<string[]> {
  const pg = await loadPg();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const dropped: string[] = [];
  try {
    const schemata = await client.query(
      "select schema_name from information_schema.schemata where schema_name like 'el\\_%'",
    );
    // Each drop stands alone: one locked or permission-guarded namespace must not stop the rest
    // of the sweep.
    for (const row of schemata.rows) {
      const name = String(row.schema_name);
      if (isStaleThrowaway(name, all)) {
        try {
          await client.query(
            `drop schema if exists "${safeDatabaseName(name)}" cascade`,
          );
          dropped.push(name);
        } catch {
          continue;
        }
      }
    }
    // el_* databases are the restore drill's scratches; el_* schemas above are everyone else's.
    const databases = await client.query(
      "select datname from pg_database where datname like 'el\\_%' or datname like 'tilia_payees_it\\_%' or datname like 'taskq_lab_it\\_%'",
    );
    for (const row of databases.rows) {
      const name = String(row.datname);
      if (isStaleThrowaway(name, all)) {
        try {
          await client.query(
            `drop database if exists "${safeDatabaseName(name)}" with (force)`,
          );
          dropped.push(name);
        } catch {
          continue;
        }
      }
    }
  } finally {
    await client.end();
  }
  return dropped;
}

/** As {@link sweepStalePostgres}, for the el_* throwaway databases on a MySQL server. */
export async function sweepStaleMysql(
  url: string,
  all = false,
): Promise<string[]> {
  const admin = await createMysqlPool(withDatabase(url, null));
  const dropped: string[] = [];
  try {
    const [result] = await admin.query(
      "select schema_name as name from information_schema.schemata where schema_name like 'el\\_%'",
    );
    for (const row of result as Array<{ name: string }>) {
      const name = String(row.name);
      if (isStaleThrowaway(name, all)) {
        try {
          await admin.query(
            `DROP DATABASE IF EXISTS \`${safeDatabaseName(name)}\``,
          );
          dropped.push(name);
        } catch {
          continue;
        }
      }
    }
  } finally {
    await admin.end();
  }
  return dropped;
}

// Once per process per engine, best-effort: a sweep failure never blocks the store being built.
// Every throwaway-namespace creator calls this, so a crashed run's leftovers get reaped by the
// next run rather than waiting for a manual `make db-clean`.
const sweptEngines = new Set<'postgres' | 'mysql'>();
export async function maybeSweep(
  engine: 'postgres' | 'mysql',
  url: string,
): Promise<void> {
  if (sweptEngines.has(engine)) {
    return;
  }
  sweptEngines.add(engine);
  try {
    const dropped =
      engine === 'postgres'
        ? await sweepStalePostgres(url)
        : await sweepStaleMysql(url);
    if (dropped.length > 0) {
      console.warn(
        `db-clean: dropped ${dropped.length} stale throwaway namespace(s) on ${engine}`,
      );
    }
  } catch {
    // Unreachable server or insufficient privilege: the caller's own connect will say so.
  }
}

// --- Isolated stores and the matrix ---------------------------------------------------

/**
 * A Postgres store on its own throwaway schema, dropped on close (postgresStore's `schema`
 * option does all of that). Shared by the conformance matrix and the bench harness, which
 * differ only in digest/clock and pool sizing. `driver: 'postgresjs'` mounts the wire-trial
 * postgres.js pool behind the store's driver seam instead of pg.
 *
 * When a pool is built here it is ended here, after the store's own close() has dropped the
 * schema. The store ends only pools it opened itself.
 */
export async function makeIsolatedPostgresStore(opts: {
  url: string;
  digest: Digest;
  clock: Clock;
  poolMax?: number;
  connectionTimeoutMillis?: number;
  driver?: 'pg' | 'postgresjs';
  /** Applied to the pool behind the store's driver seam — the profiler's statement tap. */
  wrapPool?: (pool: PgPool) => PgPool;
}): Promise<Store> {
  await maybeSweep('postgres', opts.url);
  const schemaName = freshName('el_iso');
  const pool = await isolatedPgPool(opts, schemaName);
  const store = await postgresStore({
    url: opts.url,
    schemaName,
    digest: opts.digest,
    clock: opts.clock,
    ...(opts.poolMax ? { poolMax: opts.poolMax } : {}),
    ...(opts.connectionTimeoutMillis
      ? { connectionTimeoutMillis: opts.connectionTimeoutMillis }
      : {}),
    ...(pool ? { pool } : {}),
  });
  if (pool === null) {
    return store;
  }
  return {
    ...store,
    close: async () => {
      await store.close();
      await pool.end();
    },
  };
}

// The pool behind the seam, when one must be built here: the postgres.js trial wire, or the
// default pg pool made explicit so `wrapPool` has an object to wrap. Without either, the store
// builds its own pool — the branch production hosts run, kept covered by the conformance matrix.
async function isolatedPgPool(
  opts: {
    url: string;
    poolMax?: number;
    connectionTimeoutMillis?: number;
    driver?: 'pg' | 'postgresjs';
    wrapPool?: (pool: PgPool) => PgPool;
  },
  schemaName: string,
): Promise<PgPool | null> {
  const wrap = opts.wrapPool ?? ((pool: PgPool) => pool);
  if (opts.driver === 'postgresjs') {
    return wrap(
      await postgresJsPool({
        url: opts.url,
        schemaName,
        ...(opts.poolMax ? { max: opts.poolMax } : {}),
        ...(opts.connectionTimeoutMillis
          ? { connectionTimeoutMillis: opts.connectionTimeoutMillis }
          : {}),
      }),
    );
  }
  if (opts.wrapPool === undefined) {
    return null;
  }
  // pg.Pool also carries connect(); the driver doorway's PgPoolLike omits it, the seam needs it.
  const raw = (await openPgPool({
    connectionString: opts.url,
    options: `-c search_path=${schemaName}`,
    ...(opts.poolMax ? { max: opts.poolMax } : {}),
    ...(opts.connectionTimeoutMillis
      ? { connectionTimeoutMillis: opts.connectionTimeoutMillis }
      : {}),
  })) as unknown as PgPool;
  return wrap(raw);
}

/**
 * A MySQL store on its own freshly created database, dropped on close — the isolated-MySQL
 * provisioning shared by the conformance matrix and the bench harness. Each store gets a whole
 * database of its own because concurrent stores re-running the schema against one shared
 * database could leave it half-applied. If setup throws partway, the same teardown runs, so no
 * pool or database leaks.
 */
export async function makeIsolatedMysqlStore(opts: {
  url: string;
  digest: Digest;
  clock: Clock;
  connectionLimit?: number;
  // 'mariadb' mounts the pipelining mariadb pool (@pwngh/economy-mysql/mariadb) behind
  // mysqlStore's pool seam instead of mysql2; administrative work (database create/drop) stays
  // on mysql2 either way.
  driver?: 'mysql2' | 'mariadb';
  /** Applied to the built pool at the driver seam — the profiler's statement tap. */
  wrapPool?: (pool: MysqlPool) => MysqlPool;
}): Promise<Store> {
  await maybeSweep('mysql', opts.url);
  const database = safeDatabaseName(freshName('el_iso'));
  const admin = await createMysqlPool(withDatabase(opts.url, null));
  // CREATE DATABASE is the admin pool's first statement, so a throw here (DDL contention under a
  // parallel test run) must end the pool before rethrowing: the pool's freshly opened connection
  // otherwise keeps the test process's event loop alive forever after its tests finish.
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
  } catch (error) {
    await admin.end().catch(() => {});
    throw error;
  }

  // Tolerates a missing database and a failed drop so cleanup on a half-built store still ends
  // every pool.
  const dropDatabase = async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  };

  let pool;
  try {
    pool =
      opts.driver === 'mariadb'
        ? await createMariadbPool(
            withDatabase(opts.url, database),
            opts.connectionLimit
              ? { connectionLimit: opts.connectionLimit }
              : {},
          )
        : await createMysqlPool(
            withDatabase(opts.url, database),
            opts.connectionLimit
              ? { connectionLimit: opts.connectionLimit }
              : {},
          );
    if (opts.wrapPool) {
      pool = opts.wrapPool(pool);
    }
    await applyMysqlSchema(pool);
  } catch (error) {
    if (pool) {
      await pool.end().catch(() => {});
    }
    await dropDatabase().catch(() => {});
    throw error;
  }

  const store = mysqlStore({ pool, digest: opts.digest, clock: opts.clock });
  return {
    ...store,
    close: async () => {
      // The pool was built here, so it is ended here: mysqlStore leaves a pool it was handed
      // alone, and a pool nobody ends keeps this test process's event loop alive.
      await store.close();
      await pool.end();
      // Under CI the engine dies with the job, so the drop is pure DDL fsync tax; leave the
      // database for the sweeper (maybeSweep / db:clean), whose live path this also exercises.
      if (process.env.CI !== undefined) {
        await admin.end();
        return;
      }
      await dropDatabase();
    },
  };
}

/**
 * The conformance matrix: a fresh-store factory per adapter, each wired with the same seeded
 * digest and fixed clock so identical inputs hash identically on every backend. Reachability is
 * not probed here; prove.ts and fuzz.ts probe each backend themselves.
 */
export function adapterMatrix(env: EnvMap): AdapterCase[] {
  return [
    {
      name: 'memory',
      makeStore: async () =>
        memoryStore({ digest: seededDigest(1), clock: fixedClock(0) }),
    },
    {
      name: 'postgres',
      makeStore: async () =>
        makeIsolatedPostgresStore({
          url: testPostgresUrl(env),
          digest: seededDigest(1),
          clock: fixedClock(0),
        }),
    },
    {
      name: 'mysql',
      makeStore: async () => {
        const url = testMysqlUrl(env);
        if (url === null) {
          throw new Error(
            'no MySQL URL configured (set DATABASE_URL or MYSQL_TEST_URL)',
          );
        }
        return makeIsolatedMysqlStore({
          url,
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
      },
    },
    {
      name: 'http',
      makeStore: async () => {
        const backing = memoryStore({
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
        return httpStore({ fetch: createStoreServer(backing) });
      },
    },
  ];
}
