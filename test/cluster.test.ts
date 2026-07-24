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
 * The composed cluster node: construction laws (membership, the epoch-age bound, the counter
 * requirement), ownership gating, the shared accept screen across nodes, crash recovery, and
 * orphan settling through one handle.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openClusterNode } from '#src/cluster.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  hasCode,
  seededDigest,
  sequentialIds,
} from '#test/support/capabilities.ts';

import type { ClusterNode, ClusterNodeDeps } from '#src/cluster.ts';
import type { EconomyError } from '#src/errors.ts';
import type { Leg, Store } from '#src/ports.ts';

const NODES = ['node-a', 'node-b'];

function harness(): { store: Store; deps: ClusterNodeDeps } {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  return { store, deps: { store, digest, clock, ids: sequentialIds() } };
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

// The first candidate scope the node owns, so tests use real assignments instead of
// hand-disjoint names.
function scopeOwnedBy(node: ClusterNode, tag: string): string {
  for (let k = 0; k < 64; k += 1) {
    const scope = `${tag}_${k}`;
    if (node.owns(scope)) {
      return scope;
    }
  }
  throw new Error(`no ${tag} scope owned by ${node.nodeId} in 64 candidates`);
}

describe('Cluster node', () => {
  test('construction refuses bad membership, a low sweep bound, and a counterless store', () => {
    const { deps } = harness();
    assert.throws(
      () => openClusterNode(deps, { nodeId: 'node-x', nodes: NODES }),
      hasCode('CONFIG.INVALID'),
    );
    // Below twice the (default 60s) epoch age the sweep could settle a live epoch.
    assert.throws(
      () =>
        openClusterNode(deps, {
          nodeId: 'node-a',
          nodes: NODES,
          sweep: { settleOlderThanMs: 119_999 },
        }),
      hasCode('CONFIG.INVALID'),
    );
    openClusterNode(deps, {
      nodeId: 'node-a',
      nodes: NODES,
      sweep: { settleOlderThanMs: 120_000 },
    });
    const { reservations: counter, ...bare } = deps.store;
    assert.notEqual(counter, undefined);
    assert.throws(
      () =>
        openClusterNode(
          { ...deps, store: bare },
          { nodeId: 'node-a', nodes: NODES },
        ),
      hasCode('CONFIG.INVALID'),
    );
  });

  test('ownership gates the node and the misroute names the owner', () => {
    const { deps } = harness();
    const a = openClusterNode(deps, { nodeId: 'node-a', nodes: NODES });
    const b = openClusterNode(deps, { nodeId: 'node-b', nodes: NODES });
    const scope = scopeOwnedBy(a, 'wrld_own');
    assert.equal(a.owns(scope), true);
    assert.equal(b.owns(scope), false);
    assert.equal(a.ownerOf(scope), 'node-a');
    assert.equal(b.ownerOf(scope), 'node-a');
    a.assertOwns(scope);
    assert.throws(
      () => b.openSession(scope),
      (error: unknown) => {
        assert.equal((error as EconomyError).code, 'SESSION.MISROUTED');
        assert.equal((error as EconomyError).detail.owner, 'node-a');
        return true;
      },
    );
  });

  test('two nodes over one store cannot double-spend one balance', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_cl1', 100n);
    const a = openClusterNode(deps, { nodeId: 'node-a', nodes: NODES });
    const b = openClusterNode(deps, { nodeId: 'node-b', nodes: NODES });
    const first = await a.openSession(scopeOwnedBy(a, 'wrld_ds')).record({
      idempotencyKey: 'cl1_a',
      legs: purchase('usr_cl1', 'usr_c1', 80n),
    });
    assert.equal(first.status, 'accepted');
    const second = await b.openSession(scopeOwnedBy(b, 'wrld_ds')).record({
      idempotencyKey: 'cl1_b',
      legs: purchase('usr_cl1', 'usr_c1', 80n),
    });
    assert.deepEqual(second, {
      status: 'rejected',
      reason: 'INSUFFICIENT_FUNDS',
    });
  });

  test('reopening a scope mints the next epoch, never the settled session id', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_cl2', 100n);
    const node = openClusterNode(deps, { nodeId: 'node-a', nodes: NODES });
    const scope = scopeOwnedBy(node, 'wrld_epoch');
    const first = node.openSession(scope);
    await first.record({
      idempotencyKey: 'cl2_a',
      legs: purchase('usr_cl2', 'usr_c2', 10n),
    });
    await first.settle();
    // A reused session id would refuse this with SESSION.SETTLED; acceptance proves rotation.
    const second = node.openSession(scope);
    const outcome = await second.record({
      idempotencyKey: 'cl2_b',
      legs: purchase('usr_cl2', 'usr_c2', 10n),
    });
    assert.equal(outcome.status, 'accepted');
    await second.settle();
    assert.equal((await store.ledger.balance(earned('usr_c2'))).minor, 20n);
  });

  test('a crashed epoch is reported by any node and settled only under the opt-in', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_cl3', 100n);
    const a = openClusterNode(deps, { nodeId: 'node-a', nodes: NODES });
    const session = a.openSession(scopeOwnedBy(a, 'wrld_crash'));
    await session.record({
      idempotencyKey: 'cl3_buy',
      legs: purchase('usr_cl3', 'usr_c3', 30n),
    });
    await session.flush();
    // node-a dies here; its reservation stays held on the shared counter.
    assert.equal(await store.reservations!.pending(spendable('usr_cl3')), -30n);

    const watcher = openClusterNode(deps, { nodeId: 'node-b', nodes: NODES });
    const report = await watcher.sweepOrphans({ now: 200_000 });
    assert.equal(report.orphans.length, 1);
    assert.equal(report.settled.length, 0);

    const settler = openClusterNode(deps, {
      nodeId: 'node-b',
      nodes: NODES,
      sweep: { settleOlderThanMs: 120_000 },
    });
    const finished = await settler.sweepOrphans({ now: 200_000 });
    assert.equal(finished.settled.length, 1);
    assert.equal((await store.ledger.balance(earned('usr_c3'))).minor, 30n);
    assert.equal(await store.reservations!.pending(spendable('usr_cl3')), 0n);
  });

  test('recover finishes a crashed epoch without double-counting the shared counter', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_cl4', 100n);
    const a = openClusterNode(deps, { nodeId: 'node-a', nodes: NODES });
    const session = a.openSession(scopeOwnedBy(a, 'wrld_rec'));
    await session.record({
      idempotencyKey: 'cl4_buy',
      legs: purchase('usr_cl4', 'usr_c4', 40n),
    });
    await session.flush();

    const b = openClusterNode(deps, { nodeId: 'node-b', nodes: NODES });
    const seen = await b.sweepOrphans({ now: 200_000 });
    const orphan = seen.orphans[0]!.sessionId;
    const recovered = await b.recover(orphan);
    assert.equal(recovered.wasSettled(), false);
    // The counter still holds exactly the crashed acceptance: recovery re-applied nothing.
    assert.equal(await store.reservations!.pending(spendable('usr_cl4')), -40n);
    await recovered.settle();
    assert.equal((await store.ledger.balance(earned('usr_c4'))).minor, 40n);
    assert.equal(await store.reservations!.pending(spendable('usr_cl4')), 0n);
  });

  test('laneOptions hands the manager this node registry and bound', () => {
    const { deps } = harness();
    const node = openClusterNode(deps, {
      nodeId: 'node-a',
      nodes: NODES,
      epochMaxAgeMs: 30_000,
      sweep: { settleOlderThanMs: 60_000 },
    });
    const lane = node.laneOptions();
    assert.equal(lane.reservations, node.reservations);
    assert.equal(lane.epochMaxAgeMs, 30_000);
  });
});
