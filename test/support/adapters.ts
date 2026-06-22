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
import { postgresStore } from '#src/adapters/postgres.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '#src/adapters/mysql.ts';
import { httpStore, createStoreServer } from '#src/adapters/http.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Store } from '#src/ports.ts';

/** One adapter in the matrix: a name for the test title, and a fresh-store factory. */
export type AdapterCase = {
  name: string;
  makeStore: () => Promise<Store>;
};

// Where to reach the test Postgres. Prefer either environment variable if set; otherwise
// fall back to a Postgres running on the local machine with the default port and database.
// Mirrors test/adapters/postgres.test.ts.
function postgresUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgresql://localhost:5432/economy_lab'
  );
}

// Builds a name that no other run will reuse, so suites running at the same time (or a rerun
// of one) each get their own isolated set of tables and never collide. Combines this
// process's id, a base-36 timestamp (the milliseconds-since-epoch time written in base 36 to
// keep it short), and a counter bumped on each call. Used here for the Postgres throwaway
// schema (the temporary, named group of tables that is dropped when the store closes).
let run = 0;
function freshName(prefix: string): string {
  run += 1;
  let stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

/**
 * The known store adapters (memory, postgres, mysql, http), each with a factory that builds a
 * FRESH, ISOLATED store. A test runs the SAME sequence of operations against every adapter and
 * checks that they all produce the same results, so each factory wires its store with the SAME
 * seeded digest (the hashing capability, fixed via {@link seededDigest}) and the SAME fixed
 * clock — that way the identical inputs hash to identical outputs on every backend.
 *
 * - memory: `memoryStore({ digest, clock })` — always available.
 * - postgres: `postgresStore({ url, schema, digest, clock })` with a unique throwaway schema
 *   that loads db/postgresql-schema.sql and is dropped on close (mirrors postgres.test.ts).
 * - mysql: a throwaway database created on a fresh pool, schema applied, dropped on close
 *   (mirrors mysql.test.ts).
 * - http: in-process server over a memory backing store built with the same digest + clock,
 *   so the HTTP path hashes identically to the others.
 *
 * Reachability is deliberately NOT probed here; prove.ts / fuzz.ts probe each backend themselves.
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
        let pool = await createMysqlPool(url);
        await applyMysqlSchema(pool);
        return mysqlStore({
          pool,
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
      },
    },
    {
      name: 'http',
      makeStore: async () => {
        // In-process: a memory backing store carries the seeded digest + fixed clock, and the
        // HTTP client talks to a server over it, so the HTTP path hashes like every other.
        let backing = memoryStore({
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
        return httpStore({ fetch: createStoreServer(backing) });
      },
    },
  ];
}
