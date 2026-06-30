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
let pg = pgUntyped as PgModule;

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

// Returns where to reach the test Postgres. Uses the same precedence as test/support/adapters.ts
// and test/adapters/postgres.test.ts.
function postgresUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgres://economy:economy@localhost:5432/economy_lab'
  );
}

// Builds a namespace name no concurrent run reuses, combining the pid, a base-36 timestamp, and a
// counter. This matches the isolation scheme the existing suites use for throwaway schemas and
// databases.
let run = 0;
function freshName(prefix: string): string {
  run += 1;
  let stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

/**
 * Builds the memory oracle for adversarial setup. Memory is always available. The returned `ledger`
 * is the concrete {@link MemoryLedger}, which exposes `append` and the `__`-prefixed back doors the
 * cases use to write around `postEntry`.
 */
export function adversarialMemory(): AdversarialMemory {
  let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return {
    name: 'memory',
    store,
    ledger: store.ledger as MemoryLedger,
    close: async () => store.close(),
  };
}

/**
 * Provisions Postgres for adversarial testing, or returns `null` if unreachable. Creates a
 * throwaway schema and points both the store's pool and our raw pool at it via search_path, so a
 * raw INSERT lands in the very table `post_entry` writes. Mirrors postgresStore's own isolation.
 */
export async function adversarialPostgres(): Promise<AdversarialEngine | null> {
  let url = postgresUrl();
  let schema = freshName('el_adv_pg');
  let store: Store;
  try {
    store = await postgresStore({
      url,
      schema,
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
  } catch {
    return null;
  }
  // A second pool, aimed at the same schema, carries the raw writes around the app.
  let rawPool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  return {
    name: 'postgres',
    store,
    raw: async (sql, params) => {
      let result = await rawPool.query(sql, params);
      return result.rows;
    },
    close: async () => {
      await rawPool.end().catch(() => {});
      await store.close();
    },
  };
}

// Returns the name unchanged if it is safe to paste into SQL, else throws. A MySQL database name
// cannot be a placeholder in CREATE DATABASE or DROP DATABASE, so it is pasted into the statement.
// This guards against injection the same way Postgres guards a schema name: letters, digits, and
// underscores only.
function safeDatabaseName(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe MySQL database name: ${name}.`);
  }
  return name;
}

// Points a MySQL URL at a different database, preserving host and credentials.
function withDatabase(url: string, database: string): string {
  let parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// Overrides the user, password, and database on a MySQL URL, preserving host and port.
function withUserAndDatabase(
  url: string,
  user: string,
  password: string,
  database: string,
): string {
  let parsed = new URL(url);
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
let APP_USER = 'el_adv_app';
let APP_PASSWORD = 'el_adv_app';
let APP_DML_TABLES = [
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
 * restricted role may not write directly.
 */
export async function adversarialMysql(): Promise<AdversarialEngine | null> {
  let url = process.env.MYSQL_TEST_URL;
  if (!url) {
    return null;
  }
  let database = safeDatabaseName(freshName('el_adv_my'));
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
    await admin.query(`CREATE DATABASE \`${database}\``);
    schemaPool = await createMysqlPool(withDatabase(url, database));
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
    for (let table of APP_DML_TABLES) {
      await admin.query(
        `GRANT INSERT, UPDATE, DELETE ON \`${database}\`.\`${table}\` TO '${APP_USER}'@'%'`,
      );
    }

    let appUrl = withUserAndDatabase(url, APP_USER, APP_PASSWORD, database);
    storePool = await createMysqlPool(appUrl);
    store = mysqlStore({
      pool: storePool,
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    rawPool = await createMysqlPool(appUrl);
  } catch {
    return null;
  }
  return {
    name: 'mysql',
    store,
    raw: async (sql, params) => {
      // mysql2 returns [rows, fields]. Surface the rows as an array for symmetry with pg.
      let [result] = await rawPool.query(sql, params);
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
export async function adversarialSqlEngines(): Promise<
  Array<AdversarialEngine | null>
> {
  return Promise.all([adversarialPostgres(), adversarialMysql()]);
}
