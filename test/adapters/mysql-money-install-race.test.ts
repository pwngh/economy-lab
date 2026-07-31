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

import { applyMysqlSchema, mysqlStore } from '@pwngh/economy-mysql';
import { installMysql, proveMysql } from '#src/money-sql.ts';
import { vectors } from '#src/money-arithmetic.ts';
import { spendable } from '#src/accounts.ts';
import { onThrowawayMysqlDatabase } from '#test/support/adapters.ts';
import {
  describeEngine,
  pinEngineGateRoster,
} from '#test/support/engine-gate.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { SqlRunner } from '#src/money-sql.ts';
import type { MysqlPool } from '@pwngh/economy-mysql';

const BOOTERS = 3;
const PROVE_ATTEMPTS = 12;

function runnerFor(pool: MysqlPool): SqlRunner {
  return {
    run: (sql, params) =>
      pool
        .query(sql, params ? [...params] : undefined)
        .then(([rows]) => rows as Record<string, unknown>[]),
  };
}

// Records every data-definition statement the store sends, on both halves of the pool seam:
// installAndProveMoney reads through `query` and installs through a borrowed connection.
function watchDdl(pool: MysqlPool, into: string[]): MysqlPool {
  const note = (sql: unknown): void => {
    if (/^\s*(create|drop|alter)\s/i.test(String(sql))) into.push(String(sql));
  };
  return {
    query: (sql, params) => {
      note(sql);
      return pool.query(sql, params);
    },
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        ...connection,
        query: (sql, params) => {
          note(sql);
          return connection.query(sql, params);
        },
        release: () => {
          connection.release();
        },
      };
    },
    end: () => Promise.resolve(),
  };
}

// The race under test is contention between callers sharing ONE database, and the shared
// `economy_lab` is what a parallel test file is using, so the probe brings its own and applies the
// ledger schema into it.
function onOwnDatabase(
  serverUrl: string,
  work: (pool: MysqlPool) => Promise<void>,
): Promise<void> {
  return onThrowawayMysqlDatabase(serverUrl, async (pool) => {
    await applyMysqlSchema(pool);
    await work(pool);
  });
}

describeEngine('mysql', 'the money install races nobody', (rig) => {
  // Q50. Opening a store used to issue `drop function if exists` then `create function` on every
  // open, against the database every other caller is already using. A live caller landing in that
  // window failed with `FUNCTION <db>.money_div_round does not exist`. The store open is the only
  // thing that changed; the proof below is what a concurrent caller sees while stores are opening.
  rig.test(
    'a store open never breaks a caller of the money routines',
    async (url) => {
      await onOwnDatabase(url, async (pool) => {
        const runner = runnerFor(pool);
        // The database starts installed and correct, which is the steady state a running
        // deployment is in. Nothing here needs new DDL.
        await installMysql(runner);
        assert.deepEqual(await proveMysql(runner, vectors), []);

        let stop = false;
        // A booter's own failure is the same defect seen from the other side, so it is collected
        // rather than thrown: a throw here would abort the run before the counted assertion below.
        const brokenOpens: string[] = [];
        const booters = Array.from({ length: BOOTERS }, async (_, i) => {
          while (!stop) {
            const store = mysqlStore({
              pool,
              digest: seededDigest(1),
              clock: fixedClock(0),
            });
            try {
              // Construction is lazy: the first operation is what runs the open checks.
              await store.ledger.balance(spendable(`usr_race_${i}`));
            } catch (error) {
              brokenOpens.push(String(error));
            }
            await store.close().catch(() => {});
          }
        });

        const failures: string[] = [];
        try {
          for (let attempt = 0; attempt < PROVE_ATTEMPTS; attempt += 1) {
            const result = await proveMysql(runner, vectors).catch(
              (error: unknown) => [`raised: ${String(error)}`],
            );
            if (result.length > 0) failures.push(result[0] as string);
          }
        } finally {
          stop = true;
          await Promise.all(booters);
        }

        assert.equal(
          failures.length,
          0,
          `${failures.length} of ${PROVE_ATTEMPTS} prove attempts failed while stores were opening: ${failures[0] ?? ''}`,
        );
        assert.equal(
          brokenOpens.length,
          0,
          `${brokenOpens.length} store opens broke each other: ${brokenOpens[0] ?? ''}`,
        );
      });
    },
  );

  // The same guard from the other side: a store open against an already-installed database must
  // issue no data-definition statement at all. Counted at the pool seam, so a re-worded statement
  // cannot slip through a text match on `drop`.
  rig.test(
    'a store open against an installed database issues no DDL',
    async (url) => {
      await onOwnDatabase(url, async (pool) => {
        await installMysql(runnerFor(pool));

        const ddl: string[] = [];
        const store = mysqlStore({
          pool: watchDdl(pool, ddl),
          digest: seededDigest(1),
          clock: fixedClock(0),
        });
        await store.ledger.balance(spendable('usr_race_ddl'));
        await store.close();

        assert.deepEqual(
          ddl,
          [],
          `store open issued ${ddl.length} DDL statement(s)`,
        );
      });
    },
  );

  // The cold-start half. A database that has never been installed must end up installed and
  // proven, and a herd of first opens must converge on ONE install rather than each running its
  // own drop/create pair. Counting the statements rather than waiting for a collision makes the
  // install lock's absence a deterministic failure instead of a probabilistic one.
  rig.test('concurrent first opens install exactly once', async (url) => {
    await onOwnDatabase(url, async (pool) => {
      const ddl: string[] = [];
      const watched = watchDdl(pool, ddl);

      const opened = await Promise.all(
        Array.from({ length: BOOTERS }, async (_, i) => {
          const store = mysqlStore({
            pool: watched,
            digest: seededDigest(1),
            clock: fixedClock(0),
          });
          const balance = await store.ledger.balance(
            spendable(`usr_cold_${i}`),
          );
          await store.close();
          return balance.minor;
        }),
      );

      assert.deepEqual(opened, [0n, 0n, 0n]);
      // moneyMysql's five data-definition statements: money_meta, then a drop/create pair per
      // routine. One booter's worth, whatever the herd size.
      assert.equal(
        ddl.length,
        5,
        `${BOOTERS} first opens issued ${ddl.length} DDL statements, not one install's 5`,
      );
      assert.deepEqual(await proveMysql(runnerFor(pool), vectors), []);
    });
  });
});

pinEngineGateRoster([
  'the money install races nobody › a store open never breaks a caller of the money routines',
  'the money install races nobody › a store open against an installed database issues no DDL',
  'the money install races nobody › concurrent first opens install exactly once',
]);
