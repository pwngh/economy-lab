/// <reference types="node" />
/**
 * @pwngh/economy-mysql
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runStoreConformance } from '@pwngh/economy-lab/testing';
import { spendable } from '@pwngh/economy-lab';

import {
  applyMysqlSchema,
  createMysqlPool,
  mysql,
  mysqlStore,
} from '../src/index.js';

const url = process.env.MYSQL_TEST_URL ?? '';
const live = url.startsWith('mysql://');

// The schema file ships in the tarball beside dist/, and the engine resolves it one level up
// from there. A wrong relative path only surfaces at runtime on the apply path, which skips
// whenever the backend is unreachable — so it is asserted here instead.
describe('the package ships the schema its engine reads', () => {
  test('db/mysql-schema.sql is where the engine looks for it', () => {
    const fromDist = fileURLToPath(
      new URL('../dist/../db/mysql-schema.sql', import.meta.url),
    );
    assert.ok(existsSync(fromDist), `no schema file at ${fromDist}`);
  });
});

// One import, one call. No pool, no schema assert, no money proof at the call site.
describe('mysql(url): the one-call open', () => {
  test('returns a store whose schema and money routines were proven inside', async (t) => {
    if (!live) {
      t.skip('MYSQL_TEST_URL unset');
      return;
    }
    const store = await mysql(url);
    try {
      const balance = await store.ledger.balance(spendable('usr_pkg_open'));
      assert.equal(balance.minor, 0n);
    } finally {
      await store.close();
    }
  });

  test('the pool-injection form leaves the caller-owned wire open', async (t) => {
    if (!live) {
      t.skip('MYSQL_TEST_URL unset');
      return;
    }
    const pool = await createMysqlPool(url);
    const store = await mysql({ pool });
    try {
      const balance = await store.ledger.balance(spendable('usr_pkg_pool'));
      assert.equal(balance.minor, 0n);
    } finally {
      await store.close();
    }
    // Ownership follows creation: this test built the pool, so close() left it open and this
    // test ends it. A pool the store had ended would refuse the query below.
    const [rows] = await pool.query('SELECT 1 AS one');
    assert.equal((rows as unknown[]).length, 1);
    await pool.end();
  });

  test('refuses a reachable database that carries no schema stamp', async (t) => {
    if (!live) {
      t.skip('MYSQL_TEST_URL unset');
      return;
    }
    const probe = `economy_pkg_${crypto.randomUUID().slice(0, 8)}`;
    const admin = await createMysqlPool(url);
    try {
      await admin.query(`CREATE DATABASE \`${probe}\``);
      const probeUrl = url.replace(/\/[^/?]+(\?|$)/, `/${probe}$1`);
      await assert.rejects(mysql(probeUrl), /schema version/);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${probe}\``);
      await admin.end();
    }
  });
});

// The whole port contract against a live MySQL. Registered whatever the environment holds: with no
// URL the schema apply refuses in tens of milliseconds and runStoreConformance's probe turns that
// into a skip on every test it owns, so an unconfigured run reports this suite rather than losing it.
runStoreConformance('economy-mysql', async () => {
  const pool = await createMysqlPool(url);
  try {
    await applyMysqlSchema(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  // The pool was built here, so it is ended here. mysqlStore leaves a pool it was handed
  // alone, and a pool nobody ends keeps this test process alive after its last test.
  const store = mysqlStore({ pool });
  return {
    ...store,
    close: async () => {
      await store.close();
      await pool.end();
    },
  };
});
