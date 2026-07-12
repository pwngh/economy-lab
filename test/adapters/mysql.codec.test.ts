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
 * Database-less coverage for the MySQL inbox Operation codec: the conformance leg skips without a
 * live MySQL, so the encode, stringify, parse, decode round-trip could regress silently in a
 * no-services run. A tiny fake `MysqlPool` drives the real `mysqlStore` inbox path exactly as the
 * engine wires it. The pinned regression: `JSON.stringify` on a raw branded Amount throws on its
 * bigint minor, so no amount-bearing inbound settlement could be stored.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { mysqlStore } from '#src/engines/mysql.ts';
import { toAmount, isAmount } from '#src/money.ts';

import type { MysqlPool } from '#src/engines/mysql.ts';
import type { Operation } from '#src/contract.ts';
import type { InboxEntry } from '#src/ports.ts';

// Mirrors the conformance suite's inboxRow, so the same amount-bearing shape is covered.
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

// The smallest fake of the mysql2 pool the inbox store touches. It stores the `operation` column
// as the JSON string the engine hands it, so read-back goes through the same JSON.parse path a
// live JSON column would take, with no driver.
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
          operation,
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

    const stored = await store.transaction((unit) =>
      unit.inbox.enqueueInbound(entry),
    );

    assert.equal(stored.id, entry.id);
    assert.equal(stored.key, entry.key);
    assert.equal(stored.operation.kind, 'topUp');
    assert.equal(stored.operation.idempotencyKey, 'evt_codec_1');
    assert.equal(stored.operation.source, 'card');

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
