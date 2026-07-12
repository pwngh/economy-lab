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
 * Proves the host databases implement the money semantics. The vendored
 * @pwngh/money db carrier installs `div_round` and `split_bps` and re-runs the
 * div, muldiv, and bps conformance vectors against each live engine, so "the
 * database this deployment runs agrees with the money module" is a standing
 * assertion, not a hope. Each engine registers only when its URL is set, matching
 * the other engine-gated suites; an empty run is not a false pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  installMysql,
  installPostgres,
  proveMysql,
  provePostgres,
} from '#src/db.vendored.ts';
import { vectors } from '#src/money.vendored.ts';
import { createMysqlPool } from '#src/engines/mysql.ts';

import type { SqlRunner } from '#src/db.vendored.ts';

// Minimal slice of `pg`, which ships no types; typed at the binding below, the same
// pattern src/engines/postgres.ts and the taskq integration test use.
interface PgModule {
  Pool: new (config: { connectionString: string; max: number }) => {
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
}

const postgresUrl = process.env.DATABASE_URL;
const mysqlUrl = process.env.MYSQL_TEST_URL;

if (postgresUrl?.startsWith('postgres')) {
  test('postgres implements the money semantics (install + prove)', async () => {
    // @ts-expect-error -- untyped default import; typed at the binding via PgModule.
    const { default: pg } = (await import('pg')) as unknown as {
      default: PgModule;
    };
    const pool = new pg.Pool({ connectionString: postgresUrl, max: 2 });
    const runner: SqlRunner = {
      run: (sql, params) =>
        pool.query(sql, params ? [...params] : undefined).then((r) => r.rows),
    };
    try {
      await installPostgres(runner);
      assert.deepEqual(await provePostgres(runner, vectors), []);
    } finally {
      await pool.end();
    }
  });
}

if (mysqlUrl) {
  test('mysql implements the money semantics (install + prove)', async () => {
    const pool = await createMysqlPool(mysqlUrl);
    const runner: SqlRunner = {
      run: (sql, params) =>
        pool
          .query(sql, params ? [...params] : undefined)
          .then(([rows]) => rows as Record<string, unknown>[]),
    };
    try {
      await installMysql(runner);
      assert.deepEqual(await proveMysql(runner, vectors), []);
    } finally {
      await pool.end();
    }
  });
}
