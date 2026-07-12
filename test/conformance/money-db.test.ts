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
import { openPgPool } from '#src/engines/pg-driver.ts';
import { storeUrls } from '#src/env.ts';

import type { SqlRunner } from '#src/db.vendored.ts';

const { postgres: postgresUrl, mysql: mysqlUrl } = storeUrls(process.env);

if (postgresUrl) {
  test('postgres implements the money semantics (install + prove)', async () => {
    const pool = await openPgPool({ connectionString: postgresUrl, max: 2 });
    const runner: SqlRunner = {
      run: (sql, params) => pool.query(sql, params).then((r) => r.rows),
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
