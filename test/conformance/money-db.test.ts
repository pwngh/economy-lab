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
 * Proves the host databases implement the money semantics. `src/money-sql.ts`
 * installs `div_round` and `split_bps` and re-runs the
 * div, muldiv, and bps conformance vectors against each live engine, so "the
 * database this deployment runs agrees with the money module" is a standing
 * assertion, not a hope. Each engine's suite registers whether or not its rig is
 * named; without one, its tests carry a skip that names the variable to set. An
 * empty run is not a false pass, and `pinEngineGateRoster` is what holds that.
 */

import assert from 'node:assert/strict';

import {
  installMysql,
  installPostgres,
  proveMysql,
  provePostgres,
} from '#src/money-sql.ts';
import { installMoneyRetrying } from '#src/engines/sql-shared.ts';
import { vectors } from '#src/money-arithmetic.ts';
import { openPgPool } from '@pwngh/economy-postgres/driver';
import {
  describeEngine,
  pinEngineGateRoster,
} from '#test/support/engine-gate.ts';
import { onThrowawayMysqlDatabase } from '#test/support/adapters.ts';

import type { SqlRunner } from '#src/money-sql.ts';

describeEngine('postgres', 'money semantics on a live Postgres', (rig) => {
  rig.test('installs the routines and proves every vector', async (url) => {
    const pool = await openPgPool({ connectionString: url, max: 2 });
    const runner: SqlRunner = {
      run: (sql, params) => pool.query(sql, params).then((r) => r.rows),
    };
    try {
      // The install is retried, because parallel test files boot stores that install the same shared functions.
      await installMoneyRetrying(() => installPostgres(runner));
      assert.deepEqual(await provePostgres(runner, vectors), []);
    } finally {
      await pool.end();
    }
  });
});

// On a database of its own, because MySQL has no CREATE OR REPLACE for a stored function: the
// install is `drop function` then `create function`, and on the shared database that window
// breaks whatever a parallel file is proving there. A fresh database is also the honest install
// case. The shared database's own arithmetic is proven by every store that opens against it —
// mysqlStore proves before its first operation.
describeEngine('mysql', 'money semantics on a live MySQL', (rig) => {
  rig.test('installs the routines and proves every vector', async (url) => {
    await onThrowawayMysqlDatabase(url, async (pool) => {
      const runner: SqlRunner = {
        run: (sql, params) =>
          pool
            .query(sql, params ? [...params] : undefined)
            .then(([rows]) => rows as Record<string, unknown>[]),
      };
      await installMoneyRetrying(() => installMysql(runner));
      assert.deepEqual(await proveMysql(runner, vectors), []);
    });
  });
});

// The tree's only cross-engine arithmetic gate, so the count is pinned rather than left to a total:
// a leg that stops registering fails here by name instead of shrinking the file to one passing test.
pinEngineGateRoster([
  'money semantics on a live Postgres › installs the routines and proves every vector',
  'money semantics on a live MySQL › installs the routines and proves every vector',
]);
