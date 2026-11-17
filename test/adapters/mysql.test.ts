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

import { runStoreConformance } from '@pwngh/economy-conformance';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysql,
  mysqlStore,
} from '@pwngh/economy-mysql';
import { createMariadbPool } from '@pwngh/economy-mysql/mariadb';
import {
  balanceHoldAccount,
  earned,
  spendable,
  SYSTEM,
} from '#src/accounts.ts';
import { createBalanceHolds } from '#src/balance-holds.ts';
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SCHEMA_VERSION } from '#src/schema.ts';
import {
  makeIsolatedMysqlStore,
  testMysqlUrl,
} from '#test/support/adapters.ts';
import {
  describeEngine,
  pinEngineGateRoster,
} from '#test/support/engine-gate.ts';
import {
  fixedClock,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';

import type { MysqlConnection, MysqlPool } from '@pwngh/economy-mysql';

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

describeEngine('mysql', 'MySQL case-sensitive account and hold IDs', (rig) => {
  for (const driver of ['mysql2', 'mariadb'] as const) {
    rig.test(
      `${driver}: one posting and case-distinct holds keep balances separate`,
      async (at) => {
        const digest = seededDigest(1);
        let pool: MysqlPool | undefined;
        const store = await makeIsolatedMysqlStore({
          url: at,
          digest,
          clock: fixedClock(0),
          driver,
          connectionLimit: 2,
          wrapPool: (created) => {
            pool = created;
            return created;
          },
        });
        try {
          assert.ok(pool);
          const callerPool = pool;
          const assertCallerSessions = async () => {
            const connections: MysqlConnection[] = [];
            try {
              connections.push(await callerPool.getConnection());
              connections.push(await callerPool.getConnection());
              for (const connection of connections) {
                const [session] = await connection.query(
                  `SELECT @@character_set_client AS client, @@character_set_results AS results,
                          @@collation_connection AS collation`,
                );
                const original = (
                  session as Array<{
                    client: string;
                    results: string;
                    collation: string;
                  }>
                )[0]!;
                assert.deepEqual(
                  [original.client, original.results, original.collation],
                  ['utf8mb4', 'utf8mb4', 'utf8mb4_0900_ai_ci'],
                );
              }
            } finally {
              for (const connection of connections) connection.release();
            }
          };
          // Setup must return both sessions with their original settings.
          await assertCallerSessions();
          const [routines] = await pool.query(
            `SELECT ROUTINE_NAME AS name, COLLATION_CONNECTION AS creation_collation
             FROM information_schema.ROUTINES
             WHERE ROUTINE_SCHEMA = DATABASE()
               AND ROUTINE_NAME IN ('account_balance', 'post_entries', 'post_entry', 'trust_record')
             ORDER BY ROUTINE_NAME`,
          );
          assert.deepEqual(
            (
              routines as Array<{ name: string; creation_collation: string }>
            ).map((routine) => [routine.name, routine.creation_collation]),
            [
              ['account_balance', 'utf8mb4_0900_bin'],
              ['post_entries', 'utf8mb4_0900_bin'],
              ['post_entry', 'utf8mb4_0900_bin'],
              ['trust_record', 'utf8mb4_0900_bin'],
            ],
          );
          const setupFailure = new Error('injected schema setup failure');
          const interruptedPool: MysqlPool = {
            query: (sql, params) => callerPool.query(sql, params),
            getConnection: async () => {
              const connection = await callerPool.getConnection();
              return {
                query: async (sql, params) => {
                  // SET NAMES reaches the database; stop before any table changes.
                  if (/^\s*ALTER DATABASE\b/i.test(sql)) throw setupFailure;
                  return connection.query(sql, params);
                },
                release: () => connection.release(),
              };
            },
            end: () => callerPool.end(),
          };
          await assert.rejects(
            applyMysqlSchema(interruptedPool),
            (error: unknown) => error === setupFailure,
          );
          await assertCallerSessions();
          const owner = 'usr_Review';
          const otherOwner = 'usr_review';
          // Both accounts in one posting also exercise the routine's JSON_TABLE joins.
          await store.transaction(async (unit) => {
            await lockAll(unit.ledger, [
              SYSTEM.OPENING_EQUITY,
              earned(owner),
              earned(otherOwner),
            ]);
            await postEntry(unit.ledger, {
              txnId: 'txn_case_distinct_accounts',
              legs: [
                debit(SYSTEM.OPENING_EQUITY, toAmount('CREDIT', 3_000n)),
                credit(earned(owner), toAmount('CREDIT', 1_000n)),
                credit(earned(otherOwner), toAmount('CREDIT', 2_000n)),
              ],
              meta: { kind: 'seed', source: 'card' },
            });
          });
          assert.equal(
            (await store.ledger.balance(earned(owner))).minor,
            1_000n,
          );
          assert.equal(
            (await store.ledger.balance(earned(otherOwner))).minor,
            2_000n,
          );

          const holds = createBalanceHolds({
            store,
            config: testConfig(),
            digest,
          });
          for (const [holdId, minor] of [
            ['Review', 100n],
            ['review', 200n],
          ] as const) {
            await holds.place({
              userId: owner,
              holdId,
              amount: toAmount('CREDIT', minor),
              expiresAt: 10,
              now: 0,
            });
            assert.equal(
              (await store.ledger.balance(balanceHoldAccount(owner, holdId)))
                .minor,
              minor,
            );
          }
          await holds.release({
            userId: owner,
            holdId: 'Review',
            idempotencyKey: 'release_uppercase',
            now: 10,
          });
          assert.equal(
            (await store.ledger.balance(balanceHoldAccount(owner, 'Review')))
              .minor,
            0n,
          );
          assert.equal(
            (await store.ledger.balance(balanceHoldAccount(owner, 'review')))
              .minor,
            200n,
          );
          const first = await holds.read({ userId: owner, now: 10 });
          assert.equal(first.available.minor, 800n);
          assert.equal(first.reserved.minor, 200n);
          assert.equal(first.total.minor, 1_000n);
          const second = await holds.read({ userId: otherOwner, now: 10 });
          assert.equal(second.available.minor, 2_000n);
          assert.equal(second.reserved.minor, 0n);
          assert.equal(second.total.minor, 2_000n);
        } finally {
          await store.close();
        }
      },
    );
  }
});

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
        await assert.rejects(
          mysql(probeUrl),
          new RegExp(`schema version ${SCHEMA_VERSION}`),
        );
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS \`${probe}\``);
        await admin.end();
      }
    },
  );
});

