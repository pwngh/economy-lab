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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { runStoreConformance } from '#test/conformance/store.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '#src/engines/mysql.ts';
import { spendable } from '#src/accounts.ts';

import type { MysqlPool } from '#src/engines/mysql.ts';

const url = process.env.MYSQL_TEST_URL;

// Runs the shared Store conformance suite against this SQL engine. The suite needs a real database,
// so it only runs when MYSQL_TEST_URL points at a live MySQL. With no URL, it registers no tests.
// An empty run is not a false pass.
//
// The factory builds a fresh store per run. It opens a pool, creates the tables, then wraps the pool.
if (url) {
  runStoreConformance('mysql', async () => {
    const pool = await createMysqlPool(url);
    // End the pool if the schema apply throws (DDL contention when test files run in parallel).
    // The conformance probe turns the throw into a skip, but a leaked open connection keeps this
    // test process's event loop alive after its last test, so the run never exits.
    try {
      await applyMysqlSchema(pool);
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }
    return mysqlStore({ pool });
  });
}

// Checks how ledger.lock handles each GET_LOCK return value. This is a correctness property, not a
// conformance one, so it needs no live MySQL. A stub pool returns the GET_LOCK row we choose, and
// ledger.lock runs straight on that pool.
//
// GET_LOCK returns 0 when the wait elapsed and NULL on error or kill. Both mean the lock is NOT held.
// In that case lock must surface a transient lock-wait conflict (errno 1205) so that withTransientRetry
// re-runs the attempt. It must never proceed as if it held the lock. Proceeding would let two writers
// touch one account at the same time.
function poolReturningGetLock(acquired: number | null): MysqlPool {
  return {
    query: async (sql: string) =>
      [/GET_LOCK/i.test(sql) ? [{ acquired }] : [], undefined] as [
        unknown,
        unknown,
      ],
    getConnection: async () => {
      throw new Error('stub pool: getConnection is unused by this test');
    },
    end: async () => {},
  };
}

describe('MySQL ledger.lock GET_LOCK return handling', () => {
  for (const acquired of [0, null] as Array<number | null>) {
    test(`throws a transient conflict (errno 1205) when GET_LOCK returns ${acquired}`, async () => {
      const store = mysqlStore({ pool: poolReturningGetLock(acquired) });
      await assert.rejects(
        store.ledger.lock(spendable('usr_x')),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          (error as { errno?: unknown }).errno === 1205,
      );
    });
  }

  test('resolves when GET_LOCK returns 1 (the lock is held)', async () => {
    const store = mysqlStore({ pool: poolReturningGetLock(1) });
    await store.ledger.lock(spendable('usr_x'));
  });
});
