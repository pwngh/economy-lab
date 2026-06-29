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

let url = process.env.MYSQL_TEST_URL;

// Shared Store conformance suite, run against this SQL engine. Requires a real database, so it
// only runs when MYSQL_TEST_URL points at a live MySQL; with no URL it registers nothing
// (an empty run, not a false pass).
//
// Factory builds a fresh store per run: open a pool, create the tables, wrap the pool.
if (url) {
  runStoreConformance('mysql', async () => {
    let pool = await createMysqlPool(url);
    await applyMysqlSchema(pool);
    return mysqlStore({ pool });
  });
}

// GET_LOCK return handling is a correctness property, not a conformance one, and needs no live MySQL:
// a stub pool returns the GET_LOCK row we choose, and ledger.lock runs straight on the pool. 0 (the
// wait elapsed) and NULL (error/killed) mean the lock is NOT held, so lock must surface a transient
// lock-wait conflict (errno 1205) for withTransientRetry to re-run — never proceed as if it held the
// lock, which would let two writers touch one account at once.
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
  for (let acquired of [0, null] as Array<number | null>) {
    test(`throws a transient conflict (errno 1205) when GET_LOCK returns ${acquired}`, async () => {
      let store = mysqlStore({ pool: poolReturningGetLock(acquired) });
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
    let store = mysqlStore({ pool: poolReturningGetLock(1) });
    await store.ledger.lock(spendable('usr_x'));
  });
});
