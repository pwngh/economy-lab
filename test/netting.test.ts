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
 * Instance netting (src/netting.ts) against the in-memory store. The load-bearing invariant:
 * every path leaves the chains intact, clearing at zero, and every accepted movement with
 * exactly one ledger-final outcome.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReservations,
  instanceSession,
  recoverSession,
} from '#src/netting.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { proveChain } from '#src/chain.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Digest, Leg, Store } from '#src/ports.ts';

function harness(): { store: Store; digest: Digest; deps: never } {
  const digest = seededDigest(1);
  const store = memoryStore({ digest, clock: fixedClock(0) });
  return {
    store,
    digest,
    deps: { store, digest, clock: fixedClock(0) } as never,
  };
}

async function fund(store: Store, userId: string, minor: bigint) {
  await store.transaction((unit) =>
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

// One viewer-tips-creator movement: the viewer's spendable drops, the creator's earned rises.
function tip(viewer: string, creator: string, minor: bigint): Leg[] {
  const amount = toAmount('CREDIT', minor);
  return [debit(spendable(viewer), amount), credit(earned(creator), amount)];
}

async function balanceOf(
  store: Store,
  account: Parameters<Store['ledger']['balance']>[0],
) {
  return (await store.ledger.balance(account)).minor;
}

describe('Instance netting', () => {
  test('accepts, journals in batches, and replays a repeated key', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v1', 1_000n);
    const session = instanceSession(deps, 'sess_a', { maxBatch: 2 });

    const first = await session.record({
      idempotencyKey: 'tip_1',
      legs: tip('usr_v1', 'usr_c1', 100n),
    });
    assert.deepEqual(first, { status: 'accepted', seq: 0 });
    assert.deepEqual(
      await session.record({
        idempotencyKey: 'tip_1',
        legs: tip('usr_v1', 'usr_c1', 100n),
      }),
      { status: 'accepted', seq: 0 },
    );
    await session.record({
      idempotencyKey: 'tip_2',
      legs: tip('usr_v1', 'usr_c1', 50n),
    });
    // maxBatch=2 flushed the first two; the third waits for flush().
    await session.record({
      idempotencyKey: 'tip_3',
      legs: tip('usr_v1', 'usr_c1', 25n),
    });
    await session.flush();

    const rows = [];
    for await (const movement of store.movements.bySession('sess_a')) {
      rows.push(movement);
    }
    assert.deepEqual(
      rows.map((row) => [row.seq, row.idempotencyKey]),
      [
        [0, 'tip_1'],
        [1, 'tip_2'],
        [2, 'tip_3'],
      ],
    );
    assert.equal(rows[1]!.prevHash, rows[0]!.hash);
    assert.equal(rows[2]!.prevHash, rows[1]!.hash);
  });

  test('settles the net through clearing and leaves the ledger provable', async () => {
    const { store, digest, deps } = harness();
    await fund(store, 'usr_v1', 1_000n);
    const session = instanceSession(deps, 'sess_b');
    for (let i = 0; i < 10; i++) {
      await session.record({
        idempotencyKey: `tip_b_${i}`,
        legs: tip('usr_v1', 'usr_c1', 10n),
      });
    }

    const report = await session.settle();

    assert.equal(report.mode, 'netted');
    assert.equal(report.netted, 10);
    assert.equal(report.postings, 1); // two positions fit one chunk
    assert.equal(await balanceOf(store, spendable('usr_v1')), 900n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 100n);
    assert.equal(await balanceOf(store, SYSTEM.NETTING_CLEARING), 0n);
    const posting = await store.ledger.posting('net_sess_b_c0');
    assert.equal(posting !== null, true);
    assert.equal(
      (await proveChain({ ledger: store.ledger, digest })).intact,
      true,
    );

    // Settle is idempotent: a second call re-verifies and re-claims, changing nothing.
    await session.settle();
    assert.equal(await balanceOf(store, spendable('usr_v1')), 900n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 100n);
  });

  test('bounds every settlement posting at the chunk width', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v1', 1_000n);
    const session = instanceSession(deps, 'sess_c', { chunkWidth: 3 });
    for (let i = 0; i < 7; i++) {
      await session.record({
        idempotencyKey: `tip_c_${i}`,
        legs: tip('usr_v1', `usr_cr_${i}`, 10n),
      });
    }

    const report = await session.settle();

    // 8 nonzero positions (7 creators + the viewer) at width 3 → 3 chunks, clearing back to zero.
    assert.equal(report.mode, 'netted');
    assert.equal(report.postings, 3);
    assert.equal(await balanceOf(store, SYSTEM.NETTING_CLEARING), 0n);
    for (let i = 0; i < 7; i++) {
      assert.equal(await balanceOf(store, earned(`usr_cr_${i}`)), 10n);
    }
  });

  test('rejects an unaffordable movement at accept time', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v2', 100n);
    const session = instanceSession(deps, 'sess_d');

    await session.record({
      idempotencyKey: 'd_1',
      legs: tip('usr_v2', 'usr_c1', 80n),
    });
    const over = await session.record({
      idempotencyKey: 'd_2',
      legs: tip('usr_v2', 'usr_c1', 30n), // 80 pending + 30 > 100
    });

    assert.deepEqual(over, {
      status: 'rejected',
      reason: 'INSUFFICIENT_FUNDS',
    });
  });

  test('throws on unbalanced or non-CREDIT legs instead of rejecting', async () => {
    const { deps } = harness();
    const session = instanceSession(deps, 'sess_m');
    const amount = toAmount('CREDIT', 10n);

    await assert.rejects(
      session.record({
        idempotencyKey: 'm_1',
        legs: [debit(spendable('usr_v1'), amount)],
      }),
      (error: Error & { code?: string }) => error.code === 'LEDGER.UNBALANCED',
    );
    await assert.rejects(
      session.record({
        idempotencyKey: 'm_2',
        legs: [
          debit(spendable('usr_v1'), toAmount('USD', 10n)),
          credit(earned('usr_c1'), toAmount('USD', 10n)),
        ],
      }),
      (error: Error & { code?: string }) => error.code === 'OP.MALFORMED',
    );
  });

  test('a shared registry closes the cross-session overdraft race', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v3', 500n);
    const reservations = createReservations();
    const one = instanceSession(deps, 'sess_e1', { reservations });
    const two = instanceSession(deps, 'sess_e2', { reservations });

    assert.equal(
      (
        await one.record({
          idempotencyKey: 'e_1',
          legs: tip('usr_v3', 'usr_c1', 400n),
        })
      ).status,
      'accepted',
    );
    assert.deepEqual(
      await two.record({
        idempotencyKey: 'e_2',
        legs: tip('usr_v3', 'usr_c2', 400n),
      }),
      { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' },
    );

    await one.settle();
    assert.equal(
      (
        await two.record({
          idempotencyKey: 'e_3',
          legs: tip('usr_v3', 'usr_c2', 100n),
        })
      ).status,
      'accepted',
    );
  });

  test('compensates posted chunks and replays per movement when a chunk is refused', async () => {
    const { store, digest, deps } = harness();
    await fund(store, 'usr_v4', 500n);
    await fund(store, 'usr_v5', 500n);
    // chunkWidth 2 forces several chunks, so at least one posts before the refusal.
    const session = instanceSession(deps, 'sess_f', { chunkWidth: 2 });
    await session.record({
      idempotencyKey: 'f_1',
      legs: tip('usr_v4', 'usr_c1', 300n),
    });
    await session.record({
      idempotencyKey: 'f_2',
      legs: tip('usr_v5', 'usr_c2', 300n),
    });

    // The race the session cannot see: usr_v5's funds leave through a DIFFERENT path (no shared
    // registry) between accept and settle, so the net for usr_v5 no longer clears.
    await store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_drain_v5',
        legs: [
          debit(spendable('usr_v5'), toAmount('CREDIT', 400n)),
          credit(SYSTEM.REVENUE, toAmount('CREDIT', 400n)),
        ],
        meta: { source: 'drain' },
      }),
    );

    const report = await session.settle();

    assert.equal(report.mode, 'replayed');
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0]!.idempotencyKey, 'f_2');
    assert.equal(await balanceOf(store, spendable('usr_v4')), 200n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 300n);
    assert.equal(await balanceOf(store, earned('usr_c2')), 0n);
    assert.equal(await balanceOf(store, spendable('usr_v5')), 100n);
    assert.equal(await balanceOf(store, SYSTEM.NETTING_CLEARING), 0n);
    assert.equal(
      (await proveChain({ ledger: store.ledger, digest })).intact,
      true,
    );
  });

  test('recovers a session from the journal and settles it', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v6', 1_000n);
    const session = instanceSession(deps, 'sess_g');
    await session.record({
      idempotencyKey: 'g_1',
      legs: tip('usr_v6', 'usr_c1', 100n),
    });
    await session.record({
      idempotencyKey: 'g_2',
      legs: tip('usr_v6', 'usr_c1', 50n),
    });
    await session.flush();
    // The process dies here; a new one rebuilds the session from the journal alone.

    const recovered = await recoverSession(deps, 'sess_g');
    assert.deepEqual(
      await recovered.record({
        idempotencyKey: 'g_1',
        legs: tip('usr_v6', 'usr_c1', 100n),
      }),
      { status: 'accepted', seq: 0 },
    );
    const report = await recovered.settle();

    assert.equal(report.mode, 'netted');
    assert.equal(report.netted, 2);
    assert.equal(await balanceOf(store, spendable('usr_v6')), 850n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 150n);
  });

  test('refuses to settle over a tampered journal', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v7', 1_000n);
    const session = instanceSession(deps, 'sess_h');
    await session.record({
      idempotencyKey: 'h_1',
      legs: tip('usr_v7', 'usr_c1', 100n),
    });
    await session.flush();

    // The memory store yields live rows, so editing the leg here tampers the stored journal in place.
    const rows = [];
    for await (const movement of store.movements.bySession('sess_h')) {
      rows.push(movement);
    }
    (rows[0]!.legs as Leg[])[0] = {
      account: rows[0]!.legs[0]!.account,
      amount: toAmount('CREDIT', -1n),
    };

    await assert.rejects(
      recoverSession(deps, 'sess_h'),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'CHAIN.BROKEN',
    );
  });
});
