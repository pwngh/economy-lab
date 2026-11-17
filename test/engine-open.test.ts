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

/**
 * The SQL open path's fail-fast rules, all provable with no live database. A host that accepts
 * the socket and never speaks must end the open on a bound instead of hanging it. A failed
 * `schema_meta` read must tell an unreachable database from one needing a schema migration.
 * Neither a missing stamp nor an old version means existing data is safe to erase. And a pool
 * must carry an 'error' listener, because a dropped idle connection emits one and an unlistened
 * 'error' event ends the process.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';

import '#test/support/dist-guard.ts';

import { memoryPorts, openPorts } from '#src/index.ts';
import { postgresStore } from '@pwngh/economy-postgres';
import {
  createMysqlPool,
  mysqlStore,
  readSchemaVersion,
} from '@pwngh/economy-mysql';
import { loadPg, openPgPool } from '@pwngh/economy-postgres/driver';
import { DEFAULT_CONNECT_TIMEOUT_MS } from '#src/engines/sql-shared.ts';
import { assertSchemaCurrent, SCHEMA_VERSION } from '#src/schema.ts';

import type { PgPool } from '@pwngh/economy-postgres';
import type { MysqlPool } from '@pwngh/economy-mysql';

// Accepts every connection and then says nothing: the routable-but-stalled host whose open used
// to hang forever. Sockets are held open until close(), so nothing hands the client an EOF.
async function deafHost(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `127.0.0.1:${port}/economy`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

// Fails the run if the open outlived its bound, naming what it waited on.
function within(startedAt: number, bound: number, what: string): void {
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed <= bound,
    `${what} took ${elapsed}ms, past its ${bound}ms bound`,
  );
}

// A pg pool that answers every query the same way. `end` is here because postgresStore ends the
// pool it owns when the open throws.
function pgPoolAnswering(answer: () => Promise<{ rows: unknown[] }>): PgPool {
  return {
    connect: () => Promise.reject(new Error('unused')),
    query: () =>
      answer().then((result) => ({
        rows: result.rows as Array<Record<string, unknown>>,
        rowCount: result.rows.length,
      })),
    end: () => Promise.resolve(),
  };
}

function mysqlPoolAnswering(answer: () => Promise<unknown[]>): MysqlPool {
  return {
    query: () =>
      answer().then((rows) => [rows, undefined] as [unknown, unknown]),
    getConnection: () => Promise.reject(new Error('unused')),
    end: () => Promise.resolve(),
  };
}

/** A pool the caller built, plus a count of how many times something ended it. */
type CountedPool<TPool> = { pool: TPool; ends: () => number };

function countingPgPool(
  answer: () => Promise<{ rows: unknown[] }>,
): CountedPool<PgPool> {
  let ends = 0;
  return {
    pool: {
      connect: () => Promise.reject(new Error('unused')),
      query: () =>
        answer().then((result) => ({
          rows: result.rows as Array<Record<string, unknown>>,
          rowCount: result.rows.length,
        })),
      end: () => {
        ends += 1;
        return Promise.resolve();
      },
    },
    ends: () => ends,
  };
}

function countingMysqlPool(): CountedPool<MysqlPool> {
  let ends = 0;
  return {
    pool: {
      query: () => Promise.resolve([[], undefined] as [unknown, unknown]),
      getConnection: () => Promise.reject(new Error('unused')),
      end: () => {
        ends += 1;
        return Promise.resolve();
      },
    },
    ends: () => ends,
  };
}

const failing = (error: Error) => () => Promise.reject(error);

const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
  });

const undefinedTable = () =>
  Object.assign(new Error('relation "schema_meta" does not exist'), {
    code: '42P01',
  });

const noSuchTable = () =>
  Object.assign(new Error("Table 'economy.schema_meta' doesn't exist"), {
    errno: 1146,
    code: 'ER_NO_SUCH_TABLE',
  });

// What a server-side kill of an idle connection raises on the pool: a failover, an idle timeout
// the server enforces, an operator's pg_terminate_backend.
const dropped = () =>
  Object.assign(
    new Error('terminating connection due to administrator command'),
    { code: '57P01' },
  );

