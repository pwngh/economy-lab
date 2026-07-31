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
 * The registrar for a suite that needs a live SQL engine. A suite built through it registers its
 * tests whether or not a rig is there, and reports the rig's absence as a named skip on each one —
 * the same connect-or-skip contract `runStoreConformance` offers a store.
 *
 * @example
 * describeEngine('mysql', 'installMysql, against a live MySQL', (rig) => {
 *   rig.test('a second install issues no drop', async (url) => {
 *     // url is the configured rig, and this body runs only when it answered a probe
 *   });
 * });
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMysqlPool } from '@pwngh/economy-mysql';
import { openPgPool } from '@pwngh/economy-postgres/driver';
import { testMysqlUrl, testPostgresUrl } from '#test/support/adapters.ts';

import type { TestContext } from 'node:test';

export type SqlEngine = 'postgres' | 'mysql';

/** The environment names each engine reads, so a skip says which variable to set. */
const RIG_KEYS: Record<SqlEngine, string> = {
  postgres: 'DATABASE_URL / PG_URL',
  mysql: 'MYSQL_TEST_URL / DATABASE_URL',
};

// The probe's own connect wait, well under the engines' 10s default. A host that black-holes the
// SYN costs this once per suite per file, and a run with no rig at all is what that bound is for;
// CI health-gates its services before any step runs, so nothing legitimate waits this long.
const PROBE_CONNECT_TIMEOUT_MS = 2_000;

/**
 * The refusal a store factory raises when nothing named the engine's rig. `runStoreConformance`
 * repeats a factory's message in every skip it issues, so this is what makes those skips name the
 * variable to set rather than the driver's own "Invalid URL".
 */
export function rigUnconfigured(engine: SqlEngine): Error {
  return new Error(`no ${engine} URL configured (${RIG_KEYS[engine]})`);
}

/** One test the registrar placed, and whether the rig it needs was named. */
export interface EngineGateEntry {
  readonly engine: SqlEngine;
  readonly suite: string;
  readonly name: string;
  readonly configured: boolean;
}

const roster: EngineGateEntry[] = [];

/**
 * Every engine-gated test this process registered, in registration order. The list is the same
 * length with a rig and without one, which is the property {@link pinEngineGateRoster} holds.
 */
export function engineGateRoster(): readonly EngineGateEntry[] {
  return roster;
}

/** The registrar handed to a {@link describeEngine} body. */
export interface EngineRig {
  readonly engine: SqlEngine;
  test(
    name: string,
    fn: (url: string, t: TestContext) => Promise<void> | void,
  ): void;
}

/** The one URL policy these suites read: `test/support/adapters.ts`, per engine. */
function rigUrl(engine: SqlEngine): string | null {
  return engine === 'postgres'
    ? testPostgresUrl(process.env)
    : testMysqlUrl(process.env);
}

/** Null when the engine answered; otherwise the reason, worded for a skip. */
async function probe(engine: SqlEngine, url: string): Promise<string | null> {
  try {
    if (engine === 'postgres') {
      const pool = await openPgPool(
        {
          connectionString: url,
          max: 1,
          connectionTimeoutMillis: PROBE_CONNECT_TIMEOUT_MS,
        },
        () => undefined,
      );
      try {
        await pool.query('select 1');
      } finally {
        await pool.end();
      }
    } else {
      const pool = await createMysqlPool(url, {
        connectionLimit: 1,
        connectTimeout: PROBE_CONNECT_TIMEOUT_MS,
      });
      try {
        await pool.query('SELECT 1');
      } finally {
        await pool.end();
      }
    }
    return null;
  } catch (error) {
    // The message names the reason: a silent skip disguises a provisioning failure as "no rig".
    return `${engine} rig unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Registers a suite whose tests need `engine` live. Nothing here is conditional: with no rig named
 * every test registers carrying a skip that names the variable to set, and with one named but
 * unreachable every test skips carrying the connect error. A suite that vanishes instead leaves a
 * shorter suite list and no line of output saying a suite was meant to happen.
 */
export function describeEngine(
  engine: SqlEngine,
  title: string,
  body: (rig: EngineRig) => void,
): void {
  const url = rigUrl(engine) ?? '';
  const configured = url !== '';
  describe(title, () => {
    // One probe per suite, and only when there is something to probe. The result decides every
    // test below, so it is read in `before` rather than at registration.
    let unreachable: string | null = null;
    if (configured) {
      before(async () => {
        unreachable = await probe(engine, url);
      });
    }
    body({
      engine,
      test(name, fn) {
        roster.push({ engine, suite: title, name, configured });
        if (!configured) {
          const reason = `${engine} rig not configured (${RIG_KEYS[engine]})`;
          test(name, { skip: reason }, () => undefined);
          return;
        }
        test(name, async (t) => {
          if (unreachable !== null) {
            t.skip(unreachable);
            return;
          }
          await fn(url, t);
        });
      },
    });
  });
}

/**
 * Pins the file's own registrations. Read as `suite › name`, so a suite that stopped registering
 * fails here by name instead of shrinking the file's total.
 */
export function pinEngineGateRoster(expected: readonly string[]): void {
  test(`this file registers ${expected.length} engine-gated tests, rig or no rig`, () => {
    assert.deepEqual(
      engineGateRoster().map((entry) => `${entry.suite} › ${entry.name}`),
      [...expected],
    );
  });
}
