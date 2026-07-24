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

// Wire-level pipelining instrument: what firing a connection's statements without awaiting each
// response reclaims, per statement and per hot-shape transaction. The incumbents can't pipeline
// (pg and mysql2 hold one command in flight); the trial drivers can. Each engine section reports
// the same three modes:
//
//   serial     one await per statement — the incumbents' wire discipline, on the trial driver
//   pipelined  the whole group fired before any response is read, one connection
//   reference  the incumbent driver, serial (its only mode)
//
// The hot shape mirrors the fused submit pipeline's five statements (begin / claim insert /
// lock read / write / commit) on a session temp table, so commits carry no durable write and
// the number isolates wire cost, not fsync.
//
//   npm i --no-save postgres                               # the postgres.js trial driver (mariadb ships as a devDependency)
//   sh scripts/docker.sh run --rm bench scripts/bench-wire.ts
//   BENCH_BACKENDS=postgres node scripts/bench-wire.ts

import { openPgPool } from '#src/engines/pg-driver.ts';
import { createMysqlPool } from '#src/engines/mysql.ts';
import { resolveConfig, resolveUrls } from '#scripts/support/harness.ts';

const cfg = resolveConfig(process.env);
const urls = resolveUrls(process.env);
const TXNS = 200;
const FLOOR_STATEMENTS = 256;
const GROUP = 8;

interface OneShot {
  run(sql: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

const ms = (t0: number): number => performance.now() - t0;
const per = (total: number, n: number): string => (total / n).toFixed(3);

function report(label: string, totalMs: number, n: number, unit: string): void {
  process.stdout.write(
    `    ${label.padEnd(11)} ${per(totalMs, n)}ms/${unit}\n`,
  );
}

// Serial: the awaited loop every current engine statement takes. Pipelined: the same statements
// all in flight before the first response is read — on a single connection, so ordering holds.
async function floor(conn: OneShot, pipelined: boolean): Promise<number> {
  const t0 = performance.now();
  if (pipelined) {
    for (let i = 0; i < FLOOR_STATEMENTS; i += GROUP) {
      await Promise.all(
        Array.from({ length: GROUP }, () => conn.run('select 1')),
      );
    }
  } else {
    for (let i = 0; i < FLOOR_STATEMENTS; i += 1) {
      await conn.run('select 1');
    }
  }
  return ms(t0);
}

// The five-statement hot shape. Pipelined mode sends all five before reading any response; the
// single connection serializes them server-side, so begin/commit still bracket the group.
async function hotShape(
  conn: OneShot,
  statements: (key: string) => Array<[string, unknown[]?]>,
  pipelined: boolean,
): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < TXNS; i += 1) {
    const group = statements(`k${i % 32}`);
    if (pipelined) {
      await Promise.all(group.map(([sql, params]) => conn.run(sql, params)));
    } else {
      for (const [sql, params] of group) {
        await conn.run(sql, params);
      }
    }
  }
  return ms(t0);
}

interface EngineSpec {
  name: string;
  trial: { label: string; conn: OneShot } | null;
  reference: { label: string; conn: OneShot };
  setup: (conn: OneShot) => Promise<void>;
  statements: (key: string) => Array<[string, unknown[]?]>;
}

async function engineSection(spec: EngineSpec): Promise<void> {
  const { name, trial, reference, setup, statements } = spec;
  process.stdout.write(`  ${name}\n`);
  if (trial === null) {
    process.stdout.write(`    trial driver not installed — reference only\n`);
  } else {
    await setup(trial.conn);
    report(
      `${trial.label} floor serial`,
      await floor(trial.conn, false),
      FLOOR_STATEMENTS,
      'stmt',
    );
    report(
      `${trial.label} floor piped`,
      await floor(trial.conn, true),
      FLOOR_STATEMENTS,
      'stmt',
    );
    report(
      `${trial.label} hot serial`,
      await hotShape(trial.conn, statements, false),
      TXNS,
      'txn',
    );
    report(
      `${trial.label} hot piped`,
      await hotShape(trial.conn, statements, true),
      TXNS,
      'txn',
    );
    await trial.conn.close();
  }
  await setup(reference.conn);
  report(
    `${reference.label} floor`,
    await floor(reference.conn, false),
    FLOOR_STATEMENTS,
    'stmt',
  );
  report(
    `${reference.label} hot`,
    await hotShape(reference.conn, statements, false),
    TXNS,
    'txn',
  );
  await reference.conn.close();
}

// --- Postgres ---------------------------------------------------------------------

