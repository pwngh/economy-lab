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

import {
  idempotencyKey,
  systemActor,
  toAmount,
  topUp,
} from '@pwngh/economy-lab';
import type { InboxMessage, Store } from '@pwngh/economy-lab/ports';

import { applyMysqlSchema, createMysqlPool, mysqlStore } from '../src/index.js';
// Not through the lab's exports map, which names no such subpath: a dependency-free file under
// the lab's own test tree, reached by relative path and rostered in
// test/toolchain-shape.test.ts#PACKAGE_REACH. It imports nothing, so the pool this rig hands it
// is this package's source pool and no second copy of anything arrives with it.
import {
  freshName,
  onThrowawayDatabase,
} from '../../../test/support/throwaway-database.js';

const url = process.env.MYSQL_TEST_URL ?? '';
const live = url.startsWith('mysql://');

// The sample the race was first measured over. Each pair dead-letters four rows and asks two
// revivers for four each, so a reviver that ignores the other can hand back all four twice.
const PAIRS = 25;
const ROWS_PER_PAIR = 4;

function deadRow(id: string, receivedAt: number): InboxMessage {
  return {
    id,
    key: `evt_${id}`,
    operation: topUp({
      idempotencyKey: idempotencyKey('revive', id),
      actor: systemActor('webhook:billing'),
      userId: 'usr_revive_race',
      amount: toAmount('CREDIT', 1_000n),
      source: 'card',
    }),
    status: 'pending',
    attempts: 0,
    receivedAt,
    reason: null,
  };
}

// applyMysqlSchema drops and recreates its tables, so it never runs against the shared database.
// The `el_` prefix is what the lab's stale-namespace sweep looks for, so a database this run is
// killed before dropping is reclaimed by the next one instead of accumulating on the rig.
function onFreshDatabase(work: (store: Store) => Promise<void>): Promise<void> {
  return onThrowawayDatabase(
    {
      serverUrl: url,
      database: freshName('el_revive'),
      openPool: createMysqlPool,
    },
    async (pool) => {
      await applyMysqlSchema(pool);
      await work(mysqlStore({ pool }));
    },
  );
}

// reviveDead is a claim, not a read: the supervisor's dead-letter lever hands each revived row to
// exactly one caller, so two operators pulling the lever at once cannot both re-apply the same
// inbound operation.
describe('concurrent reviveDead calls', () => {
  test('never hand the same message to both revivers', async (t) => {
    if (!live) {
      t.skip('MYSQL_TEST_URL unset');
      return;
    }
    await onFreshDatabase(async (store) => {
      const overlaps: number[] = [];
      for (let pair = 0; pair < PAIRS; pair += 1) {
        const ids = Array.from(
          { length: ROWS_PER_PAIR },
          (_unused, index) => `ibx_race_${pair}_${index}`,
        );
        await store.transaction(async (unit) => {
          for (const [index, id] of ids.entries()) {
            await unit.inbox.enqueueInbound(
              deadRow(id, pair * ROWS_PER_PAIR + index),
            );
          }
        });
        for (const id of ids) {
          await store.inbox.deadLetter(id, 'poison');
        }

        const [left, right] = await Promise.all([
          store.inbox.reviveDead(ROWS_PER_PAIR),
          store.inbox.reviveDead(ROWS_PER_PAIR),
        ]);
        const taken = new Set(left.map((entry) => entry.id));
        overlaps.push(right.filter((entry) => taken.has(entry.id)).length);

        // Every dead row reaches a reviver, so a pair that hands out nothing cannot pass the
        // disjointness assertion by examining nothing.
        assert.deepEqual(
          [...new Set([...left, ...right].map((entry) => entry.id))].sort(),
          [...ids].sort(),
          `pair ${pair} did not revive every dead row`,
        );
        for (const id of ids) {
          await store.inbox.markApplied(id);
        }
      }

      assert.equal(overlaps.length, PAIRS);
      assert.deepEqual(
        overlaps,
        Array.from({ length: PAIRS }, () => 0),
        `ids handed to both revivers, per pair: ${overlaps.join(',')}`,
      );
    });
  });

  // The locks a revive takes have to live somewhere. Inside a transaction that is the caller's,
  // so the revive commits and rolls back with it rather than on a connection of its own.
  test('a revive inside a rolled-back transaction leaves the rows dead', async (t) => {
    if (!live) {
      t.skip('MYSQL_TEST_URL unset');
      return;
    }
    await onFreshDatabase(async (store) => {
      const ids = ['ibx_rollback_a', 'ibx_rollback_b'];
      await store.transaction(async (unit) => {
        for (const [index, id] of ids.entries()) {
          await unit.inbox.enqueueInbound(deadRow(id, index));
        }
      });
      for (const id of ids) {
        await store.inbox.deadLetter(id, 'poison');
      }

      await assert.rejects(
        store.transaction(async (unit) => {
          const revived = await unit.inbox.reviveDead(ids.length);
          assert.deepEqual(
            revived.map((entry) => entry.id).sort(),
            [...ids].sort(),
          );
          throw new Error('abandon the revive');
        }),
        /abandon the revive/,
      );

      const claimable = await store.inbox.claimInbound({
        now: 0,
        limit: 100,
      });
      assert.deepEqual(
        claimable.filter((entry) => ids.includes(entry.id)),
        [],
      );
      const afterRollback = await store.inbox.reviveDead(ids.length);
      assert.deepEqual(
        afterRollback.map((entry) => entry.id).sort(),
        [...ids].sort(),
      );
    });
  });
});
