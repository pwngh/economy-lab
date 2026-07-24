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
 * The retention sweep: horizon-gated idempotency deletion (a deleted key re-executes),
 * verify-then-prune of settled sessions' journal rows, the untouched cases (live sessions,
 * young rows), and the worker job's opt-in gate through request and defaults.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { sweepRetention } from '#src/worker/retention.ts';
import { createWorker, runSweeps } from '#src/worker/index.ts';
import { openInstanceSession } from '#src/netting.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import { createEconomy } from '#src/economy.ts';
import {
  fixedClock,
  makePorts,
  makeWorkerCtx,
  seededDigest,
} from '#test/support/capabilities.ts';

import type { Leg, Store } from '#src/ports.ts';
import type { Transaction } from '#src/contract.ts';

const HORIZON = 100_000;

function harness() {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  return { store, deps: { store, digest, clock } };
}

function fund(
  store: Store,
  userId: string,
  minor: bigint,
): Promise<Transaction> {
  return store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: `txn_fund_${userId}`,
      legs: [
        credit(spendable(userId), toAmount('CREDIT', minor)),
        debit(SYSTEM.REVENUE, toAmount('CREDIT', minor)),
      ],
      meta: { source: 'card' },
    }),
  );
}

function purchase(buyer: string, creator: string, minor: bigint): Leg[] {
  const amount = toAmount('CREDIT', minor);
  return [debit(spendable(buyer), amount), credit(earned(creator), amount)];
}

async function claimRecord(store: Store, key: string, txn: Transaction) {
  assert.deepEqual(await store.idempotency.claim(key), { claimed: true });
  await store.idempotency.record(key, txn);
}

describe('Retention sweep', () => {
  test('idempotency lane deletes only rows past the horizon, up to the limit, reopening their keys', async () => {
    const { store } = harness();
    const txn = await fund(store, 'usr_ret1', 100n);
    await claimRecord(store, 'ret_a', txn);
    await claimRecord(store, 'ret_b', txn);
    await claimRecord(store, 'ret_c', txn);
    assert.equal((await store.idempotency.claim('ret_a')).claimed, false);

    // Inside the horizon (rows born at 0, cutoff at -50k): nothing deletes.
    const young = await sweepRetention(store, makeWorkerCtx(), {
      now: 50_000,
      limit: 100,
      idempotencyOlderThanMs: HORIZON,
    });
    assert.deepEqual(young.idempotency, { deleted: 0 });
    assert.equal((await store.idempotency.claim('ret_a')).claimed, false);

    // Past the horizon: deletion binds to the limit, then finishes next run.
    const first = await sweepRetention(store, makeWorkerCtx(), {
      now: 200_000,
      limit: 2,
      idempotencyOlderThanMs: HORIZON,
    });
    assert.deepEqual(first.idempotency, { deleted: 2 });
    const second = await sweepRetention(store, makeWorkerCtx(), {
      now: 200_000,
      limit: 100,
      idempotencyOlderThanMs: HORIZON,
    });
    assert.deepEqual(second.idempotency, { deleted: 1 });
    // The key is open again: a duplicate request would re-execute.
    assert.deepEqual(await store.idempotency.claim('ret_a'), { claimed: true });
  });

  test('sessions lane prunes only settled sessions past the horizon; money and live sessions stay', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_ret2', 100n);
    const settled = openInstanceSession(deps, 'sess_ret_settled', {});
    await settled.record({
      idempotencyKey: 'ret2_a',
      legs: purchase('usr_ret2', 'usr_c2', 30n),
    });
    await settled.settle();
    const open = openInstanceSession(deps, 'sess_ret_open', {});
    await open.record({
      idempotencyKey: 'ret2_b',
      legs: purchase('usr_ret2', 'usr_c2', 10n),
    });
    await open.flush();

    // Inside the horizon: the settled session's rows stay.
    const young = await sweepRetention(store, makeWorkerCtx(), {
      now: 50_000,
      limit: 100,
      sessionsOlderThanMs: HORIZON,
    });
    assert.equal(young.sessions.scanned, 2);
    assert.deepEqual(young.sessions.pruned, []);

    const swept = await sweepRetention(store, makeWorkerCtx(), {
      now: 200_000,
      limit: 100,
      sessionsOlderThanMs: HORIZON,
    });
    assert.deepEqual(swept.sessions.pruned, [
      { sessionId: 'sess_ret_settled', movements: 1 },
    ]);
    assert.deepEqual(swept.sessions.failed, []);
    // The settled money is untouched; only journal history is gone.
    assert.equal((await store.ledger.balance(earned('usr_c2'))).minor, 30n);
    const rows = [];
    for await (const row of store.movements.bySession('sess_ret_settled')) {
      rows.push(row);
    }
    assert.deepEqual(rows, []);
    // The live session stays enumerable — the orphan sweep's candidate set, now shrunk.
    const ids = [];
    for await (const id of store.movements.sessionIds!()) {
      ids.push(id);
    }
    assert.deepEqual(ids, ['sess_ret_open']);
  });

  test('the worker job idles without the opt-in and runs under bound defaults', async () => {
    const { store } = harness();
    const ports = makePorts(store);
    const idle = await runSweeps(store, ports, { only: ['retention'] });
    assert.deepEqual(idle.retention, {
      ok: true,
      summary: {
        idempotency: { deleted: 0, skipped: true },
        sessions: {
          scanned: 0,
          pruned: [],
          escrowRefunds: [],
          failed: [],
          skipped: true,
        },
      },
    });

    const worker = createWorker(ports, createEconomy(ports), {
      only: ['retention'],
      retention: {
        idempotencyOlderThanMs: HORIZON,
        sessionsOlderThanMs: HORIZON,
      },
    });
    const { batch } = await worker.sweep({ now: 200_000 });
    assert.equal(batch.retention.ok, true);
    if (batch.retention.ok) {
      assert.equal(batch.retention.summary.idempotency.skipped, undefined);
      assert.equal(batch.retention.summary.sessions.skipped, undefined);
    }
  });
});
