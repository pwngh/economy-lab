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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { decodeAmountWire, toAmount } from '#src/money.ts';
import { spendable } from '#src/accounts.ts';
import {
  makeIsolatedMysqlStore,
  makeIsolatedPostgresStore,
  testMysqlUrl,
  testPostgresUrl,
} from '#test/support/adapters.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Movement } from '#src/ports.ts';
import type { MysqlPool } from '@pwngh/economy-mysql';
import type { PgPool } from '@pwngh/economy-postgres';

const mysqlUrl = testMysqlUrl(process.env);
const postgresUrl = testPostgresUrl(process.env);

// Minor units whose major rendering differs from the digits themselves, so a value written in the
// wrong unit cannot decode back to the right number. 60_000n is `CREDIT:600.00` canonically and
// `CREDIT:60000` in minor units; feeding the latter to the canonical decoder yields 6_000_000n.
// A control of 0n is deliberately absent: `CREDIT:0.00` and `CREDIT:0` both decode to 0n, so it
// would pass under either encoding and prove nothing.
const CASES = [
  { label: 'six hundred credits', minor: 60_000n, canonical: 'CREDIT:600.00' },
  { label: 'two credits fifty', minor: 250n, canonical: 'CREDIT:2.50' },
] as const;

const SESSION = 'ses_legwire';

function movementFor(minor: bigint, seq: number): Movement {
  return {
    sessionId: SESSION,
    seq,
    idempotencyKey: `mv_legwire_${seq}`,
    legs: [
      {
        account: spendable('usr_legwire_a'),
        amount: toAmount('CREDIT', minor),
      },
      {
        account: spendable('usr_legwire_b'),
        amount: toAmount('CREDIT', -minor),
      },
    ],
    prevHash: '0'.repeat(64),
    hash: `${seq}`.padStart(64, '0'),
    recordedAt: 1_000 + seq,
  };
}

// The raw persisted `legs` payload for each case, read straight out of the column rather than
// through the engine's own decoder. A hand-rolled encoder and its matching hand-rolled decoder
// round-trip consistently, so reading through the store proves nothing about the bytes on disk.
type StoredLegs = ReadonlyArray<unknown>;