// Stands in for the driver's pool while a test runs. It extends EventEmitter, so an unlistened
// 'error' throws exactly as `pg`'s own pool does, and it records the config it was built with.
// Every query fails, which ends an open that has no live database behind it.
class FakePool extends EventEmitter {
  static built: FakePool[] = [];
  config: Record<string, unknown>;

  constructor(config: Record<string, unknown>) {
    super();
    this.config = config;
    FakePool.built.push(this);
  }

  query(): Promise<never> {
    return Promise.reject(refused());
  }

  ends = 0;

  end(): Promise<void> {
    this.ends += 1;
    return Promise.resolve();
  }
}

// Swaps the driver's Pool constructor for FakePool while `run` executes, then hands back every
// pool it built. The module object read here is the one the engine holds, so the swap reaches it.
async function poolsBuiltDuring(
  run: () => Promise<unknown>,
): Promise<FakePool[]> {
  const driver = (await loadPg()) as unknown as { Pool: unknown };
  const real = driver.Pool;
  FakePool.built = [];
  driver.Pool = FakePool;
  try {
    await run();
  } finally {
    driver.Pool = real;
  }
  return FakePool.built;
}

describe('the SQL open path bounds its connect wait', () => {
  test('postgres fails on the bound it was given, not on the socket', async () => {
    const host = await deafHost();
    try {
      const startedAt = Date.now();
      await assert.rejects(
        postgresStore({
          url: `postgres://econ:secret@${host.url}`,
          connectionTimeoutMillis: 250,
        }),
      );
      within(startedAt, 5_000, 'the postgres open');
    } finally {
      await host.close();
    }
  });

  test(
    'postgres given no bound falls back to the engine default, never to forever',
    { timeout: DEFAULT_CONNECT_TIMEOUT_MS * 3 },
    async () => {
      const host = await deafHost();
      try {
        const startedAt = Date.now();
        await assert.rejects(
          postgresStore({ url: `postgres://econ:secret@${host.url}` }),
        );
        within(
          startedAt,
          DEFAULT_CONNECT_TIMEOUT_MS * 2,
          'the postgres open with no configured bound',
        );
      } finally {
        await host.close();
      }
    },
  );

  // openPorts opens no SQL engine of its own — it reads DATABASE_URL to decide what is missing — so
  // what it owes this knob is the value, in the bag the host hands its engine package. The bound
  // itself is honoured by that package, two tests up. Asserting a rejection here instead reads as a
  // timeout test and is not one: nothing opens a socket, so the 250 is never waited on.
  test('DB_CONNECT_TIMEOUT_MS reaches the bag openPorts hands the host', async () => {
    const ports = await openPorts(
      {
        DATABASE_URL: 'postgres://econ:secret@db:5432/economy',
        DB_CONNECT_TIMEOUT_MS: '250',
      },
      // The store is supplied because a named engine without one is refused at preflight.
      { store: memoryPorts({ signingKey: 'engine-open-key' }).store },
    );
    try {
      assert.equal(ports.config.dbConnectTimeoutMs, 250);
    } finally {
      await ports.store.close();
    }
  });

  test('mysql fails on the bound it was given', async () => {
    const host = await deafHost();
    const pool = await createMysqlPool(`mysql://econ:secret@${host.url}`, {
      connectTimeout: 250,
    });
    try {
      const startedAt = Date.now();
      await assert.rejects(pool.query('SELECT 1'));
      within(startedAt, 5_000, 'the mysql connect');
    } finally {
      await pool.end().catch(() => {});
      await host.close();
    }
  });
});