// Ten tests over five suites, whatever the environment holds. Before this file registered them
// unconditionally an unconfigured run reported none of them and no line saying so.
pinEngineGateRoster([
  "bigNumberStrings returns every numeric result as a string › mysql2: raw SELECT 1 comes back as the string '1', pool and connection alike",
  "bigNumberStrings returns every numeric result as a string › mariadb: raw SELECT 1 comes back as the string '1', pool and connection alike",
  'MySQL case-sensitive account and hold IDs › mysql2: one posting and case-distinct holds keep balances separate',
  'MySQL case-sensitive account and hold IDs › mariadb: one posting and case-distinct holds keep balances separate',
  'MySQL ledger.lock GET_LOCK return handling › throws a transient conflict (errno 1205) when GET_LOCK returns 0',
  'MySQL ledger.lock GET_LOCK return handling › throws a transient conflict (errno 1205) when GET_LOCK returns null',
  'MySQL ledger.lock GET_LOCK return handling › resolves when GET_LOCK returns 1 (the lock is held)',
  'mysql pool occupancy › concurrent first-use transactions above the pool limit all commit',
  'mysql(url): the one-call open › returns a store whose schema stamp and money routines were already proven',
  'mysql(url): the one-call open › refuses a reachable database that carries no schema stamp',
]);