describe('Engine leg wire form', () => {
  test('mysql persists legs as the lab canonical wire form', async (t) => {
    if (!mysqlUrl) {
      t.skip('mysql rig not configured (MYSQL_TEST_URL / DATABASE_URL)');
      return;
    }
    let pool: MysqlPool | undefined;
    const store = await makeIsolatedMysqlStore({
      url: mysqlUrl,
      digest: seededDigest(1),
      clock: fixedClock(0),
      wrapPool: (p) => {
        pool = p;
        return p;
      },
    });
    try {
      await store.movements.append(
        CASES.map((c, i) => movementFor(c.minor, i)),
      );
      const [rows] = await pool!.query(
        `SELECT seq, legs FROM instance_movements WHERE session_id = ? ORDER BY seq`,
        [SESSION],
      );
      const persisted = rows as ReadonlyArray<{ seq: number; legs: unknown }>;
      assert.equal(persisted.length, CASES.length, 'every movement persisted');

      for (const [i, expected] of CASES.entries()) {
        const legs = (
          typeof persisted[i]!.legs === 'string'
            ? JSON.parse(persisted[i]!.legs as string)
            : persisted[i]!.legs
        ) as StoredLegs;
        const first = legs[0] as { amount: unknown };
        assert.equal(
          typeof first.amount,
          'string',
          `${expected.label}: leg amount is a wire string`,
        );
        // The number, not the shape: what the stored text means to the lab's one decoder.
        assert.equal(
          decodeAmountWire(first.amount as string).minor,
          expected.minor,
          `${expected.label}: stored ${JSON.stringify(first.amount)} must decode to ${expected.minor} minor`,
        );
        assert.equal(
          first.amount,
          expected.canonical,
          `${expected.label}: stored text is the canonical encoding`,
        );
      }
    } finally {
      await store.close();
    }
  });

  test('postgres persists legs as the lab canonical wire form', async (t) => {
    if (!postgresUrl) {
      t.skip('postgres rig not configured (DATABASE_URL / PG_URL)');
      return;
    }
    let pool: PgPool | undefined;
    const store = await makeIsolatedPostgresStore({
      url: postgresUrl,
      digest: seededDigest(1),
      clock: fixedClock(0),
      wrapPool: (p) => {
        pool = p;
        return p;
      },
    });
    try {
      await store.movements.append(
        CASES.map((c, i) => movementFor(c.minor, i)),
      );
      const result = await pool!.query(
        `SELECT seq, legs FROM instance_movements WHERE session_id = $1 ORDER BY seq`,
        [SESSION],
      );
      const persisted = result.rows;
      assert.equal(persisted.length, CASES.length, 'every movement persisted');

      for (const [i, expected] of CASES.entries()) {
        const legs = (
          typeof persisted[i]!.legs === 'string'
            ? JSON.parse(persisted[i]!.legs as string)
            : persisted[i]!.legs
        ) as StoredLegs;
        const first = legs[0] as { amount: unknown };
        assert.equal(
          typeof first.amount,
          'string',
          `${expected.label}: leg amount is a wire string`,
        );
        assert.equal(
          decodeAmountWire(first.amount as string).minor,
          expected.minor,
          `${expected.label}: stored ${JSON.stringify(first.amount)} must decode to ${expected.minor} minor`,
        );
        assert.equal(
          first.amount,
          expected.canonical,
          `${expected.label}: stored text is the canonical encoding`,
        );
      }
    } finally {
      await store.close();
    }
  });

  // The engines wrote different bytes for the same legs, so agreement is the property, not each
  // engine's own round trip: a hand-rolled encoder and its matching decoder always agree with
  // themselves.
  test('both engines persist the same legs as the same bytes', async (t) => {
    if (!mysqlUrl || !postgresUrl) {
      t.skip('both rigs required for the cross-engine differential');
      return;
    }
    let myPool: MysqlPool | undefined;
    let pgPool: PgPool | undefined;
    const my = await makeIsolatedMysqlStore({
      url: mysqlUrl,
      digest: seededDigest(1),
      clock: fixedClock(0),
      wrapPool: (p) => {
        myPool = p;
        return p;
      },
    });
    const pg = await makeIsolatedPostgresStore({
      url: postgresUrl,
      digest: seededDigest(1),
      clock: fixedClock(0),
      wrapPool: (p) => {
        pgPool = p;
        return p;
      },
    });
    try {
      const movements = CASES.map((c, i) => movementFor(c.minor, i));
      await my.movements.append(movements);
      await pg.movements.append(movements);

      const [myRows] = await myPool!.query(
        `SELECT legs FROM instance_movements WHERE session_id = ? ORDER BY seq`,
        [SESSION],
      );
      const pgResult = await pgPool!.query(
        `SELECT legs FROM instance_movements WHERE session_id = $1 ORDER BY seq`,
        [SESSION],
      );
      const normalize = (legs: unknown): string =>
        JSON.stringify(typeof legs === 'string' ? JSON.parse(legs) : legs);

      const mysqlLegs = (myRows as ReadonlyArray<{ legs: unknown }>).map((r) =>
        normalize(r.legs),
      );
      const postgresLegs = pgResult.rows.map((r) => normalize(r.legs));

      assert.equal(mysqlLegs.length, CASES.length, 'mysql persisted every row');
      assert.deepEqual(
        mysqlLegs,
        postgresLegs,
        'the two engines spell one leg one way',
      );
      assert.match(
        mysqlLegs[0]!,
        /CREDIT:600\.00/,
        'and that way is the canonical wire form',
      );
    } finally {
      await my.close();
      await pg.close();
    }
  });

  // Rows written by the older MySQL emit are still on disk. Reading one back must name it, not
  // silently return a hundred times the amount it was written to hold.
  test('a leg stored in minor units is refused, not misread', async (t) => {
    if (!mysqlUrl) {
      t.skip('mysql rig not configured (MYSQL_TEST_URL / DATABASE_URL)');
      return;
    }
    let pool: MysqlPool | undefined;
    const store = await makeIsolatedMysqlStore({
      url: mysqlUrl,
      digest: seededDigest(1),
      clock: fixedClock(0),
      wrapPool: (p) => {
        pool = p;
        return p;
      },
    });
    try {
      // The exact bytes the deleted encoder produced for 2.50 CREDIT.
      const legacy = JSON.stringify([
        { account: spendable('usr_legwire_a'), amount: 'CREDIT:250' },
        { account: spendable('usr_legwire_b'), amount: 'CREDIT:-250' },
      ]);
      await pool!.query(
        `INSERT INTO instance_movements
           (session_id, seq, idem_key, legs, prev_hash, hash, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          SESSION,
          0,
          'mv_legwire_legacy',
          legacy,
          '0'.repeat(64),
          '1'.padStart(64, '0'),
          1_000,
        ],
      );

      await assert.rejects(
        async () => {
          // Draining is what forces the decode.
          const drained = [];
          for await (const movement of store.movements.bySession(SESSION)) {
            drained.push(movement);
          }
          return drained;
        },
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'MONEY.INVALID_AMOUNT');
          assert.match(error.message, /CREDIT:250/);
          // The refusal must not hand back a repair value: 'CREDIT:250.00' is what the text
          // misreads as, and writing that would inflate the row a hundredfold.
          assert.doesNotMatch(error.message, /CREDIT:250\.00/);
          return true;
        },
      );
    } finally {
      await store.close();
    }
  });
});