describe('a failed schema_meta read tells unreachable from un-migrated', () => {
  const protectsExistingData = (error: Error) => {
    assert.match(
      error.message,
      /plan a data-preserving migration before upgrading/,
    );
    assert.match(error.message, /`make db-migrate` drops and recreates tables/);
    assert.match(
      error.message,
      /use it only to reset an empty or disposable database/,
    );
    assert.doesNotMatch(error.message, /Re-apply the schema with/);
    return true;
  };

  const unmigrated = (error: Error) => {
    assert.match(error.message, /no schema_meta row/);
    return protectsExistingData(error);
  };

  const unreachable = (cause: Error) => (error: Error) => {
    assert.match(error.message, /unreachable/);
    // A connection failure needs no schema reset or migration advice.
    assert.equal(/db-migrate/.test(error.message), false);
    assert.equal(/no schema_meta row/.test(error.message), false);
    assert.equal(error.cause, cause);
    return true;
  };

  test('version 19 needs a planned migration that preserves existing data', () => {
    assert.throws(
      () => assertSchemaCurrent('19', 'mysql'),
      (error: Error) => {
        assert.match(error.message, /is at schema version 19/);
        assert.ok(
          error.message.includes(`expects schema version ${SCHEMA_VERSION}`),
        );
        return protectsExistingData(error);
      },
    );
  });

  test('a missing schema stamp does not make the database safe to reset', () => {
    assert.throws(() => assertSchemaCurrent(null, 'mysql'), unmigrated);
  });

  test('postgres: a reachable database with no schema_meta row is un-migrated', async () => {
    await assert.rejects(
      postgresStore({
        url: 'postgres://econ:secret@127.0.0.1:5432/economy',
        pool: pgPoolAnswering(() => Promise.resolve({ rows: [] })),
      }),
      unmigrated,
    );
  });

  test('postgres: a missing schema_meta table is un-migrated', async () => {
    await assert.rejects(
      postgresStore({
        url: 'postgres://econ:secret@127.0.0.1:5432/economy',
        pool: pgPoolAnswering(failing(undefinedTable())),
      }),
      unmigrated,
    );
  });

  test('postgres: an unreachable database is never reported as un-migrated', async () => {
    const cause = refused();
    await assert.rejects(
      postgresStore({
        url: 'postgres://econ:secret@127.0.0.1:5432/economy',
        pool: pgPoolAnswering(failing(cause)),
      }),
      unreachable(cause),
    );
  });

  test('mysql: a reachable database with no schema_meta row reads null', async () => {
    assert.equal(
      await readSchemaVersion(mysqlPoolAnswering(() => Promise.resolve([]))),
      null,
    );
  });

  test('mysql: a missing schema_meta table reads null', async () => {
    assert.equal(
      await readSchemaVersion(mysqlPoolAnswering(failing(noSuchTable()))),
      null,
    );
  });

  test('mysql: an unreachable database throws instead of reading null', async () => {
    const cause = refused();
    await assert.rejects(
      readSchemaVersion(mysqlPoolAnswering(failing(cause))),
      unreachable(cause),
    );
  });
});

// Ownership follows creation: the engine ends the pool it opened and leaves the caller's alone.
// Both directions are asserted, because a gate that ended nothing would pass the first half.
describe('a pool the caller supplied outlives the store', () => {
  const url = 'postgres://econ:secret@127.0.0.1:5432/economy';

  test('postgres: a failed open leaves a caller-supplied pool open', async () => {
    const caller = countingPgPool(failing(refused()));
    await assert.rejects(postgresStore({ url, pool: caller.pool }));
    assert.equal(caller.ends(), 0);
  });

  test('postgres: a failed open still ends the pool the store opened', async () => {
    const built = await poolsBuiltDuring(() =>
      assert.rejects(postgresStore({ url })),
    );
    assert.equal(built.length, 1);
    assert.equal(built[0]!.ends, 1);
  });

  test('mysql: close() leaves a caller-supplied pool open', async () => {
    const caller = countingMysqlPool();
    await mysqlStore({ pool: caller.pool }).close();
    assert.equal(caller.ends(), 0);
  });
});

