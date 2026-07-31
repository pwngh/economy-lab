/**
 * @pwngh/economy-mysql
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// This module builds the pipelining-capable MySQL pool. It puts the mariadb driver behind the
// same {@link MysqlPool} seam createMysqlPool fills with mysql2. It is a host opt-in. Install
// `mariadb` — it is an optional peer, where `mysql2` is a dependency and arrives with the
// package — build the pool here, and hand it to mysqlStore. Every engine statement above the
// seam is identical; the createMariadbPool doc below spells out the wire-level difference.

// The seam is imported, not re-declared: both drivers now live in one package, so the pool this
// file builds is checked against the shape the store actually rides.
import type { MysqlPool } from './mysql.js';

export type { MysqlPool };

// These interfaces declare only the slice of the mariadb driver this factory calls. Declaring
// them by hand keeps the optional dependency out of type resolution.
interface MariadbConnection {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(): void;
  threadId: number;
}
interface MariadbPool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  getConnection(): Promise<MariadbConnection>;
  end(): Promise<void>;
}

/**
 * Create a {@link MysqlPool} from a connection URL using the `mariadb` driver. This is the
 * pipelining-capable opt-in behind the same seam `createMysqlPool` fills with `mysql2`. Hand
 * the pool to `mysqlStore` and every statement above the seam is identical — same store, same
 * schema, same SQL. The difference is the wire. mysql2's command queue holds one command in
 * flight per connection, while mariadb writes the next command before the previous response
 * returns.
 *
 * The pool matches the mysql2 pool's configuration. Big integer and decimal columns come back
 * as exact strings (the engine converts them to bigint). The connection collation is pinned to
 * the schema's utf8mb4 default. `connectionLimit` caps the pool exactly as on `createMysqlPool`
 * and defaults to 10. Each in-flight transaction holds one connection, so size the pool to at
 * least the number of concurrent submits. The URL must carry no query parameters. This factory
 * maps the URL to driver config by hand, and throws rather than silently drop options mysql2
 * would honor.
 *
 * @example
 * import { createMariadbPool } from '@pwngh/economy-mysql/mariadb';
 * import { mysqlStore } from '@pwngh/economy-mysql';
 *
 * const pool = await createMariadbPool('mysql://econ:secret@127.0.0.1:3306/economy', {
 *   connectionLimit: 32,
 * });
 * const store = mysqlStore({ pool, schema: 'assert' });
 */
export async function createMariadbPool(
  url: string,
  options: { connectionLimit?: number } = {},
): Promise<MysqlPool> {
  // This import follows the same runtime-only discipline as createMysqlPool. The module name
  // in a variable keeps the optional dependency out of build-time resolution and out of bundles.
  const specifier = 'mariadb';
  const mariadb = (await import(/* @vite-ignore */ specifier)) as unknown as {
    default: { createPool(config: Record<string, unknown>): MariadbPool };
  };
  const u = new URL(url);
  // This factory builds the config by hand and has no clean mapping for query parameters. A
  // URL carrying them therefore fails loudly instead of losing options the mysql2 pool would
  // honor.
  if (u.search !== '') {
    throw new Error(
      `createMariadbPool: URL query parameters are not supported: ${u.search}`,
    );
  }
  const pool = mariadb.default.createPool({
    host: u.hostname,
    port: u.port === '' ? 3306 : Number(u.port),
    user: decodeURIComponent(u.username),
    ...(u.password === '' ? {} : { password: decodeURIComponent(u.password) }),
    ...(u.pathname.length > 1 ? { database: u.pathname.slice(1) } : {}),
    connectionLimit: options.connectionLimit ?? 10,
    supportBigNumbers: true,
    bigNumberStrings: true,
    initSql: ['SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci'],
  });
  const tuple = (result: unknown): [unknown, unknown] => [
    result,
    (result as { meta?: unknown } | null)?.meta,
  ];
  const args = (params?: readonly unknown[]): unknown[] | undefined =>
    params === undefined ? undefined : [...params];
  // The engine keys its one-time per-connection session setup on `.connection` — mysql2's
  // stable core under per-borrow wrappers. mariadb also hands out a fresh wrapper per borrow,
  // so each physical connection (threadId) gets one stable key object here.
  const keys = new Map<number, object>();
  const keyFor = (threadId: number): object => {
    let key = keys.get(threadId);
    if (key === undefined) {
      key = {};
      keys.set(threadId, key);
    }
    return key;
  };
  return {
    query: async (sql, params) => tuple(await pool.query(sql, args(params))),
    getConnection: async () => {
      const conn = await pool.getConnection();
      const borrowed = {
        query: async (sql: string, params?: readonly unknown[]) =>
          tuple(await conn.query(sql, args(params))),
        release: () => {
          conn.release();
        },
        connection: keyFor(conn.threadId),
      };
      return borrowed;
    },
    end: async () => {
      keys.clear();
      await pool.end();
    },
  };
}
