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
 * The MySQL money installer's contract, as a host reaches it through `./sql-kit`.
 *
 * Two properties, both about what a live database survives a re-install: the routines are dropped
 * only when the stamp names a different version, and the stamp is written last, so a stamp at
 * DB_VERSION means the routines it certifies exist. Both are statements NOT sent, so each path
 * asserts the exact count executed — a reorder that put the destructive statements back would
 * satisfy every assertion about the end state.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import {
  DB_VERSION,
  installMysql,
  moneyMysql,
  proveMysql,
} from '#src/money-sql.ts';
import { vectors } from '#src/money-arithmetic.ts';
import { onThrowawayMysqlDatabase } from '#test/support/adapters.ts';
import {
  describeEngine,
  pinEngineGateRoster,
} from '#test/support/engine-gate.ts';

import type { SqlRunner } from '#src/money-sql.ts';
import type { MysqlPool } from '@pwngh/economy-mysql';

/** The one read the installer makes: everything else in the list writes. */
const STAMP_READ = 'select version from money_meta';

const isDrop = (sql: string): boolean => /^\s*drop\b/i.test(sql);
const isStamp = (sql: string): boolean => /^\s*(delete|insert)\b/i.test(sql);
const isCreateFunction = (sql: string): boolean =>
  /^\s*create\s+function\b/i.test(sql);

/**
 * A runner with no database behind it: it records every statement and answers the stamp read with
 * the rows given, or throws them.
 */
function recordingRunner(stamp: Record<string, unknown>[] | Error): {
  runner: SqlRunner;
  executed: string[];
} {
  const executed: string[] = [];
  return {
    executed,
    runner: {
      run: (sql) => {
        executed.push(sql);
        if (!/^\s*select\b/i.test(sql)) return Promise.resolve([]);
        return stamp instanceof Error
          ? Promise.reject(stamp)
          : Promise.resolve(stamp.map((row) => ({ ...row })));
      },
    },
  };
}

/** Records what a live runner is asked to run, without changing what it does. */
function watch(runner: SqlRunner, into: string[]): SqlRunner {
  return {
    run: (sql, params) => {
      into.push(sql);
      return runner.run(sql, params);
    },
  };
}

function runnerFor(pool: MysqlPool): SqlRunner {
  return {
    run: (sql, params) =>
      pool
        .query(sql, params ? [...params] : undefined)
        .then(([rows]) => rows as Record<string, unknown>[]),
  };
}

describe('the MySQL money install statement list', () => {
  // The stamp is the only thing anyone checks, so nothing that runs before the routines exist may
  // write it. Read off the list rather than off a run, so the ordering holds for the projected
  // `out/money.mysql.sql` too.
  test('every routine is created before the first statement that stamps', () => {
    const creates = moneyMysql.flatMap((sql, i) =>
      isCreateFunction(sql) ? [i] : [],
    );
    const stamps = moneyMysql.flatMap((sql, i) => (isStamp(sql) ? [i] : []));

    assert.equal(creates.length, 2, 'the routine roster moved');
    assert.equal(stamps.length, 2, 'the stamp is no longer two statements');
    assert.ok(
      Math.min(...stamps) > Math.max(...creates),
      `a stamp at statement ${Math.min(...stamps)} runs before the routine at ${Math.max(...creates)}, so a run that dies between them certifies a database that cannot compute`,
    );
  });

  // MySQL has no CREATE OR REPLACE for a stored function (parse error 1064 on 8.4.10), so the
  // create carries its own idempotence or the drop before it is mandatory.
  test('every routine create is idempotent on its own', () => {
    const creates = moneyMysql.filter(isCreateFunction);
    assert.equal(creates.length, 2);
    assert.deepEqual(
      creates.map((sql) => /^create function if not exists /.test(sql)),
      [true, true],
    );
  });
});

