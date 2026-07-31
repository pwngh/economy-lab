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

import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { runStoreConformance } from '#test/conformance/store.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysql,
  mysqlStore,
} from '@pwngh/economy-mysql';
import { createMariadbPool } from '@pwngh/economy-mysql/mariadb';
import { spendable } from '#src/accounts.ts';
import {
  makeIsolatedMysqlStore,
  testMysqlUrl,
} from '#test/support/adapters.ts';
import {
  describeEngine,
  pinEngineGateRoster,
} from '#test/support/engine-gate.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { MysqlPool } from '@pwngh/economy-mysql';

// Empty when nothing names MySQL, which the factories below hand to the driver: the open refuses,
// and runStoreConformance's probe turns that refusal into a skip on every test it owns.
const url = testMysqlUrl(process.env) ?? '';

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
  // Same reason on the clean path: this pool was built here, so this suite ends it. mysqlStore
  // leaves a pool it was handed alone.
  const store = mysqlStore({ pool });
  return {
    ...store,
    close: async () => {
      await store.close();
      await pool.end();
    },
  };
});

// The mariadb pool (@pwngh/economy-mysql/mariadb) must be runtime-identical behind the same
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
describeEngine(
  'mysql',
  'bigNumberStrings returns every numeric result as a string',
  (rig) => {
    const drivers: Array<{
      name: string;
      open: (at: string) => Promise<MysqlPool>;
    }> = [
      { name: 'mysql2', open: (at) => createMysqlPool(at) },
      { name: 'mariadb', open: (at) => createMariadbPool(at) },
    ];
    for (const { name, open } of drivers) {
      rig.test(
        `${name}: raw SELECT 1 comes back as the string '1', pool and connection alike`,
        async (at, t) => {
          let pool: MysqlPool;
          try {
            pool = await open(at);
          } catch (error) {
            // mariadb is an optional peer, so its absence is a skip and not a failure. The server
            // itself already answered the suite's probe.
            t.skip(`${name} driver unavailable: ${(error as Error).message}`);
            return;
          }
          try {
            const [viaPool] = await pool.query('SELECT 1 AS one');
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
        },
      );
    }
  },
);

// GET_LOCK returns 0 when the wait elapsed and NULL on error or kill — both mean the lock is NOT
// held, so lock must surface a transient conflict (errno 1205) for withTransientRetry rather than
// proceed as if it held the lock. Only the GET_LOCK statement is answered here; everything else
// reaches a real isolated database, because the store's open-path money proof runs before the
// first operation and a stub pool cannot satisfy it.
function stubGetLock(acquired: number | null): (pool: MysqlPool) => MysqlPool {
  return (pool) => ({
    query: (async (sql: string, params?: readonly unknown[]) =>
      /GET_LOCK\(/i.test(sql)
        ? [[{ acquired }], undefined]
        : pool.query(sql, params)) as MysqlPool['query'],
    getConnection: () => pool.getConnection(),
    end: () => pool.end(),
  });
}

describeEngine('mysql', 'MySQL ledger.lock GET_LOCK return handling', (rig) => {
  const openStubbed = (at: string, acquired: number | null) =>
    makeIsolatedMysqlStore({
      url: at,
      digest: seededDigest(1),
      clock: fixedClock(0),
      wrapPool: stubGetLock(acquired),
    });

  for (const acquired of [0, null] as Array<number | null>) {
    rig.test(
      `throws a transient conflict (errno 1205) when GET_LOCK returns ${acquired}`,
      async (at) => {
        const store = await openStubbed(at, acquired);
        try {
          await assert.rejects(
            store.ledger.lock(spendable('usr_x')),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              (error as { errno?: unknown }).errno === 1205,
          );
        } finally {
          await store.close();
        }
      },
    );
  }

  rig.test(
    'resolves when GET_LOCK returns 1 (the lock is held)',
    async (at) => {
      const store = await openStubbed(at, 1);
      try {
        await store.ledger.lock(spendable('usr_x'));
      } finally {
        await store.close();
      }
    },
  );
});

// A transaction uses exactly one pool connection for its whole life, so concurrency above the
// pool limit queues and drains instead of starving. Regression for the wedge where every
// in-flight transaction planted first-use rows through the pool and full occupancy left all of
// them waiting forever for a connection none could release.
describeEngine('mysql', 'mysql pool occupancy', (rig) => {
  rig.test(
    'concurrent first-use transactions above the pool limit all commit',
    async (at) => {
      const pool = await createMysqlPool(at, { connectionLimit: 4 });
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
    },
  );
});

// The one-call factory does the whole staged open itself: pool, schema gate, money install and
// proof. A caller that imports nothing but `mysql` still gets a store no posting can distrust.
describeEngine('mysql', 'mysql(url): the one-call open', (rig) => {
  rig.test(
    'returns a store whose schema stamp and money routines were already proven',
    async (at) => {
      const store = await mysql(at);
      try {
        const balance = await store.ledger.balance(spendable('usr_open_1'));
        assert.equal(balance.minor, 0n);
      } finally {
        await store.close();
      }
    },
  );

  rig.test(
    'refuses a reachable database that carries no schema stamp',
    async (at) => {
      const probe = `economy_lab_open_${crypto.randomUUID().slice(0, 8)}`;
      const admin = await createMysqlPool(at);
      try {
        await admin.query(`CREATE DATABASE \`${probe}\``);
        const probeUrl = at.replace(/\/[^/?]+(\?|$)/, `/${probe}$1`);
        await assert.rejects(mysql(probeUrl), /schema version 18/);
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS \`${probe}\``);
        await admin.end();
      }
    },
  );
});

// Eight tests over four suites, whatever the environment holds. Before this file registered them
// unconditionally an unconfigured run reported none of them and no line saying so.
pinEngineGateRoster([
  "bigNumberStrings returns every numeric result as a string › mysql2: raw SELECT 1 comes back as the string '1', pool and connection alike",
  "bigNumberStrings returns every numeric result as a string › mariadb: raw SELECT 1 comes back as the string '1', pool and connection alike",
  'MySQL ledger.lock GET_LOCK return handling › throws a transient conflict (errno 1205) when GET_LOCK returns 0',
  'MySQL ledger.lock GET_LOCK return handling › throws a transient conflict (errno 1205) when GET_LOCK returns null',
  'MySQL ledger.lock GET_LOCK return handling › resolves when GET_LOCK returns 1 (the lock is held)',
  'mysql pool occupancy › concurrent first-use transactions above the pool limit all commit',
  'mysql(url): the one-call open › returns a store whose schema stamp and money routines were already proven',
  'mysql(url): the one-call open › refuses a reachable database that carries no schema stamp',
]);
