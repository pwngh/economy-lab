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

// Drops the stale throwaway namespaces the lab's scripts leave behind when a run dies without
// closing — el_* schemas/databases from the bench, fuzz, and the test suites, plus the pid-named
// integration databases. "Stale" is the orphan rule in test/support/adapters.ts: the creating pid
// is gone and the name's timestamp is comfortably old. Live runs are never touched.
//
//   npm run db:clean            # drop orphans on every reachable engine
//   npm run db:clean -- --all   # drop EVERY throwaway namespace, live runs included
//
// The engines come from the shared env surface (src/env.ts): the same URLs the bench and the
// tests resolve. An unreachable or unnamed engine is reported and skipped, never an error — the
// point of this script is to leave the servers explainable, not to require them.

import {
  sweepStaleMysql,
  sweepStalePostgres,
  testMysqlUrl,
  testPostgresUrl,
} from '#test/support/adapters.ts';

const all = process.argv.includes('--all');

type Sweep = (url: string, all?: boolean) => Promise<string[]>;

async function clean(
  engine: string,
  url: string | null,
  sweep: Sweep,
): Promise<void> {
  if (url === null) {
    console.warn(`${engine}: skipped — nothing names this engine (see .env)`);
    return;
  }
  try {
    const dropped = await sweep(url, all);
    if (dropped.length === 0) {
      console.warn(`${engine}: clean — no stale throwaway namespaces`);
      return;
    }
    console.warn(`${engine}: dropped ${dropped.length}`);
    for (const name of dropped) {
      console.warn(`  - ${name}`);
    }
  } catch (error) {
    console.warn(
      `${engine}: unreachable — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await clean('postgres', testPostgresUrl(process.env), sweepStalePostgres);
await clean('mysql', testMysqlUrl(process.env), sweepStaleMysql);
