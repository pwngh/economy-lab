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
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Clock, Digest, Store } from '#src/ports.ts';

/** Describes one adapter in the matrix. It holds a name for the test title and a fresh-store factory. */
export type AdapterCase = {
  name: string;
  makeStore: () => Promise<Store>;
};

// Returns the Postgres URL for tests. Prefers DATABASE_URL, then PG_URL, then a local default.
// Mirrors test/adapters/postgres.test.ts.
function postgresUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgres://economy:economy@localhost:5432/economy_lab'
  );
}

// Builds a unique name so concurrent suites and reruns get isolated tables. The name combines the
// process id, a base-36 timestamp (milliseconds since the epoch, in base 36 to keep it short), and
// a per-call counter. It names the Postgres throwaway schema and the MySQL throwaway database, each
// of which is dropped when the store closes.
let run = 0;
export function freshName(prefix: string): string {
  run += 1;
  const stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

// Rejects any database name that is not plain identifier characters, then returns it. A MySQL
// database name cannot be a bound parameter in CREATE or DROP DATABASE, so it gets pasted into the
// SQL text directly. Rejecting non-identifier names keeps that paste injection-safe. freshName only
// ever produces such names, so this just guards that assumption.
function safeDatabaseName(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe MySQL database name: ${JSON.stringify(name)}`);
  }
  return name;
}

// Swaps the database in a MySQL connection URL for the given database, keeping host, port, and
// credentials intact. A null database strips it so the connection has no default database, which is
// what the admin pool needs to run CREATE DATABASE and DROP DATABASE.
function withDatabase(url: string, database: string | null): string {
  const parsed = new URL(url);
  parsed.pathname = database ? `/${database}` : '/';
  return parsed.toString();
}

/**
 * Builds a Postgres store on its own throwaway schema, loaded with db/postgresql-schema.sql and
 * dropped when the store closes (postgresStore's `schema` option does all of that). The shared
 * isolated-Postgres provisioning: the conformance matrix passes a seeded digest/clock so backends
 * hash identically, while the bench harness passes the production digest and a `poolMax` sized to its
 * concurrency. Parameterizing the hash/clock/pool keeps this one function instead of a copy per caller.
 */
export async function makeIsolatedPostgresStore(opts: {
  url: string;
  digest: Digest;
  clock: Clock;
  poolMax?: number;
  connectionTimeoutMillis?: number;
}): Promise<Store> {
  return postgresStore({
    url: opts.url,
    schema: freshName('el_iso'),
    digest: opts.digest,
    clock: opts.clock,
    ...(opts.poolMax ? { poolMax: opts.poolMax } : {}),
    ...(opts.connectionTimeoutMillis
      ? { connectionTimeoutMillis: opts.connectionTimeoutMillis }
      : {}),
  });
}

/**
 * Builds a MySQL store on its own throwaway database. Like the Postgres case, it gives each store a unique namespace that is dropped on close, and is the shared isolated-MySQL
 * provisioning for both the conformance matrix and the bench harness (which differ only in the
 * digest/clock and an optional `connectionLimit`).
 *
 * prove.ts and fuzz.ts build a fresh store for every probe, seed, and replay. Pointing them all at
 * the one shared database named in MYSQL_TEST_URL re-ran the whole drop-everything and
 * create-everything schema against it repeatedly. Overlapping DDL could leave that database
 * half-applied, for example a trigger created before its table was visible, so a later statement
 * saw a missing table. Giving each store its own freshly created database removes the sharing
 * entirely.
 *
 * An admin pool with no default database runs `CREATE DATABASE <unique>`. The store's own pool is
 * pointed at `<unique>` so that applyMysqlSchema's unqualified CREATEs land there. `close()` closes
 * the store pool, drops the database through the admin pool, then ends the admin pool. If setup
 * throws partway, the same teardown runs, so no pool or database leaks.
 */
export async function makeIsolatedMysqlStore(opts: {
  url: string;
  digest: Digest;
  clock: Clock;
  connectionLimit?: number;
}): Promise<Store> {
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

  // Drops the throwaway database and tears down the admin pool. It tolerates a missing database and
  // a failed drop so that cleanup on a half-built store still ends every pool.
  const dropDatabase = async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  };

  let pool;
  try {
    pool = await createMysqlPool(
      withDatabase(opts.url, database),
      opts.connectionLimit ? { connectionLimit: opts.connectionLimit } : {},
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
      await dropDatabase();
    },
  };
}

/**
 * Returns the store adapters (memory, postgres, mysql, http), each a factory for a fresh, isolated
 * store. A test runs the same operations against every adapter and expects identical results. Each
 * factory therefore wires the same seeded digest ({@link seededDigest}) and fixed clock, so
 * identical inputs hash identically on every backend.
 *
 * - memory: `memoryStore({ digest, clock })`, always available.
 * - postgres: `postgresStore({ url, schema, digest, clock })` with a unique throwaway schema that
 *   loads db/postgresql-schema.sql and is dropped on close (mirrors postgres.test.ts).
 * - mysql: a throwaway database on a fresh pool, with the schema applied, dropped on close (mirrors
 *   mysql.test.ts).
 * - http: an in-process server over a memory backing store with the same digest and clock.
 *
 * This function does not probe reachability. prove.ts and fuzz.ts probe each backend themselves.
 */
export function adapterMatrix(): AdapterCase[] {
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
          url: postgresUrl(),
          digest: seededDigest(1),
          clock: fixedClock(0),
        }),
    },
    {
      name: 'mysql',
      makeStore: async () => {
        const url = process.env.MYSQL_TEST_URL;
        if (!url) {
          throw new Error('MYSQL_TEST_URL not set');
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
        // Runs in-process. The memory backing store carries the seeded digest and fixed clock, and
        // the HTTP client talks to a server over it. The HTTP path therefore hashes like the others.
        const backing = memoryStore({
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
        return httpStore({ fetch: createStoreServer(backing) });
      },
    },
  ];
}
