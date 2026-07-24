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
import { createMariadbPool } from '#src/engines/mysql-mariadb.ts';
import { spendable } from '#src/accounts.ts';
import {
  makeIsolatedMysqlStore,
  testMysqlUrl,
} from '#test/support/adapters.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { MysqlPool } from '#src/engines/mysql.ts';

const url = testMysqlUrl(process.env);

// The conformance suite runs only when a mysql DATABASE_URL or MYSQL_TEST_URL points at a live
// MySQL; with no URL it registers no tests.
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

  // The mariadb pool (src/engines/mysql-mariadb.ts) must be runtime-identical behind the same
  // seam, so the whole conformance suite runs against it too. The driver is an optional peer;
  // absent, the factory throw becomes the suite's usual skip.
  runStoreConformance('mysql (mariadb wire)', () =>
    makeIsolatedMysqlStore({
      url,
      digest: seededDigest(1),
      clock: fixedClock(0),
      driver: 'mariadb',
    }),
  );

  // Both drivers run under bigNumberStrings, which stringifies every numeric result — raw
  // SELECT 1 included. The engine converts explicitly at each read; this pin is the loud
  // failure for the next raw-row read, or driver swap, that forgets.
  describe('bigNumberStrings returns every numeric result as a string', () => {
    const pools: Array<{ name: string; make: () => Promise<MysqlPool> }> = [
      { name: 'mysql2', make: () => createMysqlPool(url) },
      { name: 'mariadb', make: () => createMariadbPool(url) },
    ];
    for (const { name, make } of pools) {
      test(`${name}: raw SELECT 1 comes back as the string '1', pool and connection alike`, async (t) => {
        let pool: MysqlPool;
        try {
          pool = await make();
        } catch (error) {
          t.skip(`${name} driver unavailable: ${(error as Error).message}`);
          return;
        }
        try {
          let viaPool: unknown;
          try {
            [viaPool] = await pool.query('SELECT 1 AS one');
          } catch (error) {
            t.skip(`mysql backend unreachable: ${(error as Error).message}`);
            return;
          }
          assert.equal((viaPool as Array<{ one: unknown }>)[0]!.one, '1');
          const conn = await pool.getConnection();
          try {
            const [viaConn] = await conn.query('SELECT 1 AS one');
            assert.equal((viaConn as Array<{ one: unknown }>)[0]!.one, '1');
          } finally {
            conn.release();
          }
        } finally {
          await pool.end();
        }
      });
    }
  });
}

// GET_LOCK returns 0 when the wait elapsed and NULL on error or kill — both mean the lock is NOT
// held, so lock must surface a transient conflict (errno 1205) for withTransientRetry rather than
// proceed as if it held the lock. A stub pool supplies the GET_LOCK row; no live MySQL needed.
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

// A transaction uses exactly one pool connection for its whole life, so concurrency above the
// pool limit queues and drains instead of starving. Regression for the wedge where every
// in-flight transaction planted first-use rows through the pool and full occupancy left all of
// them waiting forever for a connection none could release.
if (url) {
  describe('mysql pool occupancy', () => {
    test('concurrent first-use transactions above the pool limit all commit', async () => {
      const pool = await createMysqlPool(url, { connectionLimit: 4 });
      try {
        await applyMysqlSchema(pool);
        const acquires: string[] = [];
        const waits: number[] = [];
        const store = mysqlStore({
          pool,
          meter: {
            count: (name) => {
              acquires.push(name);
            },
            observe: (name, value) => {
              if (name === 'engine.pool.acquire_ms') waits.push(value);
            },
          },
        });
        const run = `pool_${crypto.randomUUID().slice(0, 8)}`;
        const work = Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            store.transaction(async (unit) => {
              assert.notEqual(unit.ledger.lockMany, undefined);
              await unit.ledger.lockMany?.([spendable(`usr_${run}_${i}`)]);
            }),
          ),
        );
        const watchdog = new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('pool starved: transactions never drained')),
            20_000,
          );
          void work.finally(() => clearTimeout(timer));
        });
        await Promise.race([work, watchdog]);
        assert.equal(
          acquires.filter((name) => name === 'engine.pool.acquire').length,
          8,
        );
        assert.equal(waits.length, 8);
      } finally {
        await pool.end();
      }
    });
  });
}
