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

// The rolling re-proof: budget-bounded pages of stored chain links re-derived from their own
// content, a persistent cursor, and the verified-through watermark — the sweep that makes "how
// much of stored history has been re-hashed, and how recently" a stated fact.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { reproveStoredChains } from '#src/worker/reproof.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  makeWorkerCtx,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Leg, Store } from '#src/ports.ts';

function setup(): { store: Store; workerCtx: WorkerCtx } {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  return {
    store: memoryStore({ digest, clock }),
    workerCtx: makeWorkerCtx({ clock, digest, config: testConfig() }),
  };
}

async function post(store: Store, txnId: string, userId: string) {
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId,
      legs: [
        debit(SYSTEM.STORED_VALUE, toAmount('CREDIT', 100n)),
        credit(spendable(userId), toAmount('CREDIT', 100n)),
      ],
      meta: { kind: 'topUp', source: 'card' },
    }),
  );
}

describe('reproveStoredChains', () => {
  test('walks pages on a persistent cursor and stamps the rotation watermark', async () => {
    const { store, workerCtx } = setup();
    for (let i = 0; i < 5; i += 1) {
      await post(store, `txn_rp_${i}`, `usr_rp_${i}`);
    }

    // 5 postings at 2 per tick: two mid-rotation ticks, then the completing tick.
    const first = await reproveStoredChains(store, workerCtx, {
      now: 10,
      limit: 2,
    });
    assert.equal(first.skipped, false);
    assert.equal(first.checked, 4); // 2 postings x 2 links
    assert.notEqual(first.cursor, null);
    assert.equal(first.rotatedAt, null); // no complete pass yet — honestly unknown

    const second = await reproveStoredChains(store, workerCtx, {
      now: 20,
      limit: 2,
    });
    assert.equal(second.checked, 4);

    const third = await reproveStoredChains(store, workerCtx, {
      now: 30,
      limit: 2,
    });
    assert.equal(third.checked, 2);
    assert.equal(third.cursor, null);
    assert.equal(third.rotatedAt, 30); // every stored link re-derived as of now

    // The watermark survives in the store, and the next rotation starts over from the oldest.
    assert.deepEqual(await store.checkpoints.reproof!(), {
      cursor: null,
      rotatedAt: 30,
    });
    const restart = await reproveStoredChains(store, workerCtx, {
      now: 40,
      limit: 100,
    });
    assert.equal(restart.checked, 10);
    assert.equal(restart.rotatedAt, 40);
  });

  test('an in-place edit anywhere in stored history throws CHAIN_BROKEN and holds the cursor', async () => {
    const { store, workerCtx } = setup();
    for (let i = 0; i < 3; i += 1) {
      await post(store, `txn_rq_${i}`, `usr_rq_${i}`);
    }
    (store.ledger as MemoryLedger).__tamper('txn_rq_1', (legs: Leg[]) => {
      legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
    });

    await assert.rejects(
      () => reproveStoredChains(store, workerCtx, { now: 10, limit: 100 }),
      (error: unknown) => (error as { code?: string }).code === 'CHAIN.BROKEN',
    );
    // The cursor never advanced past the break: the next tick re-reports it.
    assert.equal(await store.checkpoints.reproof!(), null);
    await assert.rejects(() =>
      reproveStoredChains(store, workerCtx, { now: 20, limit: 100 }),
    );
  });

  test('reports itself skipped on a store without reproof state', async () => {
    const { store, workerCtx } = setup();
    const bare: Store = {
      ...store,
      checkpoints: {
        put: store.checkpoints.put.bind(store.checkpoints),
        latest: store.checkpoints.latest.bind(store.checkpoints),
      },
    };
    const summary = await reproveStoredChains(bare, workerCtx, {
      now: 10,
      limit: 100,
    });
    assert.deepEqual(summary, {
      checked: 0,
      cursor: null,
      rotatedAt: null,
      skipped: true,
    });
  });
});
