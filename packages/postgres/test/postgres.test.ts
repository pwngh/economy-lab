/// <reference types="node" />
/**
 * @pwngh/economy-postgres
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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runStoreConformance } from '@pwngh/economy-lab/testing';
import { spendable } from '@pwngh/economy-lab';
import { readMinor } from '@pwngh/economy-lab/sql-kit';

import { postgres, postgresStore } from '../src/index.js';
import { loadPg } from '../src/driver.js';

import type { Store } from '@pwngh/economy-lab/ports';
import type { PgPool } from '../src/index.js';

const url = process.env.PG_URL ?? process.env.DATABASE_URL ?? '';
const live = url.startsWith('postgres://') || url.startsWith('postgresql://');

// The schema file ships in the tarball beside dist/, and the engine resolves it one level up
// from there. A wrong relative path only surfaces at runtime on the isolated-schema path, which
// skips whenever the backend is unreachable — so it is asserted here instead.
describe('the package ships the schema its engine reads', () => {
  test('db/postgresql-schema.sql is where the engine looks for it', () => {
    const fromDist = fileURLToPath(
      new URL('../dist/../db/postgresql-schema.sql', import.meta.url),
    );
    assert.ok(existsSync(fromDist), `no schema file at ${fromDist}`);
  });
});

// One import, one call. Nothing about `pg`, no pool, no schema assert at the call site.
describe('postgres(url): the one-call open', () => {
  test('returns a store whose schema and money routines were proven inside', async (t) => {
    if (!live) {
      t.skip('no postgres URL configured');
      return;
    }
    const store = await postgres(url);
    try {
      const balance = await store.ledger.balance(spendable('usr_pkg_open'));
      assert.equal(balance.minor, 0n);
    } finally {
      await store.close();
    }
  });

  test('the pool-injection form builds the same store over a caller-owned wire', async (t) => {
    if (!live) {
      t.skip('no postgres URL configured');
      return;
    }
    const pg = await loadPg();
    const pool = new pg.Pool({ connectionString: url }) as unknown as PgPool;
    const store = await postgres({ pool });
    try {
      const balance = await store.ledger.balance(spendable('usr_pkg_pool'));
      assert.equal(balance.minor, 0n);
    } finally {
      await store.close();
    }
    // Ownership follows creation: this test built the pool, so close() left it open and this
    // test ends it. A pool the store had ended would refuse the query below.
    const alive = await pool.query('select 1 as one');
    assert.equal(alive.rows.length, 1);
    await pool.end();
  });
});

// `pg.types` is the pg-types module singleton, one registry per process, and every pool that
// names no `types` of its own reads it. Registering a parser there re-types that column for pools
// opened before the store, pools it never saw, and pools in other libraries that share the module.
// int8 and numeric are re-typed on the pool the engine opens instead, so a host's decimal stays a
// host's decimal.
const INT8_OID = 20;
const NUMERIC_OID = 1700;

interface TypeParsers {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

describe('a store re-types only the pool it opened', () => {
  const unreachable = 'postgres://econ:secret@127.0.0.1:1/none';

  test("an open leaves the driver's shared parsers reading text", async () => {
    const driver = (await loadPg()) as unknown as { types: TypeParsers };
    await assert.rejects(
      postgresStore({ url: unreachable, connectionTimeoutMillis: 250 }),
    );
    // pg's own defaults, stated outright: a value captured before the open would compare equal to
    // itself if an earlier test in this process had already re-typed the registry.
    assert.equal(
      driver.types.getTypeParser(NUMERIC_OID, 'text')('0.075'),
      '0.075',
    );
    assert.equal(driver.types.getTypeParser(INT8_OID, 'text')('42'), '42');
  });

  test('the pool it opens re-types int8 and numeric and nothing else', async () => {
    const driver = (await loadPg()) as unknown as {
      Pool: unknown;
      types: TypeParsers;
    };
    const configs: Array<{ types?: TypeParsers }> = [];
    const real = driver.Pool;
    driver.Pool = class {
      constructor(config: { types?: TypeParsers }) {
        configs.push(config);
      }
      on(): void {
        return undefined;
      }
      query(): Promise<never> {
        return Promise.reject(new Error('refused'));
      }
      end(): Promise<void> {
        return Promise.resolve();
      }
    };
    try {
      await assert.rejects(postgresStore({ url: unreachable }));
    } finally {
      driver.Pool = real;
    }
    assert.equal(configs.length, 1);
    const types = configs[0]?.types;
    assert.ok(types, 'the engine names its parsers on the pool it opens');
    const retyped: Array<[number, string]> = [];
    for (const format of ['text', 'binary']) {
      for (let oid = 0; oid <= 4_096; oid += 1) {
        const parse = types.getTypeParser(oid, format);
        if (parse !== driver.types.getTypeParser(oid, format)) {
          retyped.push([oid, format]);
        }
      }
    }
    // The exact roster, so a third re-typed column cannot arrive unnoticed.
    assert.deepEqual(retyped, [
      [INT8_OID, 'text'],
      [NUMERIC_OID, 'text'],
    ]);
    assert.equal(
      types.getTypeParser(INT8_OID, 'text')('9223372036854775807'),
      9223372036854775807n,
    );
  });

  // `schemaName` creates a schema before the stamp and money checks run, so a failure after that
  // point is a failed open with the factory's own schema still on the server. Two of them were
  // found on the rig at 71 objects each, left by opens that raced a schema bump.
  test('a failed open releases the schema it created, not just the pool', async () => {
    const fromPool: string[] = [];
    const client = {
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    };
    const pool: PgPool = {
      connect: async () => client,
      query: async (text: string) => {
        fromPool.push(text);
        if (text.includes('schema_meta')) {
          throw new Error('the stamp is unreadable');
        }
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined,
    };
    await assert.rejects(
      postgresStore({ url: '', pool, schemaName: 'q34_failed_open' }),
    );
    // The setup drop goes through a checked-out client; only the release drop reaches the pool.
    assert.deepEqual(
      fromPool.filter((text) => text.startsWith('drop schema')),
      ['drop schema if exists q34_failed_open cascade'],
    );
  });

  test('a host pool reads a decimal the same before and after a store opens', async (t) => {
    if (!live) {
      t.skip('no postgres URL configured');
      return;
    }
    const driver = await loadPg();
    const host = new driver.Pool({ connectionString: url });
    host.on('error', () => undefined);
    const read = async () =>
      (await host.query('select 0.075::numeric as rate, 42::bigint as big'))
        .rows[0];
    try {
      assert.deepEqual(await read(), { rate: '0.075', big: '42' });
      // The stamp gate is a different subject, and its verdict would decide this test's outcome
      // on a rig mid-migration. Everything that re-typed columns ran before it either way.
      const store = await postgresStore({ url, schema: 'skip' });
      try {
        // The recorded symptom: this read threw `Cannot convert 0.075 to a BigInt`.
        assert.deepEqual(await read(), { rate: '0.075', big: '42' });
      } finally {
        await store.close();
      }
    } finally {
      await host.end();
    }
  });
});

// The whole port contract, against a schema of this run's own so parallel runs never collide.
// Registered whatever the environment holds: with no URL the factory refuses in single-digit
// milliseconds and runStoreConformance's probe turns that into a skip on every test it owns, so an
// unconfigured run reports this suite rather than losing it.
runStoreConformance('economy-postgres', () =>
  postgresStore({
    url,
    schemaName: `pkg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
  }),
);

// A caller-supplied pool exactly as a reader would build one: `new pg.Pool({ connectionString })`
// plus the search_path this run's schema needs. It names no `types`, so every column it reads
// arrives as pg's default text. Both the control below and the conformance run open through here,
// because a control built beside the run rather than from it stops describing the run the day one
// of them changes.
const openCallerPool = async (schemaName: string): Promise<PgPool> => {
  const driver = await loadPg();
  const pool = new driver.Pool({
    connectionString: url,
    options: `-c search_path=${schemaName}`,
  });
  pool.on('error', () => undefined);
  return pool as unknown as PgPool;
};

// The positive control for the conformance run below. That run is named for driver defaults, and
// it would pass exactly as green over a pool that turned out to have BigInt parsers after all —
// green on the store, silent on the claim. So the pool is read first: pg's defaults hand back
// text, and text is the thing the engine has to tolerate.
describe('the caller-pool conformance runs over a pool with no BigInt parsers', () => {
  test('a pool built the conformance way reads int8 and numeric as text', async (t) => {
    if (!live) {
      t.skip(
        'no postgres URL configured: the parserless-pool claim went unmeasured',
      );
      return;
    }
    const pool = await openCallerPool('nonexistent_q62');
    try {
      const result = await pool.query(
        `select 42::bigint as small, 9223372036854775807::bigint as big,
                0.075::numeric as rate`,
      );
      assert.deepEqual(result.rows[0], {
        small: '42',
        big: '9223372036854775807',
        rate: '0.075',
      });
    } finally {
      await (pool as unknown as { end(): Promise<void> }).end();
    }
  });

  // The other half of the README's claim, and the reason it is not "parsers do not matter". Text
  // and BigInt both survive a value past 2^53; a parser that hands back a JS number does not, and
  // the loss is silent because BigInt() accepts the already-rounded number.
  test('the reader the engine uses is exact for text and BigInt, and not for a number', () => {
    const past2To53 = 9_007_199_254_740_993n;
    assert.equal(readMinor(past2To53.toString()), past2To53);
    assert.equal(readMinor(past2To53), past2To53);
    assert.notEqual(readMinor(Number(past2To53)), past2To53);
  });
});

runStoreConformance(
  'economy-postgres (caller pool, driver defaults)',
  async () => {
    const schemaName = `probe_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const pool = await openCallerPool(schemaName);
    const end = (): Promise<void> =>
      (pool as unknown as { end(): Promise<void> }).end();
    let store: Store;
    try {
      store = await postgresStore({ url: '', pool, schemaName });
    } catch (error) {
      // This factory built the pool, so a refused open ends it here. A pool nobody ends keeps the
      // test process's event loop alive past its last test, and the runner cancels rather than hangs.
      await end().catch(() => {});
      throw error;
    }
    return {
      ...store,
      close: async () => {
        await store.close();
        await end();
      },
    };
  },
);
