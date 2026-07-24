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
  openInstanceSession,
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

// Fee-less on purpose: these tests exercise the netting mechanics, and the fee split is the
// caller's leg-building concern (see the module example).
function purchase(buyer: string, creator: string, minor: bigint): Leg[] {
  const amount = toAmount('CREDIT', minor);
  return [debit(spendable(buyer), amount), credit(earned(creator), amount)];
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
    const session = openInstanceSession(deps, 'sess_a', { maxBatch: 2 });

    const first = await session.record({
      idempotencyKey: 'buy_1',
      legs: purchase('usr_v1', 'usr_c1', 100n),
    });
    assert.deepEqual(first, { status: 'accepted', seq: 0 });
    assert.deepEqual(
      await session.record({
        idempotencyKey: 'buy_1',
        legs: purchase('usr_v1', 'usr_c1', 100n),
      }),
      { status: 'accepted', seq: 0 },
    );
    await session.record({
      idempotencyKey: 'buy_2',
      legs: purchase('usr_v1', 'usr_c1', 50n),
    });
    // maxBatch=2 flushed the first two; the third waits for flush().
    await session.record({
      idempotencyKey: 'buy_3',
      legs: purchase('usr_v1', 'usr_c1', 25n),
    });
    await session.flush();

    const rows = [];
    for await (const movement of store.movements.bySession('sess_a')) {
      rows.push(movement);
    }
    assert.deepEqual(
      rows.map((row) => [row.seq, row.idempotencyKey]),
      [
        [0, 'buy_1'],
        [1, 'buy_2'],
        [2, 'buy_3'],
      ],
    );
    assert.equal(rows[1]!.prevHash, rows[0]!.hash);
    assert.equal(rows[2]!.prevHash, rows[1]!.hash);
  });

  test('settles the net through clearing and leaves the ledger provable', async () => {
    const { store, digest, deps } = harness();
    await fund(store, 'usr_v1', 1_000n);
    const session = openInstanceSession(deps, 'sess_b');
    for (let i = 0; i < 10; i++) {
      await session.record({
        idempotencyKey: `buy_b_${i}`,
        legs: purchase('usr_v1', 'usr_c1', 10n),
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
    const session = openInstanceSession(deps, 'sess_c', { chunkWidth: 3 });
    for (let i = 0; i < 7; i++) {
      await session.record({
        idempotencyKey: `buy_c_${i}`,
        legs: purchase('usr_v1', `usr_cr_${i}`, 10n),
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
    const session = openInstanceSession(deps, 'sess_d');

    await session.record({
      idempotencyKey: 'd_1',
      legs: purchase('usr_v2', 'usr_c1', 80n),
    });
    const over = await session.record({
      idempotencyKey: 'd_2',
      legs: purchase('usr_v2', 'usr_c1', 30n), // 80 pending + 30 > 100
    });

    assert.deepEqual(over, {
      status: 'rejected',
      reason: 'INSUFFICIENT_FUNDS',
    });
  });

  test('throws on unbalanced or non-CREDIT legs instead of rejecting', async () => {
    const { deps } = harness();
    const session = openInstanceSession(deps, 'sess_m');
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
    const one = openInstanceSession(deps, 'sess_e1', { reservations });
    const two = openInstanceSession(deps, 'sess_e2', { reservations });

    assert.equal(
      (
        await one.record({
          idempotencyKey: 'e_1',
          legs: purchase('usr_v3', 'usr_c1', 400n),
        })
      ).status,
      'accepted',
    );
    assert.deepEqual(
      await two.record({
        idempotencyKey: 'e_2',
        legs: purchase('usr_v3', 'usr_c2', 400n),
      }),
      { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' },
    );

    await one.settle();
    assert.equal(
      (
        await two.record({
          idempotencyKey: 'e_3',
          legs: purchase('usr_v3', 'usr_c2', 100n),
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
    const session = openInstanceSession(deps, 'sess_f', { chunkWidth: 2 });
    await session.record({
      idempotencyKey: 'f_1',
      legs: purchase('usr_v4', 'usr_c1', 300n),
    });
    await session.record({
      idempotencyKey: 'f_2',
      legs: purchase('usr_v5', 'usr_c2', 300n),
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
    const session = openInstanceSession(deps, 'sess_g');
    await session.record({
      idempotencyKey: 'g_1',
      legs: purchase('usr_v6', 'usr_c1', 100n),
    });
    await session.record({
      idempotencyKey: 'g_2',
      legs: purchase('usr_v6', 'usr_c1', 50n),
    });
    await session.flush();
    // The process dies here; a new one rebuilds the session from the journal alone.

    const recovered = await recoverSession(deps, 'sess_g');
    assert.deepEqual(
      await recovered.record({
        idempotencyKey: 'g_1',
        legs: purchase('usr_v6', 'usr_c1', 100n),
      }),
      { status: 'accepted', seq: 0 },
    );
    const report = await recovered.settle();

    assert.equal(report.mode, 'netted');
    assert.equal(report.netted, 2);
    assert.equal(await balanceOf(store, spendable('usr_v6')), 850n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 150n);
  });

  test('a settled session refuses further movements; a new epoch takes them', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v8', 1_000n);
    const session = openInstanceSession(deps, 'sess:scope:0');
    await session.record({
      idempotencyKey: 'h_1',
      legs: purchase('usr_v8', 'usr_c1', 100n),
    });
    await session.settle();

    // Re-recording would collide with the settled epoch's chunk txn ids and strand the money;
    // the session throws instead, and the rotation pattern carries on in a fresh epoch.
    await assert.rejects(
      () =>
        session.record({
          idempotencyKey: 'h_2',
          legs: purchase('usr_v8', 'usr_c1', 50n),
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'SESSION.SETTLED',
    );

    const next = openInstanceSession(deps, 'sess:scope:1');
    await next.record({
      idempotencyKey: 'h_2',
      legs: purchase('usr_v8', 'usr_c1', 50n),
    });
    await next.settle();
    assert.equal(await balanceOf(store, spendable('usr_v8')), 850n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 150n);
  });

  test('an empty settle does not seal the session', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v9', 1_000n);
    const session = openInstanceSession(deps, 'sess_empty');
    await session.settle();
    // Nothing was netted, so no txn id was minted and recording may begin.
    await session.record({
      idempotencyKey: 'i_1',
      legs: purchase('usr_v9', 'usr_c1', 100n),
    });
    const report = await session.settle();
    assert.equal(report.netted, 1);
    assert.equal(await balanceOf(store, earned('usr_c1')), 100n);
  });

  test('recovery of a settled session refuses new movements and re-settles idempotently', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v10', 1_000n);
    const session = openInstanceSession(deps, 'sess_j');
    await session.record({
      idempotencyKey: 'j_1',
      legs: purchase('usr_v10', 'usr_c1', 100n),
    });
    await session.settle();

    const recovered = await recoverSession(deps, 'sess_j');
    await assert.rejects(
      () =>
        recovered.record({
          idempotencyKey: 'j_2',
          legs: purchase('usr_v10', 'usr_c1', 50n),
        }),
      (error: unknown) =>
        (error as { code?: string }).code === 'SESSION.SETTLED',
    );
    // A second settle finishes idempotently: every chunk already exists, so nothing re-posts.
    const report = await recovered.settle();
    assert.equal(report.mode, 'netted');
    assert.equal(await balanceOf(store, spendable('usr_v10')), 900n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 100n);
  });

  test('recovery after a partial replay finishes down the replay path, never re-netting', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v11', 1_000n);
    const session = openInstanceSession(deps, 'sess_k');
    await session.record({
      idempotencyKey: 'k_1',
      legs: purchase('usr_v11', 'usr_c1', 100n),
    });
    await session.record({
      idempotencyKey: 'k_2',
      legs: purchase('usr_v11', 'usr_c2', 40n),
    });
    await session.flush();

    // Simulate a crash mid-replay: movement seq 1 already went ledger-final under its replay
    // txn id; seq 0 did not. A netted re-settle would re-post seq 1's money inside the net.
    await store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'mv_sess_k_1',
        legs: purchase('usr_v11', 'usr_c2', 40n),
        meta: { kind: 'instance_movement_replay', sessionId: 'sess_k', seq: 1 },
      }),
    );

    const recovered = await recoverSession(deps, 'sess_k');
    const report = await recovered.settle();

    assert.equal(report.mode, 'replayed');
    // Each movement is ledger-final exactly once: seq 1's existing posting was skipped.
    assert.equal(await balanceOf(store, spendable('usr_v11')), 860n);
    assert.equal(await balanceOf(store, earned('usr_c1')), 100n);
    assert.equal(await balanceOf(store, earned('usr_c2')), 40n);
    const chain = await proveChain({
      ledger: store.ledger,
      digest: deps['digest'],
    });
    assert.equal(chain.intact, true);
  });

  test('refuses to settle over a tampered journal', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_v7', 1_000n);
    const session = openInstanceSession(deps, 'sess_h');
    await session.record({
      idempotencyKey: 'h_1',
      legs: purchase('usr_v7', 'usr_c1', 100n),
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
