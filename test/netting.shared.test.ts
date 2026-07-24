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
 * The multi-node netting surface: the shared reservation counter's accept screen across
 * sessions, its fail-closed behavior when the counter is unreachable, cross-process release
 * idempotence, the orphan sweep, the counter repair, and the scope router.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  openInstanceSession,
  recoverSession,
  sharedReservations,
} from '#src/netting.ts';
import {
  reconcileReservations,
  sweepOrphanSessions,
} from '#src/worker/orphans.ts';
import { scopeRouter } from '#src/router.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  makeWorkerCtx,
  seededDigest,
} from '#test/support/capabilities.ts';

import type { Leg, Store } from '#src/ports.ts';

function harness() {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  return { store, deps: { store, digest, clock } };
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

function purchase(buyer: string, creator: string, minor: bigint): Leg[] {
  const amount = toAmount('CREDIT', minor);
  return [debit(spendable(buyer), amount), credit(earned(creator), amount)];
}

describe('Shared reservations (multi-node netting)', () => {
  test('two sessions on the shared counter cannot double-spend one balance', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_n1', 100n);
    const registry = sharedReservations(store);
    // Two sessions stand in for two nodes: each would accept 80 against its own view; the
    // shared counter makes the second see the first's pending.
    const a = openInstanceSession(deps, 'sess_n1_a', {
      reservations: registry,
    });
    const b = openInstanceSession(deps, 'sess_n1_b', {
      reservations: registry,
    });

    const first = await a.record({
      idempotencyKey: 'n1_buy_a',
      legs: purchase('usr_n1', 'usr_c1', 80n),
    });
    assert.equal(first.status, 'accepted');
    const second = await b.record({
      idempotencyKey: 'n1_buy_b',
      legs: purchase('usr_n1', 'usr_c1', 80n),
    });
    assert.deepEqual(second, {
      status: 'rejected',
      reason: 'INSUFFICIENT_FUNDS',
    });
  });

  test('an unreachable counter refuses the movement and unwinds its partial adds', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_n2', 100n);
    const counter = store.reservations!;
    // Fail on the creator's earned leg, after the buyer's debit already applied: the reserve
    // must unwind the debit so nothing stays held for a movement that was never accepted. The
    // fault keys on the account, so the unwind of the buyer's leg still reaches the counter.
    let failOnEarned = false;
    const flaky: typeof counter = {
      add: async (account, delta) => {
        if (failOnEarned && account.includes(':earned')) {
          throw new Error('registry unreachable');
        }
        return counter.add(account, delta);
      },
      pending: (account) => counter.pending(account),
      entries: () => counter.entries(),
    };
    const patched = { ...store, reservations: flaky };
    const session = openInstanceSession(deps, 'sess_n2', {
      reservations: sharedReservations(patched),
    });

    failOnEarned = true;
    await assert.rejects(
      session.record({
        idempotencyKey: 'n2_buy',
        legs: purchase('usr_n2', 'usr_c1', 40n),
      }),
      /registry unreachable/,
    );
    failOnEarned = false;
    assert.equal(await counter.pending(spendable('usr_n2')), 0n);
    const retry = await session.record({
      idempotencyKey: 'n2_buy_retry',
      legs: purchase('usr_n2', 'usr_c1', 100n),
    });
    assert.equal(retry.status, 'accepted');
  });

  test('release is exactly-once across processes: a recovered settle never drives the counter negative', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_n3', 100n);
    const registry = sharedReservations(store);
    const session = openInstanceSession(deps, 'sess_n3', {
      reservations: registry,
    });
    await session.record({
      idempotencyKey: 'n3_buy',
      legs: purchase('usr_n3', 'usr_c1', 60n),
    });
    await session.settle();
    assert.equal(await store.reservations!.pending(spendable('usr_n3')), 0n);

    // A second process recovers the settled session and settles again (the failover race).
    // The durable release claim makes the second release a no-op instead of going negative.
    const again = await recoverSession(deps, 'sess_n3', {
      reservations: registry,
    });
    assert.equal(again.wasSettled(), true);
    await again.settle();
    assert.equal(await store.reservations!.pending(spendable('usr_n3')), 0n);
  });

  test('the orphan sweep reports crashed epochs and settles them past the age bound', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_n4', 100n);
    const registry = sharedReservations(store);
    const session = openInstanceSession(deps, 'sess_n4', {
      reservations: registry,
    });
    await session.record({
      idempotencyKey: 'n4_buy',
      legs: purchase('usr_n4', 'usr_c4', 30n),
    });
    await session.flush();
    // The node dies here: the session object is abandoned, its reservation still held.
    assert.equal(await store.reservations!.pending(spendable('usr_n4')), -30n);

    const ctx = makeWorkerCtx();
    // Report-only by default: the orphan is listed, nothing moves.
    const report = await sweepOrphanSessions(store, ctx, {
      now: 10_000,
      limit: 100,
      reservations: registry,
    });
    assert.deepEqual(report.orphans, [{ sessionId: 'sess_n4', ageMs: 10_000 }]);
    assert.equal(report.settled.length, 0);
    assert.equal(await store.ledger.posting('net_sess_n4_c0'), null);

    // Opted in and past the bound: the sweep finishes the epoch and frees the reservation.
    const finished = await sweepOrphanSessions(store, ctx, {
      now: 10_000,
      limit: 100,
      settleOlderThanMs: 5_000,
      reservations: registry,
    });
    assert.equal(finished.settled.length, 1);
    assert.equal((await store.ledger.balance(earned('usr_c4'))).minor, 30n);
    assert.equal(await store.reservations!.pending(spendable('usr_n4')), 0n);
  });

  test('reconcileReservations repairs a leaked counter to the journal-derived truth', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_n5', 100n);
    const registry = sharedReservations(store);
    const session = openInstanceSession(deps, 'sess_n5', {
      reservations: registry,
    });
    await session.record({
      idempotencyKey: 'n5_buy',
      legs: purchase('usr_n5', 'usr_c5', 25n),
    });
    await session.flush();
    // A crashed node's unflushed acceptance: pending the journal knows nothing about.
    await store.reservations!.add(spendable('usr_ghost'), -40n);
    await store.reservations!.add(spendable('usr_n5'), -5n);

    const { adjusted } = await reconcileReservations(store, makeWorkerCtx());
    assert.equal(adjusted, 2);
    assert.equal(await store.reservations!.pending(spendable('usr_ghost')), 0n);
    assert.equal(await store.reservations!.pending(spendable('usr_n5')), -25n);
  });
});