describe('a dropped idle connection never ends the process', () => {
  test("an unlistened 'error' on a pg pool is fatal — this is why", async () => {
    const driver = await loadPg();
    const pool = new driver.Pool({
      connectionString: 'postgres://econ:secret@127.0.0.1:5432/economy',
    }) as unknown as EventEmitter & { end(): Promise<void> };
    try {
      assert.equal(pool.listenerCount('error'), 0);
      // Node turns an unlistened 'error' into an uncaught exception, which is process death.
      assert.throws(() => pool.emit('error', dropped()));
    } finally {
      await pool.end();
    }
  });

  test('the postgres store listens on the pool it builds and reports what it hears', async () => {
    const counted: Array<[string, Record<string, string> | undefined]> = [];
    const logged: Array<[string, string, Record<string, unknown>]> = [];
    const built = await poolsBuiltDuring(() =>
      assert.rejects(
        postgresStore({
          url: 'postgres://econ:secret@127.0.0.1:5432/economy',
          meter: {
            count: (name, _n, tags) => counted.push([name, tags]),
            observe: () => {},
          },
          logger: {
            log: (level, event, fields) => logged.push([level, event, fields]),
          },
        }),
      ),
    );
    assert.equal(built.length, 1);
    const pool = built[0] as FakePool;
    assert.equal(pool.listenerCount('error'), 1);
    assert.doesNotThrow(() => pool.emit('error', dropped()));
    assert.deepEqual(counted, [['engine.pool.error', { engine: 'postgres' }]]);
    assert.deepEqual(logged, [
      [
        'error',
        'engine.pool.error',
        {
          engine: 'postgres',
          reason: 'terminating connection due to administrator command',
        },
      ],
    ]);
  });

  test('openPgPool hands the error to the caller that named a handler', async () => {
    const seen: unknown[] = [];
    const built = await poolsBuiltDuring(async () => {
      await openPgPool(
        { connectionString: 'postgres://econ:secret@127.0.0.1:5432/economy' },
        (error) => seen.push(error),
      );
    });
    const pool = built[0] as FakePool;
    const error = dropped();
    assert.doesNotThrow(() => pool.emit('error', error));
    assert.deepEqual(seen, [error]);
  });

  test('openPgPool with no handler warns rather than swallow', async () => {
    const warned: string[] = [];
    // Node's own warning listener prints to stderr; standing it down keeps the run's log clean.
    const printers = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', (warning: Error) => warned.push(warning.message));
    try {
      const built = await poolsBuiltDuring(async () => {
        await openPgPool({
          connectionString: 'postgres://econ:secret@127.0.0.1:5432/economy',
        });
      });
      const pool = built[0] as FakePool;
      assert.doesNotThrow(() => pool.emit('error', dropped()));
      // process.emitWarning delivers on the next tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeAllListeners('warning');
      for (const printer of printers) {
        process.on('warning', printer);
      }
    }
    assert.deepEqual(warned, [
      'terminating connection due to administrator command',
    ]);
  });
});

describe('openPgPool bounds its connect wait like the store does', () => {
  const url = 'postgres://econ:secret@127.0.0.1:5432/economy';

  test('no bound named falls back to the engine default', async () => {
    const built = await poolsBuiltDuring(() =>
      openPgPool({ connectionString: url }),
    );
    assert.equal(
      (built[0] as FakePool).config.connectionTimeoutMillis,
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
  });

  test('a named bound is passed through, and 0 keeps the driver unbounded', async () => {
    const built = await poolsBuiltDuring(async () => {
      await openPgPool({ connectionString: url, connectionTimeoutMillis: 250 });
      await openPgPool({ connectionString: url, connectionTimeoutMillis: 0 });
    });
    assert.deepEqual(
      built.map((pool) => pool.config.connectionTimeoutMillis),
      [250, 0],
    );
  });

  test('the bound ends a connect to a host that never speaks', async () => {
    const host = await deafHost();
    const pool = await openPgPool({
      connectionString: `postgres://econ:secret@${host.url}`,
      connectionTimeoutMillis: 250,
    });
    try {
      const startedAt = Date.now();
      await assert.rejects(pool.query('select 1'));
      within(startedAt, 5_000, 'the openPgPool connect');
    } finally {
      await pool.end();
      await host.close();
    }
  });
});
