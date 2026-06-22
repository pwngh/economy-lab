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

// Test Postgres URL. DATABASE_URL or PG_URL if set, else local default port/database.
// Mirrors test/adapters/postgres.test.ts.
function postgresUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgresql://localhost:5432/economy_lab'
  );
}

// Unique name so concurrent suites (or reruns) get isolated tables. Combines pid, a base-36
// timestamp (ms-since-epoch in base 36 to keep it short), and a per-call counter. Used for the
// Postgres throwaway schema, dropped when the store closes.
let run = 0;
function freshName(prefix: string): string {
  run += 1;
  let stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
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
