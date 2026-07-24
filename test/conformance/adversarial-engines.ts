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
 * Provisioning for the adversarial conformance harness.
 *
 * The adversarial suite proves engine enforcement by writing a violating row around the app and
 * asserting the write is rejected. For the SQL engines, the violating write is raw SQL that
 * bypasses `post_entry`. For memory, it is the lowest-level store method. To write around the app
 * a test needs raw access to the very same tables the {@link Store} uses, which the adapters do
 * not expose. So each SQL engine here provisions its own isolated namespace: a Postgres schema or
 * a MySQL database. It applies db/*-schema.sql into that namespace, builds a {@link Store} pointed
 * at it, and hands back a `raw(sql, params)` function pointed at the same namespace. Clean state
 * is set up through the app via `store.transaction(postEntry(...))`. The violation is then
 * attempted through `raw`.
 *
 * Memory's lowest write door is `append` or `__seedBalance`. See the invariants.adversarial.test.ts
 * header for why memory stays unenforced.
 *
 * Reachability is probed, not assumed. A SQL engine that cannot be reached yields `null`, and the
 * caller skips those cases rather than failing them. This is the same contract as the existing
 * adapter suites.
 */

// `pg` ships no types and this project disables auto-loaded @types, so its default import is
// untyped. Re-typed as PgModule at the binding below (mirrors src/engines/postgres.ts).
// @ts-expect-error -- untyped default import; typed at the binding via PgModule.
import pgUntyped from 'pg';

import { memoryStore } from '#src/adapters/memory.ts';
import { postgresStore } from '#src/engines/postgres.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '#src/engines/mysql.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';
import {
  freshName,
  maybeSweep,
  safeDatabaseName,
  testMysqlUrl,
  testPostgresUrl,
  withDatabase,
} from '#test/support/adapters.ts';

import type { EnvMap } from '#src/env.ts';
import type { Store } from '#src/ports.ts';
import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { MysqlPool } from '#src/engines/mysql.ts';

// The `pg` driver ships no types; the file annotates the few members it uses.
interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
interface PgModule {
  Pool: new (config: {
    connectionString: string;
    options?: string;
  }) => PgPoolLike;
}
const pg = pgUntyped as PgModule;

/**
 * Holds one engine wired for adversarial testing. The `store` is a live {@link Store} whose clean
 * setup goes through the app. The `raw` field is an escape hatch onto the same tables, used to
 * write the violation around the app. The `close` field tears the namespace down. The provisioner
 * returns `null` instead of this interface when the engine is unreachable.
 */
