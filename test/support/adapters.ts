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

import type { Store } from '#src/ports.ts';

/** One adapter in the matrix: a name for the test title, and a fresh-store factory. */
export type AdapterCase = {
  name: string;
  makeStore: () => Promise<Store>;
};

// Test Postgres URL. DATABASE_URL or PG_URL if set, else local default port/database.
// Mirrors test/adapters/postgres.test.ts.
function postgresUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgres://economy:economy@localhost:5432/economy_lab'
  );
}

// Unique name so concurrent suites (or reruns) get isolated tables. Combines pid, a base-36
// timestamp (ms-since-epoch in base 36 to keep it short), and a per-call counter. Used for the
// Postgres throwaway schema and the MySQL throwaway database, each dropped when the store closes.
let run = 0;
function freshName(prefix: string): string {
  run += 1;
  let stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

// Reject any database name that isn't plain identifier characters before pasting it into DDL.
// A MySQL database name can't be a bound parameter in CREATE/DROP DATABASE, so it goes into the
// SQL text; this keeps it injection-safe. freshName only ever produces such names, so this just
// guards the assumption.
function safeDatabaseName(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe MySQL database name: ${JSON.stringify(name)}`);
  }
  return name;
}

// Swap the database in a MySQL connection URL for `database` (or strip it when null, to connect
// with no default database — used for the admin pool that runs CREATE/DROP DATABASE). Keeps host,
// port, and credentials intact.
function withDatabase(url: string, database: string | null): string {
  let parsed = new URL(url);
  parsed.pathname = database ? `/${database}` : '/';
  return parsed.toString();
}

/**
 * Build a MySQL store on its own throwaway database, mirroring the Postgres case's
 * unique-schema-per-store + drop-on-close discipline.
 *
 * prove.ts / fuzz.ts build a fresh store for every probe, seed, and replay. Pointing them all at
 * the one shared database named in MYSQL_TEST_URL meant re-running the whole DROP-everything +
 * CREATE-everything schema repeatedly against it; overlapping DDL could leave it half-applied (a
 * trigger created before its table is visible), so a later statement saw a missing table. Giving
 * each store its own freshly created database removes the sharing entirely.
 *
 * An admin pool with no default database runs `CREATE DATABASE <unique>`; the store's own pool is
 * pointed at `<unique>` (so applyMysqlSchema's unqualified CREATEs land there). `close()` closes
 * the store pool, drops the database via the admin pool, then ends the admin pool. If setup throws
 * partway, the same teardown runs so no pool or database leaks.
 */
async function makeMysqlStore(url: string): Promise<Store> {
  let database = safeDatabaseName(freshName('el_matrix'));
  let admin = await createMysqlPool(withDatabase(url, null));
  await admin.query(`CREATE DATABASE \`${database}\``);

  // Drop the throwaway database and tear down the admin pool. Tolerates a missing database and a
  // failed drop so cleanup on a half-built store still ends every pool.
  let dropDatabase = async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  };

  let pool;
  try {
    pool = await createMysqlPool(withDatabase(url, database));
    await applyMysqlSchema(pool);
  } catch (error) {
    if (pool) {
      await pool.end().catch(() => {});
    }
    await dropDatabase().catch(() => {});
    throw error;
  }

  let store = mysqlStore({
    pool,
    digest: seededDigest(1),
    clock: fixedClock(0),
  });
  return {
    ...store,
    close: async () => {
      await store.close();
      await dropDatabase();
    },
  };
}

/**
 * Store adapters (memory, postgres, mysql, http), each a factory for a fresh, isolated store.
 * A test runs the same operations against every adapter and expects identical results, so each
 * factory wires the same seeded digest ({@link seededDigest}) and fixed clock; identical inputs
 * then hash identically on every backend.
 *
 * - memory: `memoryStore({ digest, clock })`, always available.
 * - postgres: `postgresStore({ url, schema, digest, clock })` with a unique throwaway schema that
 *   loads db/postgresql-schema.sql and is dropped on close (mirrors postgres.test.ts).
 * - mysql: throwaway database on a fresh pool, schema applied, dropped on close (mirrors
 *   mysql.test.ts).
 * - http: in-process server over a memory backing store with the same digest + clock.
 *
 * Reachability is not probed here; prove.ts / fuzz.ts probe each backend themselves.
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
        postgresStore({
          url: postgresUrl(),
          schema: freshName('el_matrix'),
          digest: seededDigest(1),
          clock: fixedClock(0),
        }),
    },
    {
      name: 'mysql',
      makeStore: async () => {
        let url = process.env.MYSQL_TEST_URL;
        if (!url) {
          throw new Error('MYSQL_TEST_URL not set');
        }
        return makeMysqlStore(url);
      },
    },
    {
      name: 'http',
      makeStore: async () => {
        // In-process: memory backing store carries the seeded digest + fixed clock; the HTTP
        // client talks to a server over it, so the HTTP path hashes like the others.
        let backing = memoryStore({
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
        return httpStore({ fetch: createStoreServer(backing) });
      },
    },
  ];
}
