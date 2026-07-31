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

// Restores the newest dump into a scratch namespace, runs the full prover against the restored
// ledger, and drops the scratch. A backup that isn't provably restorable is a hope, not a
// backup. The drill turns the hope into a report.
//
//   npm run backup && npm run restore:drill
//
// Each engine restores into a scratch el_drill_* DATABASE. db/*.sql provides the DDL, then the
// data-only dump applies verbatim (postgres dumps and scratches both live in `public`).
// Scratches drop in a `finally`. A killed run leaves an el_drill_* name that `make db-clean`
// sweeps.

import { createEconomy } from '#src/economy.ts';
import { allInvariantsHold, openPorts, proveEconomy } from '#src/index.ts';
import { LOCAL_POSTGRES_URL, storeUrls } from '#src/env.ts';
import {
  freshName,
  safeDatabaseName,
  withDatabase,
} from '#test/support/adapters.ts';
import {
  mysqlClientArgs,
  newestDump,
  runTool,
} from '#scripts/support/db-tools.ts';

const say = (line: string): void => console.warn(line);

// The full audit re-derives every invariant from the restored rows alone and replays every hash
// chain, so a dump missing rows or restored out of shape cannot pass it. `read.health()` would not
// do: its chain check is a shape test on each head and re-hashes nothing.
async function proveRestored(scratchUrl: string): Promise<boolean> {
  const caps = await openPorts(
    { DATABASE_URL: scratchUrl },
    { processor: { submitPayout: async () => ({ providerRef: 'drill' }) } },
  );
  const economy = createEconomy(caps);
  try {
    const report = await proveEconomy(caps);
    say(
      `  ${report.prover}: conserved=${report.conserved} backed=${report.backed} ` +
        `noOverdraft=${report.noOverdraft} chainIntact=${report.chainIntact} ` +
        `consistent=${report.consistent} drift=${report.drift.length}`,
    );
    return allInvariantsHold(report);
  } finally {
    await economy.close();
  }
}

async function drillPostgres(): Promise<boolean | null> {
  const dump = await newestDump('pg');
  if (dump === null) {
    say('postgres: no pg-*.sql dump in backups/ — run `npm run backup` first');
    return null;
  }
  const url = storeUrls(process.env).postgres ?? LOCAL_POSTGRES_URL;
  const scratch = safeDatabaseName(freshName('el_drill'));
  const scratchUrl = withDatabase(url, scratch);
  say(`postgres: restoring ${dump} into scratch database ${scratch}`);
  await runTool('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-c',
    `create database "${scratch}"`,
  ]);
  try {
    await runTool('psql', [
      scratchUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-f',
      'packages/postgres/db/postgresql-schema.sql',
    ]);
    // The schema seeds the platform rows the dump also carries. Clear them so the dump's COPY
    // (which has no on-conflict path) restores the backed-up values, not the seeds.
    await runTool('psql', [
      scratchUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-c',
      'truncate table account_balances, accounts, schema_meta cascade',
    ]);
    await runTool('psql', [
      scratchUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-f',
      dump,
    ]);
    return await proveRestored(scratchUrl);
  } finally {
    await runTool('psql', [
      url,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-c',
      `drop database if exists "${scratch}" with (force)`,
    ]);
  }
}

async function drillMysql(): Promise<boolean | null> {
  const url = storeUrls(process.env).mysql;
  if (url === null) {
    say('mysql: skipped — nothing names this engine (see .env)');
    return null;
  }
  const dump = await newestDump('mysql');
  if (dump === null) {
    say('mysql: no mysql-*.sql dump in backups/ — run `npm run backup` first');
    return null;
  }
  const scratch = safeDatabaseName(freshName('el_drill'));
  const { args, env } = mysqlClientArgs(url);
  say(`mysql: restoring ${dump} into scratch database ${scratch}`);
  await runTool('mysql', [...args, '-e', `CREATE DATABASE \`${scratch}\``], {
    env,
  });
  try {
    await runTool('mysql', [...args, scratch], {
      stdinFrom: 'packages/mysql/db/mysql-schema.sql',
      env,
    });
    await runTool('mysql', [...args, scratch], { stdinFrom: dump, env });
    return await proveRestored(withDatabase(url, scratch));
  } finally {
    await runTool(
      'mysql',
      [...args, '-e', `DROP DATABASE IF EXISTS \`${scratch}\``],
      {
        env,
      },
    );
  }
}

function report(engine: string, passed: boolean | null): void {
  if (passed === null) {
    return;
  }
  say(`${engine}: ${passed ? 'PASS — the dump restores and proves' : 'FAIL'}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

const pg = await drillPostgres().catch((error) => {
  say(
    `postgres: FAILED — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
  return null;
});
const mysql = await drillMysql().catch((error) => {
  say(
    `mysql: FAILED — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
  return null;
});
report('postgres', pg);
report('mysql', mysql);
if (pg === null && mysql === null && process.exitCode === undefined) {
  say('nothing drilled — no dumps found and no engine named');
  process.exitCode = 1;
}