async function postgresTrialConn(): Promise<OneShot | null> {
  const specifier = 'postgres';
  let make: (
    url: string,
    opts: Record<string, unknown>,
  ) => {
    unsafe(text: string, params?: unknown[]): Promise<unknown>;
    end(opts?: { timeout?: number }): Promise<void>;
  };
  try {
    make = (
      (await import(/* @vite-ignore */ specifier)) as unknown as {
        default: typeof make;
      }
    ).default;
  } catch {
    return null;
  }
  const sql = make(urls.postgres, { max: 1, onnotice: () => {} });
  return {
    run: (text, params) => sql.unsafe(text, params),
    close: () => sql.end({ timeout: 5 }),
  };
}

async function postgresReferenceConn(): Promise<OneShot> {
  const pool = await openPgPool({ connectionString: urls.postgres, max: 1 });
  return {
    run: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}

const pgStatements = (key: string): Array<[string, unknown[]?]> => [
  ['begin'],
  [
    'insert into wt_probe (id, v) values ($1, 0) on conflict (id) do nothing',
    [key],
  ],
  ['select v from wt_probe where id = $1 for update', [key]],
  ['update wt_probe set v = v + 1 where id = $1', [key]],
  ['commit'],
];

const pgSetup = async (conn: OneShot): Promise<void> => {
  await conn.run(
    'create temporary table if not exists wt_probe (id text primary key, v bigint not null)',
  );
};

// --- MySQL ------------------------------------------------------------------------

async function mysqlTrialConn(): Promise<OneShot | null> {
  const specifier = 'mariadb';
  let mod: {
    default: {
      createConnection(config: Record<string, unknown>): Promise<{
        query(sql: string, params?: unknown[]): Promise<unknown>;
        end(): Promise<void>;
      }>;
    };
  };
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as unknown as typeof mod;
  } catch {
    return null;
  }
  const u = new URL(urls.mysql);
  const conn = await mod.default.createConnection({
    host: u.hostname,
    port: u.port === '' ? 3306 : Number(u.port),
    user: decodeURIComponent(u.username),
    ...(u.password === '' ? {} : { password: decodeURIComponent(u.password) }),
    database: u.pathname.slice(1),
    pipelining: true,
  });
  return {
    run: (sql, params) => conn.query(sql, params),
    close: () => conn.end(),
  };
}

async function mysqlReferenceConn(): Promise<OneShot> {
  const pool = await createMysqlPool(urls.mysql, { connectionLimit: 1 });
  return {
    run: (sql, params) => pool.query(sql, params ?? []),
    close: () => pool.end(),
  };
}

const mysqlStatements = (key: string): Array<[string, unknown[]?]> => [
  ['BEGIN'],
  ['INSERT IGNORE INTO wt_probe (id, v) VALUES (?, 0)', [key]],
  ['SELECT v FROM wt_probe WHERE id = ? FOR UPDATE', [key]],
  ['UPDATE wt_probe SET v = v + 1 WHERE id = ?', [key]],
  ['COMMIT'],
];

const mysqlSetup = async (conn: OneShot): Promise<void> => {
  await conn.run(
    'CREATE TEMPORARY TABLE IF NOT EXISTS wt_probe (id VARCHAR(64) PRIMARY KEY, v BIGINT NOT NULL)',
  );
};

// --- Run --------------------------------------------------------------------------

process.stdout.write(
  `bench-wire: ${FLOOR_STATEMENTS} floor statements, ${TXNS} hot-shape txns (temp table — wire cost, no durable write)\n` +
    `  rig honesty: in-VM RTT ~0.05ms; every reclaimed round trip is worth ~10x more on a production network\n`,
);
for (const backend of cfg.backends) {
  if (backend === 'postgres') {
    const trial = await postgresTrialConn();
    await engineSection({
      name: 'postgres',
      trial: trial === null ? null : { label: 'pgjs', conn: trial },
      reference: { label: 'pg', conn: await postgresReferenceConn() },
      setup: pgSetup,
      statements: pgStatements,
    }).catch((error) => {
      process.stdout.write(`    SKIP postgres: ${String(error)}\n`);
    });
  }
  if (backend === 'mysql') {
    const trial = await mysqlTrialConn();
    await engineSection({
      name: 'mysql',
      trial: trial === null ? null : { label: 'mariadb', conn: trial },
      reference: { label: 'mysql2', conn: await mysqlReferenceConn() },
      setup: mysqlSetup,
      statements: mysqlStatements,
    }).catch((error) => {
      process.stdout.write(`    SKIP mysql: ${String(error)}\n`);
    });
  }
}
