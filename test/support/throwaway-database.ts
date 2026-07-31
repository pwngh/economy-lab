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

/**
 * Creating, using and dropping a throwaway MySQL database, and naming one so a killed run's
 * leftovers can be found again.
 *
 * TWO TREES READ THIS FILE: the lab's own rigs, and `packages/mysql`, which reaches it by
 * relative path. It therefore imports nothing at all — not even the MySQL driver. The pool
 * factory is a parameter because the two callers must not share one: the lab's rigs take
 * `createMysqlPool` from `@pwngh/economy-mysql`, which resolves through that package's exports
 * map into its `dist`, while `packages/mysql`'s own suite drives `../src/index.js`. A body that
 * imported either would put one of those beside the other in a single process, which is worse
 * than the copy this file replaces. `test/toolchain-shape.test.ts#PACKAGE_REACH` holds the rule.
 */

/** The pool members this file calls. Either driver's pool satisfies it structurally. */
export interface ThrowawayPool {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

// `<prefix>_<pid>_<base36 ms stamp>_<counter>`: unique per call, and THROWAWAY_NAME reads the pid
// and the stamp back out, which is what lets the stale-namespace sweep spot an orphan.
let run = 0;
export function freshName(prefix: string): string {
  run += 1;
  const stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

/** A name {@link freshName} wrote, read back: capture 1 is the creating pid, capture 2 the stamp. */
export const THROWAWAY_NAME = /^el_[a-z_]+?_(\d+)_([0-9a-z]+)_\d+$/;

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

/**
 * Runs `work` against a pool on a throwaway database, dropped afterwards, and answers with
 * whatever `work` answered with.
 *
 * For a test that installs the money routines: that install is `drop function` then
 * `create function`, so running it against the shared `economy_lab` would break whatever a
 * parallel test file is proving there. For a test that applies the schema: `applyMysqlSchema`
 * drops and recreates its tables. Two such tests never share a database.
 *
 * The name is pasted into `CREATE`/`DROP DATABASE` under MySQL's backtick quoting, so it goes
 * through {@link safeDatabaseName} here rather than at each call site.
 */
export async function onThrowawayDatabase<P extends ThrowawayPool, T>(
  options: {
    /** A MySQL URL on the server to create against; whatever database it names is replaced. */
    serverUrl: string;
    database: string;
    openPool: (url: string) => Promise<P>;
  },
  work: (pool: P) => Promise<T>,
): Promise<T> {
  const database = safeDatabaseName(options.database);
  const admin = await options.openPool(withDatabase(options.serverUrl, null));
  // CREATE DATABASE is the admin pool's first statement, so a throw here (DDL contention under a
  // parallel run) must end the pool before rethrowing: its freshly opened connection otherwise
  // keeps the process's event loop alive past the last test.
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
  } catch (error) {
    await admin.end().catch(() => {});
    throw error;
  }
  let pool: P | undefined;
  try {
    pool = await options.openPool(withDatabase(options.serverUrl, database));
    return await work(pool);
  } finally {
    // The pools were opened here, so they are ended here; a pool nobody ends keeps the test
    // process alive past its last test.
    await pool?.end().catch(() => {});
    await admin
      .query(`DROP DATABASE IF EXISTS \`${database}\``)
      .catch(() => {});
    await admin.end().catch(() => {});
  }
}
