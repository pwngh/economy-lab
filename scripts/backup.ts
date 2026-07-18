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

// Dumps each engine's ledger data into backups/, data-only on purpose: DDL comes from the
// repo's canonical db/*.sql at restore time, so the restore drill also proves the dump still
// matches the current schema (schema_meta rides in the data). An engine the env names that
// fails to dump fails the run — a backup that silently skips is a hope, not a backup.
//
//   npm run backup          # dump every engine the env names (DATABASE_URL / PG_URL / MYSQL_TEST_URL)
//   make restore-drill      # prove the newest dumps restore (scripts/restore-drill.ts)

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCAL_POSTGRES_URL, storeUrls } from '#src/env.ts';
import {
  BACKUP_DIR,
  dumpStamp,
  mysqlClientArgs,
  runTool,
} from '#scripts/support/db-tools.ts';

const say = (line: string): void => console.warn(line);

const stamp = dumpStamp();
await mkdir(BACKUP_DIR, { recursive: true });
const urls = storeUrls(process.env);

// The table set a schema file defines, in definition order (which is also FK dependency order).
async function schemaTables(path: string): Promise<string[]> {
  const ddl = await readFile(path, 'utf8');
  return [...ddl.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?/gim)].map(
    (match) => match[1],
  );
}

// Named engines fail loudly; the compose-local postgres fallback is best-effort like db-clean.
async function dump(
  engine: string,
  named: boolean,
  file: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
    say(`${engine}: wrote ${file}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (named) {
      say(`${engine}: FAILED — ${reason}`);
      process.exitCode = 1;
    } else {
      say(
        `${engine}: skipped — ${reason} (nothing names this engine; see .env)`,
      );
    }
  }
}

// --schema=public scopes the dump to the ledger's own schema (a shared server may carry
// unrelated schemas), and --disable-triggers lets the load bypass the conservation triggers,
// which assume rows arrive through the posting procedure, not a bulk COPY. The prover re-checks
// every invariant the triggers enforce, so nothing is trusted to the bypass.
const pgFile = join(BACKUP_DIR, `pg-${stamp}.sql`);
await dump('postgres', urls.postgres !== null, pgFile, () =>
  runTool(
    'pg_dump',
    [
      '--data-only',
      '--no-owner',
      '--schema=public',
      '--disable-triggers',
      urls.postgres ?? LOCAL_POSTGRES_URL,
    ],
    { stdoutTo: pgFile },
  ),
);

if (urls.mysql === null) {
  say('mysql: skipped — nothing names this engine (see .env)');
} else {
  const { args, database, env } = mysqlClientArgs(urls.mysql);
  const mysqlFile = join(BACKUP_DIR, `mysql-${stamp}.sql`);
  // The explicit table list scopes the dump to the canonical schema — a shared database may
  // carry unrelated tables the drill's scratch cannot receive. --replace lets the dump
  // overwrite the platform rows db/mysql-schema.sql seeds at restore; --skip-triggers keeps
  // trigger DDL out of a data dump (db/mysql-schema.sql owns the DDL).
  const tables = await schemaTables('db/mysql-schema.sql');
  await dump('mysql', true, mysqlFile, () =>
    runTool(
      'mysqldump',
      [
        ...args,
        '--no-create-info',
        '--single-transaction',
        '--replace',
        '--skip-triggers',
        database,
        ...tables,
      ],
      { stdoutTo: mysqlFile, env },
    ),
  );
}