describe('Scope router', () => {
  test('assignments are deterministic, total, and stable under node removal', () => {
    const nodes = ['node-a', 'node-b', 'node-c'];
    const route = scopeRouter(nodes);
    const scopes = Array.from({ length: 200 }, (_, i) => `wrld_${i}`);

    const assigned = new Map(scopes.map((scope) => [scope, route(scope)]));
    // Every node carries some of the load (200 scopes over 3 nodes cannot miss one without a
    // badly broken hash).
    for (const node of nodes) {
      assert.ok([...assigned.values()].includes(node), `${node} got no scopes`);
    }
    const reordered = scopeRouter(['node-c', 'node-a', 'node-b']);
    for (const scope of scopes) {
      assert.equal(reordered(scope), assigned.get(scope));
    }
    // Removing one node reassigns only its scopes — the property that keeps live sessions
    // sticky through membership changes.
    const survivors = scopeRouter(['node-a', 'node-b']);
    for (const scope of scopes) {
      if (assigned.get(scope) !== 'node-c') {
        assert.equal(survivors(scope), assigned.get(scope));
      }
    }
  });

  test('refuses an empty or duplicated node list', () => {
    assert.throws(() => scopeRouter([]));
    assert.throws(() => scopeRouter(['node-a', 'node-a']));
  });
});
