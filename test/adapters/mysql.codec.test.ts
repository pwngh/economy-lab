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
 * Deterministic, database-less coverage for the MySQL inbox Operation codec. The Store conformance
 * suite (test/conformance/store.ts) enqueues an amount-bearing inbox row, but it skips when no live
 * MySQL is reachable. The encode, JSON.stringify, parse, then decode round-trip could therefore
 * regress silently in a no-services run. This test drives the real `mysqlStore` inbox store through a
 * tiny in-memory fake `MysqlPool` with no driver and no database, so the codec runs exactly as the
 * engine wires it. `enqueueInbound` JSON.stringifies the encoded operation into the `operation` JSON
 * column, and the follow-up read runs it back through `rowToInbox` and `decodeOperation`.
 *
 * Regression guard: calling `JSON.stringify(entry.operation)` directly throws "Do not know how to
 * serialize a BigInt" on any amount-bearing operation. Before the codec fix, `enqueueInbound` could
 * not store a single real inbound settlement on MySQL.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { mysqlStore } from '#src/engines/mysql.ts';
import { toAmount, isAmount } from '#src/money.ts';

import type { MysqlPool } from '#src/engines/mysql.ts';
import type { Operation } from '#src/contract.ts';
import type { InboxEntry } from '#src/ports.ts';

// Builds a topUp inbox entry carrying a branded Amount whose minor field is a bigint. This is the
// inbound event the apply worker submits. It mirrors the conformance suite's inboxRow so this test
// covers the same amount-bearing shape.
function topUpEntry(): InboxEntry {
  return {
    id: 'ibx_codec_1',
    key: 'evt_codec_1',
    operation: {
      kind: 'topUp',
      idempotencyKey: 'evt_codec_1',
      actor: { kind: 'system', service: 'webhook:billing' },
      userId: 'usr_codec',
      amount: toAmount('CREDIT', 1_000n),
      source: 'card',
    } as Operation,
    status: 'pending',
    attempts: 0,
    receivedAt: 0,
    reason: null,
  };
}

// Builds the smallest fake of the mysql2 pool the inbox store touches. It holds one in-memory table
// keyed by the row's `key`, plus the bookkeeping statements that `mysqlStore`'s `transaction` runs
// (START TRANSACTION, COMMIT, and lock release). It deliberately stores the `operation` column as the
// JSON string the engine hands it. That way `parseJson` on read goes through the real JSON.parse path
// a JSON column would take, which is the same round-trip a live MySQL exercises but without a driver.
function fakePool(): MysqlPool {
  const inbox = new Map<string, Record<string, unknown>>();

  const run = async (
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<[unknown, unknown]> => {
    const text = sql.trim();
    if (/^INSERT IGNORE INTO inbox/i.test(text)) {
      const [id, key, operation, status, attempts, receivedAt] = params;
      // INSERT IGNORE treats a duplicate `key` as a no-op, so the existing row wins.
      if (!inbox.has(key as string)) {
        inbox.set(key as string, {
          id,
          key,
          operation, // Stores the JSON string the engine passed in, as a JSON column would hold it.
          status,
          attempts,
          received_at: receivedAt,
        });
      }
      return [{ affectedRows: 1 }, undefined];
    }
    if (/FROM inbox/i.test(text) && /WHERE `key` = \?/i.test(text)) {
      const row = inbox.get(params[0] as string);
      return [row ? [row] : [], undefined];
    }
    // START TRANSACTION / COMMIT / ROLLBACK / SELECT RELEASE_ALL_LOCKS(): no-ops for this fake.
    return [{ affectedRows: 0 }, undefined];
  };

  const connection = {
    query: run,
    release: () => {},
  };

  return {
    query: run,
    getConnection: async () => connection,
    end: async () => {},
  };
}

describe('mysql inbox Operation codec', () => {
  test('round-trips an amount-bearing operation, decoding minor back to a bigint Amount', async () => {
    const store = mysqlStore({ pool: fakePool() });
    const entry = topUpEntry();

    // enqueueInbound encodes the operation's Amounts before JSON.stringify, then reads the row back
    // and decodes it through rowToInbox. The bug was stringifying the branded Amount directly, which
    // throws on its bigint minor.
    const stored = await store.transaction((unit) =>
      unit.inbox.enqueueInbound(entry),
    );

    // The non-amount fields survive untouched (the codec leaves plain strings alone).
    assert.equal(stored.id, entry.id);
    assert.equal(stored.key, entry.key);
    assert.equal(stored.operation.kind, 'topUp');
    assert.equal(stored.operation.idempotencyKey, 'evt_codec_1');
    assert.equal(stored.operation.source, 'card');

    // The Amount is a real branded Amount again, with its bigint minor intact across the JSON
    // round-trip. That proves the codec carried it, not a raw JSON.stringify.
    const amount = (stored.operation as Extract<Operation, { kind: 'topUp' }>)
      .amount;
    assert.equal(isAmount(amount), true);
    assert.equal(amount.currency, 'CREDIT');
    assert.equal(amount.minor, 1_000n);
    assert.equal(typeof amount.minor, 'bigint');
    assert.deepEqual(amount, toAmount('CREDIT', 1_000n));

    await store.close();
  });
});
