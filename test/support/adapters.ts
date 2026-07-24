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

import { memoryStore } from '#src/adapters/memory.ts';
import { postgresStore } from '#src/engines/postgres.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '#src/engines/mysql.ts';
import { httpStore, createStoreServer } from '#src/adapters/http.ts';
import { loadPg } from '#src/engines/pg-driver.ts';
import { createMariadbPool } from '#src/engines/mysql-mariadb.ts';
import { LOCAL_POSTGRES_URL, storeUrls } from '#src/env.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { EnvMap } from '#src/env.ts';
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

// `<prefix>_<pid>_<base36 ms stamp>_<counter>`: unique per call, and the stale-namespace sweep
// below parses the pid and stamp back out to spot orphans.
let run = 0;
export function freshName(prefix: string): string {
  run += 1;
  const stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

// A database name cannot be a bound parameter in CREATE/DROP DATABASE, so it is pasted into the
// SQL text; rejecting non-identifier names keeps that paste injection-safe.
export function safeDatabaseName(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe MySQL database name: ${JSON.stringify(name)}`);
  }
  return name;
}

// null strips the database entirely — the admin pool needs a connection with no default database.
export function withDatabase(url: string, database: string | null): string {
  const parsed = new URL(url);
  parsed.pathname = database ? `/${database}` : '/';
  return parsed.toString();
}

// --- Stale-namespace sweep ---------------------------------------------------------

// A killed run never drops its throwaway namespace, so el_* leftovers accumulate. The sweep
// drops a namespace whose creating pid is gone and whose stamp is old; scripts/db-clean.ts runs
// it on demand (--all drops every match), the store factories below run it once per process.
const THROWAWAY = /^el_[a-z_]+?_(\d+)_([0-9a-z]+)_\d+$/;

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
  const throwaway = THROWAWAY.exec(name);
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
 * differ only in digest/clock and pool sizing.
 */
export async function makeIsolatedPostgresStore(opts: {
  url: string;
  digest: Digest;
  clock: Clock;
  poolMax?: number;
  connectionTimeoutMillis?: number;
}): Promise<Store> {
  await maybeSweep('postgres', opts.url);
  return postgresStore({
    url: opts.url,
    schemaName: freshName('el_iso'),
    digest: opts.digest,
    clock: opts.clock,
    ...(opts.poolMax ? { poolMax: opts.poolMax } : {}),
    ...(opts.connectionTimeoutMillis
      ? { connectionTimeoutMillis: opts.connectionTimeoutMillis }
      : {}),
  });
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
  // 'mariadb' mounts the pipelining mariadb pool (src/engines/mysql-mariadb.ts) behind
  // mysqlStore's pool seam instead of mysql2; administrative work (database create/drop) stays
  // on mysql2 either way.
  driver?: 'mysql2' | 'mariadb';
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
      await store.close();
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