export interface AdversarialEngine {
  name: string;
  store: Store;
  // Issues raw SQL against the very tables the store uses, bypassing post_entry entirely. Throws
  // when the engine rejects the write, which is exactly the rejection an adversarial case asserts.
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

// Holds the memory engine wired for adversarial testing. Memory exposes its lowest write door plus
// the documented test back doors. A memory case can therefore write around `postEntry` the only
// way memory allows: straight into `append`, `__seedBalance`, or `__tamper`, the Maps that are its
// database.
export interface AdversarialMemory {
  name: 'memory';
  store: Store;
  ledger: MemoryLedger;
  close(): Promise<void>;
}

// URLs, throwaway names, and the MySQL URL/name helpers come from the shared test-suite policy
// (test/support/adapters.ts); the provisioners take env explicitly, and each test file passes
// process.env once at its own edge.

/**
 * Builds the memory oracle for adversarial setup. Memory is always available. The returned `ledger`
 * is the concrete {@link MemoryLedger}, which exposes `append` and the `__`-prefixed back doors the
 * cases use to write around `postEntry`.
 */
export function adversarialMemory(): AdversarialMemory {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return {
    name: 'memory',
    store,
    ledger: store.ledger as MemoryLedger,
    close: async () => store.close(),
  };
}

// Says WHY provisioning failed, once per engine: "server unreachable" and "reachable but the
// restricted-role setup was refused" both land in the same null, and the second is a coverage
// loss a silent skip would disguise as the first.
const announcedSkips = new Set<string>();
function announceSkip(engine: string, error: unknown): null {
  if (!announcedSkips.has(engine)) {
    announcedSkips.add(engine);
    console.warn(
      `adversarial ${engine}: SKIP — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
}

/**
 * Provisions Postgres for adversarial testing, or returns `null` if unreachable. Creates a
 * throwaway schema and points both the store's pool and our raw pool at it via search_path, so a
 * raw INSERT lands in the very table `post_entry` writes. Mirrors postgresStore's own isolation.
 */
export async function adversarialPostgres(
  env: EnvMap,
): Promise<AdversarialEngine | null> {
  const url = testPostgresUrl(env);
  await maybeSweep('postgres', url);
  const schema = freshName('el_adv_pg');
  let store: Store;
  try {
    store = await postgresStore({
      url,
      schemaName: schema,
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
  } catch (error) {
    return announceSkip('postgres', error);
  }
  // A second pool, aimed at the same schema, carries the raw writes around the app.
  const rawPool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  return {
    name: 'postgres',
    store,
    raw: async (sql, params) => {
      const result = await rawPool.query(sql, params);
      return result.rows;
    },
    close: async () => {
      await rawPool.end().catch(() => {});
      await store.close();
    },
  };
}

// Overrides the user, password, and database on a MySQL URL, preserving host and port.
function withUserAndDatabase(
  url: string,
  user: string,
  password: string,
  database: string,
): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// The restricted role that conservation relies on (see adversarialMysql). It may write every ledger
// table directly except `legs`. Only post_entry may write `legs`, a SECURITY DEFINER routine owned
// by the admin, so a raw unbalanced-leg insert is refused. The other tables keep direct DML so the
// chain continuity, balance integrity, overdraft, and exactly-once raw cases still reach their own
// engine mechanisms rather than a blanket privilege denial.
const APP_USER = 'el_adv_app';
const APP_PASSWORD = 'el_adv_app';
const APP_DML_TABLES = [
  'accounts',
  'postings',
  'chain_links',
  'account_balances',
  'idempotency',
  'seen_webhooks',
  'outbox',
  'inbox',
  'sales',
  'payout_sagas',
  'promo_grants',
  'entitlements',
  'subscriptions',
  'trust_attempts',
  'checkpoints',
];

/**
 * Provisions MySQL for adversarial testing, or returns `null` if unreachable (for example, when
 * MYSQL_TEST_URL is unset).
 *
 * Each call gets a throwaway database, the MySQL analogue of Postgres's throwaway schema. This
 * serves two purposes. First, it isolates this run from test/adapters/mysql.test.ts, which shares
 * the same server. Second, because conservation is enforced by a restricted role that lacks `legs`
 * DML, it gives that role a database of its own to be GRANTed on. The admin connection applies the
 * schema, so post_entry's DEFINER is privileged and stays the sole writer of `legs`. The store and
 * raw pools then connect as the restricted role, and the database is dropped on close. Both pools
 * point at it, so a raw INSERT lands in the very table post_entry writes, except `legs`, which the
 * restricted role cannot write directly.
 */
export async function adversarialMysql(
  env: EnvMap,
): Promise<AdversarialEngine | null> {
  const url = testMysqlUrl(env);
  if (url === null) {
    return null;
  }
  await maybeSweep('mysql', url);
  const database = safeDatabaseName(freshName('el_adv_my'));
  // Every pool opened so far, so the catch below can end them all: a "skip this engine" null
  // return must not leak an open connection, or it pins the test process's event loop and the
  // run never exits.
  const opened: MysqlPool[] = [];
  let admin: MysqlPool;
  let schemaPool: MysqlPool;
  let storePool: MysqlPool;
  let rawPool: MysqlPool;
  let store: Store;
  try {
    // Create the throwaway database, then apply the schema as the admin connection so post_entry's
    // DEFINER is the privileged admin: it stays the only writer of `legs` even when invoked by the
    // restricted role below.
    admin = await createMysqlPool(url);
    opened.push(admin);
    await admin.query(`CREATE DATABASE \`${database}\``);
    schemaPool = await createMysqlPool(withDatabase(url, database));
    opened.push(schemaPool);
    await applyMysqlSchema(schemaPool);
    await schemaPool.end().catch(() => {});

    // The privilege model that enforces conservation on MySQL. The restricted role may write every
    // ledger table directly except `legs`, and it holds EXECUTE on post_entry. Legitimate legs reach
    // the table only through the procedure, which is SECURITY DEFINER, so a raw leg insert is refused.
    // The other tables keep direct DML so the chain continuity, balance integrity, overdraft, and
    // exactly-once raw cases still hit their own triggers, constraints, and keys.
    await admin.query(
      `CREATE USER IF NOT EXISTS '${APP_USER}'@'%' IDENTIFIED BY '${APP_PASSWORD}'`,
    );
    await admin.query(
      `GRANT SELECT, EXECUTE ON \`${database}\`.* TO '${APP_USER}'@'%'`,
    );
    for (const table of APP_DML_TABLES) {
      await admin.query(
        `GRANT INSERT, UPDATE, DELETE ON \`${database}\`.\`${table}\` TO '${APP_USER}'@'%'`,
      );
    }

    const appUrl = withUserAndDatabase(url, APP_USER, APP_PASSWORD, database);
    storePool = await createMysqlPool(appUrl);
    opened.push(storePool);
    store = mysqlStore({
      pool: storePool,
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    rawPool = await createMysqlPool(appUrl);
    opened.push(rawPool);
  } catch (error) {
    for (const pool of opened.reverse()) {
      await pool.end().catch(() => {});
    }
    return announceSkip('mysql', error);
  }
  return {
    name: 'mysql',
    store,
    raw: async (sql, params) => {
      // mysql2 returns [rows, fields]. Surface the rows as an array for symmetry with pg.
      const [result] = await rawPool.query(sql, params);
      return Array.isArray(result) ? (result as unknown[]) : [];
    },
    close: async () => {
      await rawPool.end().catch(() => {});
      await store.close();
      await admin
        .query(`DROP DATABASE IF EXISTS \`${database}\``)
        .catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}

/**
 * Provisions the SQL engines wired for adversarial testing. Each provisioner returns `null` when
 * its engine is unreachable. Callers skip those rather than fail, so the suite is green with zero,
 * one, or both engines live.
 */
export async function adversarialSqlEngines(
  env: EnvMap,
): Promise<Array<AdversarialEngine | null>> {
  return Promise.all([adversarialPostgres(env), adversarialMysql(env)]);
}
