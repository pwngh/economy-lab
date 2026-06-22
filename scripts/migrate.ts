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

// Create the database tables the app needs, picking what to do from the DATABASE_URL connection
// string. CI runs this (via `npm run db:migrate`) before the Postgres test suite, and it doubles
// as a one-command local setup.
//
// If the URL points at Postgres: drop and recreate the whole `public` schema, then run
// db/postgresql-schema.sql against it. That file declares every table plainly (no "create if it does not
// already exist"), so re-running it would fail on an existing database — hence the drop-and-
// recreate first, which makes this safe to run repeatedly.
//
// If the URL points at MySQL: apply db/mysql-schema.sql (the MySQL counterpart to db/postgresql-schema.sql)
// via the adapter's `applyMysqlSchema`. That file drops its tables up front, so it is safe to
// re-run as-is and no separate drop is needed.
//
// If DATABASE_URL is unset: do nothing, because the in-memory store builds its tables in code and
// has no schema to apply.
//
// This is meant to be run by hand as a deliberate setup or deploy step; the running server never
// creates tables on startup.
//
//   DATABASE_URL=postgres://user@localhost:5432/economy_lab npm run db:migrate
//   DATABASE_URL=mysql://root:pw@localhost:3306/economy_lab  npm run db:migrate

import { readFile } from 'node:fs/promises';

// The few methods of the untyped `pg` driver this script uses (it ships no TypeScript types).
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
interface PgModule {
  Client: new (config: { connectionString: string }) => PgClient;
}

const url = process.env.DATABASE_URL ?? '';

if (url.startsWith('postgres')) {
  // pg ships no type declarations, so the dynamic import is untyped; we give it a type by
  // annotating the variable it lands in (PgModule) instead.
  // @ts-expect-error -- untyped dynamic import.
  const pg: PgModule = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('drop schema public cascade; create schema public;');
  const sql = await readFile(
    new URL('../db/postgresql-schema.sql', import.meta.url),
    'utf8',
  );
  await client.query(sql);
  await client.end();
  console.warn(
    'migrated postgres — public schema reset and db/postgresql-schema.sql applied',
  );
} else if (url.startsWith('mysql')) {
  const { createMysqlPool, applyMysqlSchema } =
    await import('#src/adapters/mysql.ts');
  const pool = await createMysqlPool(url);
  await applyMysqlSchema(pool);
  await (pool as { end?: () => Promise<void> }).end?.();
  console.warn('migrated mysql — db/mysql-schema.sql applied');
} else {
  console.warn(
    'no DATABASE_URL set — the in-memory store needs no schema; nothing to migrate.',
  );
}

// pg/mysql connection handles keep the event loop alive; this is a one-shot script.
// eslint-disable-next-line n/no-process-exit
process.exit(0);