describe('installMysql, with no database behind it', () => {
  test('an unstamped database gets the whole list, in order', async () => {
    const { runner, executed } = recordingRunner([]);

    await installMysql(runner);

    assert.equal(executed.length, moneyMysql.length + 1);
    assert.equal(executed[1], STAMP_READ);
    assert.deepEqual(executed.toSpliced(1, 1), [...moneyMysql]);
  });

  // The defect this file exists for: a host calling the published installer against a database
  // already at this version used to have its live routines dropped out from under it.
  test('a database already at DB_VERSION is never dropped into', async () => {
    const { runner, executed } = recordingRunner([{ version: DB_VERSION }]);

    await installMysql(runner);

    assert.equal(
      executed.length,
      6,
      `an install over a current stamp ran ${executed.length} statements: ${executed.map((sql) => sql.split('\n')[0]).join(' | ')}`,
    );
    assert.deepEqual(executed.filter(isDrop), []);
    assert.equal(executed.filter(isCreateFunction).length, 2);
  });

  test('a stamp at another version is replaced, routines and all', async () => {
    const { runner, executed } = recordingRunner([{ version: DB_VERSION - 1 }]);

    await installMysql(runner);

    assert.equal(executed.length, moneyMysql.length + 1);
    assert.equal(executed.filter(isDrop).length, 2);
  });

  test('an unreadable stamp installs rather than trusting it', async () => {
    const { runner, executed } = recordingRunner(
      new Error("Table 'money_meta' doesn't exist"),
    );

    await installMysql(runner);

    assert.equal(executed.length, moneyMysql.length + 1);
    assert.equal(executed.filter(isDrop).length, 2);
  });
});

// Its own database every time: applying this against the shared `economy_lab` drops the routines
// whichever suite is mid-run is calling.
describeEngine('mysql', 'installMysql, against a live MySQL', (rig) => {
  rig.test(
    'a second install against an installed database issues no drop',
    async (url) => {
      await onThrowawayMysqlDatabase(url, async (pool) => {
        const runner = runnerFor(pool);
        await installMysql(runner);
        assert.deepEqual(await proveMysql(runner, vectors), []);

        const executed: string[] = [];
        await installMysql(watch(runner, executed));

        assert.equal(
          executed.length,
          6,
          `a re-install ran ${executed.length} statements against a database already at DB_VERSION`,
        );
        assert.deepEqual(executed.filter(isDrop), []);
        assert.deepEqual(await proveMysql(runner, vectors), []);
      });
    },
  );

  rig.test('a run that dies before the stamp leaves no stamp', async (url) => {
    await onThrowawayMysqlDatabase(url, async (pool) => {
      const runner = runnerFor(pool);
      for (const sql of moneyMysql.slice(0, moneyMysql.findIndex(isStamp))) {
        await runner.run(sql);
      }

      // The routines are live — the database can compute — but nothing says so.
      const [computed] = await runner.run(
        "select cast(money_div_round(7, 2, 'halfEven') as char) as r",
      );
      assert.equal(String(computed?.['r']), '4');
      assert.deepEqual(await runner.run('select version from money_meta'), []);
      assert.deepEqual(await proveMysql(runner, vectors), [
        `meta version undefined, package expects ${DB_VERSION}`,
      ]);

      await installMysql(runner);
      assert.deepEqual(await proveMysql(runner, vectors), []);
    });
  });

  rig.test('a stamp at another version is repaired', async (url) => {
    await onThrowawayMysqlDatabase(url, async (pool) => {
      const runner = runnerFor(pool);
      await installMysql(runner);
      await runner.run(`update money_meta set version = ${DB_VERSION + 1}`);

      const executed: string[] = [];
      await installMysql(watch(runner, executed));

      assert.equal(executed.length, moneyMysql.length + 1);
      assert.equal(executed.filter(isDrop).length, 2);
      assert.deepEqual(await proveMysql(runner, vectors), []);
    });
  });
});

pinEngineGateRoster([
  'installMysql, against a live MySQL › a second install against an installed database issues no drop',
  'installMysql, against a live MySQL › a run that dies before the stamp leaves no stamp',
  'installMysql, against a live MySQL › a stamp at another version is repaired',
]);
