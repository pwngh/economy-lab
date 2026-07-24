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

// The pipelining-capable MySQL pool: the mariadb driver behind the same {@link MysqlPool} seam
// createMysqlPool fills with mysql2. A host opt-in — install `mariadb` (an optional peer, like
// mysql2), build the pool here, and hand it to mysqlStore; every engine statement above the
// seam is identical. The difference is the wire: mysql2's command queue holds one command in
// flight per connection, while mariadb writes the next command before the previous response
// returns.

// The engine module is import-restricted inside src, so unused optional drivers never load; the
// seam is therefore re-declared here rather than imported from engines/mysql.
interface MysqlConnection {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<[unknown, unknown]>;
  release(): void;
}
/**
 * The pool seam `mysqlStore` rides, declared structurally: the seam is a shape, not a name, so
 * `mysqlStore` accepts any pool with these three members — the `mysql2` pool `createMysqlPool`
 * builds, or the `mariadb` pool {@link createMariadbPool} builds here. `query` resolves a tuple
 * whose first slot holds rows for a SELECT or an affected-rows header for a write.
 */
export interface MysqlPool {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<[unknown, unknown]>;
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
}

// Only the slice of the mariadb driver this factory calls, declared by hand so the optional
// dependency never enters type resolution.
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
 * Create a {@link MysqlPool} from a connection URL using the `mariadb` driver — the
 * pipelining-capable opt-in behind the same seam `createMysqlPool` fills with `mysql2`. Same
 * store, same schema, same SQL: hand the pool to `mysqlStore` and every statement above the seam
 * is identical. The difference is the wire: mysql2's command queue holds one command in flight
 * per connection, while mariadb writes the next command before the previous response returns.
 *
 * Matches the mysql2 pool's configuration: big integer and decimal columns come back as exact
 * strings (the engine converts them to bigint), and the connection collation is pinned to the
 * schema's utf8mb4 default. `connectionLimit` caps the pool exactly as on `createMysqlPool` and
 * defaults to 10; each in-flight transaction holds one connection, so size it to at least the
 * number of concurrent submits. The URL must carry no query parameters — this factory maps the
 * URL to driver config by hand and throws rather than silently drop options mysql2 would honor.
 *
 * @example
 * import { createMariadbPool } from '@pwngh/economy-lab/engines/mysql-mariadb';
 * import { mysqlStore } from '@pwngh/economy-lab/engines/mysql';
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
  // Same runtime-only import discipline as createMysqlPool: the module name in a variable keeps
  // the optional dependency out of build-time resolution and out of bundles.
  const specifier = 'mariadb';
  const mariadb = (await import(/* @vite-ignore */ specifier)) as unknown as {
    default: { createPool(config: Record<string, unknown>): MariadbPool };
  };
  const u = new URL(url);
  // This factory builds the config by hand and has no clean mapping for query parameters, so a
  // URL carrying them fails loudly instead of losing options the mysql2 pool would honor.
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
