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
 * Provisioning for the adversarial conformance harness (Phase 1 of docs/the-right-way.md).
 *
 * The adversarial suite proves engine enforcement by writing a VIOLATING row AROUND the app —
 * raw SQL that bypasses `post_entry` for the SQL engines, and the lowest-level store method for
 * memory — and asserting the write is rejected. To write around the app a test needs RAW access
 * to the very same tables the {@link Store} uses, which the adapters do not expose. So each SQL
 * engine here provisions its own isolated namespace (a Postgres schema / a MySQL database),
 * applies db/*-schema.sql into it, builds a {@link Store} pointed at that namespace, AND hands
 * back a `raw(sql, params)` function pointed at the SAME namespace. Clean state is set up through
 * the app (`store.transaction(postEntry(...))`); the violation is then attempted through `raw`.
 *
 * Memory has no layer beneath it (the Maps ARE the database), so "around the app" means calling
 * `store.ledger.append()` directly — the lowest write door, which performs none of the
 * `postEntry` validation — and the `__seedBalance` / `__tamper` back doors. Per the plan, memory
 * is the test oracle and never receives engine enforcement, so its I1/I2/I3/I5 adversarial cases
 * are expected to stay ENFORCEMENT-PENDING.
 *
 * Reachability is probed, not assumed: a SQL engine that cannot be reached yields `null`, and the
 * caller skips (never fails) those cases — the same contract as the existing adapter suites.
 */

// `pg` ships no types and this project disables auto-loaded @types, so its default import is
// untyped. Re-typed as PgModule at the binding below (mirrors src/adapters/postgres.ts).
// @ts-expect-error -- untyped default import; typed at the binding via PgModule.
import pgUntyped from 'pg';

import { memoryStore } from '#src/adapters/memory.ts';
import { postgresStore } from '#src/adapters/postgres.ts';
import {
  applyMysqlSchema,
  createMysqlPool,
  mysqlStore,
} from '#src/adapters/mysql.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Store } from '#src/ports.ts';
import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { MysqlPool } from '#src/adapters/mysql.ts';

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
 * One engine wired for adversarial testing: a live {@link Store} (clean setup through the app),
 * a `raw` escape hatch onto the SAME tables (the violation written around the app), and a
 * `close` that tears the namespace down. `null` when the engine is unreachable.
 */
export interface AdversarialEngine {
  name: string;
  store: Store;
  // Issue raw SQL against the very tables the store uses, bypassing post_entry entirely. Throws
  // when the engine rejects the write — which is exactly the rejection an adversarial case asserts.
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

// Memory exposes its lowest write door plus the documented test back doors, so a memory case can
// write around `postEntry` the only way memory allows: straight into `append`/`__seedBalance`/
// `__tamper` (the Maps that ARE its database).
export interface AdversarialMemory {
  name: 'memory';
  store: Store;
  ledger: MemoryLedger;
  close(): Promise<void>;
}

// Where to reach the test Postgres — same precedence as test/support/adapters.ts and
// test/adapters/postgres.test.ts.
function postgresUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgresql://localhost:5432/economy_lab'
  );
}

// A namespace name no concurrent run reuses (pid + base-36 timestamp + counter), matching the
// isolation scheme the existing suites use for throwaway schemas/databases.
let run = 0;
function freshName(prefix: string): string {
  run += 1;
  let stamp = Date.now().toString(36);
  return `${prefix}_${process.pid}_${stamp}_${run}`;
}

/**
 * Build the memory oracle for adversarial setup. Always available. The returned `ledger` is the
 * concrete {@link MemoryLedger} (with `append` and the `__`-prefixed back doors) the cases use to
 * write around `postEntry`.
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
 * Provision Postgres for adversarial testing, or `null` if unreachable. Creates a throwaway
 * schema, points BOTH the store's pool and our raw pool at it via search_path, so a raw INSERT
 * lands in the very table `post_entry` writes. Mirrors postgresStore's own isolation.
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
  // A second pool, aimed at the same schema, for the raw writes around the app.
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

// A MySQL database name can't be a placeholder in CREATE/DROP DATABASE, so it's pasted into the
// SQL. Guard against injection the same way Postgres guards a schema name: letters, digits,
// underscores only.
function safeDatabaseName(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe MySQL database name: ${name}.`);
  }
  return name;
}

// Point a MySQL URL at a different database, preserving host/credentials.
function withDatabase(url: string, database: string): string {
  let parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

// Override user, password, and database on a MySQL URL, preserving host/port.
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

// The restricted role I1 conservation relies on (see adversarialMysql). It may write every ledger
// table directly EXCEPT `legs` — which only post_entry (a SECURITY DEFINER routine owned by the
// admin) may write — so a raw unbalanced-leg insert is refused, while the I3/I5/I2/I4 raw cases
// still reach their own engine mechanisms rather than a blanket privilege denial.
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
  'sales',
  'payout_sagas',
  'promo_grants',
  'entitlements',
  'subscriptions',
  'trust_attempts',
  'checkpoints',
];

/**
 * Provision MySQL for adversarial testing, or `null` if unreachable (e.g. MYSQL_TEST_URL unset).
 *
 * MySQL's schema file has no `DROP PROCEDURE IF EXISTS`, so re-applying it to the same database
 * (the shared `economy_lab`) fails with "PROCEDURE post_entry already exists" and would collide
 * with test/adapters/mysql.test.ts running in the same process. So this provisions a throwaway
 * DATABASE per call — the MySQL analogue of Postgres's throwaway schema — applies the schema
 * there, and drops it on close. Both the store's pool and our raw pool point at that database, so
 * a raw INSERT lands in the very table `post_entry` writes.
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
    // Create the throwaway database, then apply the schema as the ADMIN connection so post_entry's
    // DEFINER is the privileged admin: it stays the only writer of `legs` even when invoked by the
    // restricted role below.
    admin = await createMysqlPool(url);
    await admin.query(`CREATE DATABASE \`${database}\``);
    schemaPool = await createMysqlPool(withDatabase(url, database));
    await applyMysqlSchema(schemaPool);
    await schemaPool.end().catch(() => {});

    // The privilege model that enforces I1 on MySQL: a restricted role that may write every ledger
    // table directly EXCEPT `legs`, plus EXECUTE on post_entry. Legitimate legs reach the table only
    // through the procedure (SECURITY DEFINER); a raw leg insert is refused. The other tables keep
    // direct DML so the I3/I5/I2/I4 raw cases still hit their own triggers/constraints/keys.
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
      // mysql2 returns [rows, fields]; surface the rows as an array for symmetry with pg.
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
 * The SQL engines wired for adversarial testing. Each provisioner returns `null` when its engine
 * is unreachable; callers skip those rather than fail, so the suite is green with zero, one, or
 * both engines live.
 */
export async function adversarialSqlEngines(): Promise<
  Array<AdversarialEngine | null>
> {
  return Promise.all([adversarialPostgres(), adversarialMysql()]);
}
