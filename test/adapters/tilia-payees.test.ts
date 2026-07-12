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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { tiliaPayeeStore } from '#src/adapters/tilia-payees.ts';
import { maybeEdgeTilia } from '#scripts/support/edge-host.ts';
import { openPgPool } from '#src/engines/pg-driver.ts';
import { isPostgresUrl } from '#src/env.ts';
import { testLogger } from '#test/support/capabilities.ts';

import type { PgPoolLike } from '#src/engines/pg-driver.ts';

const DB_URL = process.env.DATABASE_URL ?? '';
const SKIP = isPostgresUrl(DB_URL)
  ? false
  : 'the durable payee store needs a postgres DATABASE_URL';

// One scratch database per test file, mirroring the taskq integration
// helper: the table name is fixed, so isolation comes from the database.
async function payeeDatabase(): Promise<{
  url: string;
  pool: PgPoolLike;
  drop(): Promise<void>;
}> {
  const admin = await openPgPool({ connectionString: DB_URL, max: 1 });
  const name = `tilia_payees_it_${process.pid}`;
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const pool = await openPgPool({
    connectionString: url.toString(),
    max: 3,
  });
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

const ROUTING = {
  accountId: 'acct-payee-1',
  sourcePaymentMethodId: 'pm-wallet-1',
  destinationPaymentMethodId: 'pm-paypal-1',
};

async function insertPayee(pool: PgPoolLike, userId: string): Promise<void> {
  // The psql statement from the adapter's header, verbatim — the admin UI is
  // the write path, so the test writes the way an operator would.
  await pool.query(
    `insert into tilia_payees
       (user_id, account_id, source_payment_method_id, destination_payment_method_id)
     values ($1, $2, $3, $4)
     on conflict (user_id) do update
       set account_id = excluded.account_id,
           source_payment_method_id = excluded.source_payment_method_id,
           destination_payment_method_id = excluded.destination_payment_method_id,
           updated_at = now()`,
    [
      userId,
      ROUTING.accountId,
      ROUTING.sourcePaymentMethodId,
      ROUTING.destinationPaymentMethodId,
    ],
  );
}

describe('tiliaPayeeStore', () => {
  test(
    'ensureSchema is idempotent and resolve round-trips a row',
    { skip: SKIP },
    async () => {
      const db = await payeeDatabase();
      try {
        const store = tiliaPayeeStore(db.pool);
        await store.ensureSchema();
        await store.ensureSchema();
        await insertPayee(db.pool, 'usr_seller');
        assert.deepEqual(await store.resolve('usr_seller'), ROUTING);
      } finally {
        await db.drop();
      }
    },
  );

  test(
    'a missing payee fails with the statement the operator needs',
    { skip: SKIP },
    async () => {
      const db = await payeeDatabase();
      try {
        const store = tiliaPayeeStore(db.pool);
        await store.ensureSchema();
        await assert.rejects(
          store.resolve('usr_unmapped'),
          /no tilia_payees row for usr_unmapped/,
        );
      } finally {
        await db.drop();
      }
    },
  );

  test(
    'the bridge boots in store mode and resolves payees durably',
    { skip: SKIP },
    async () => {
      const db = await payeeDatabase();
      let host;
      try {
        host = await maybeEdgeTilia(
          {
            TILIA_CLIENT_ID: 'client',
            TILIA_CLIENT_SECRET: 'secret',
            TILIA_ACCOUNT_ID: 'acct',
            TILIA_PAYEE_DATABASE_URL: db.url,
          },
          testLogger(),
        );
        assert.notEqual(host, undefined);
        await insertPayee(db.pool, 'usr_seller');
        const row = await db.pool.query(
          'select user_id from tilia_payees order by user_id',
        );
        assert.equal(row.rows.length, 1);
      } finally {
        await host?.stop();
        await db.drop();
      }
    },
  );
});
