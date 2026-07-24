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
 * The instance economy fast lane (src/instance.ts). The load-bearing invariants: ownership is
 * globally durable the moment a purchase is accepted and never survives a purchase whose money
 * failed; every accepted movement is ledger-final exactly once at settle; the lane keeps the
 * maturity gate and the cap it would otherwise bypass; and every path leaves the ledger provable.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openInstanceEconomies, openInstanceEconomy } from '#src/instance.ts';
import { createEconomy } from '#src/economy.ts';
import { createServer } from '#src/server.ts';
import { createReservations } from '#src/netting.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { proveChain } from '#src/chain.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { mergeConfig } from '#src/config.ts';
import { toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import {
  defaultPricing,
  fixedClock,
  makePorts,
  seededDigest,
  sequentialIds,
  silentMeter,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { InstanceEconomyDeps } from '#src/instance.ts';
import type { Config } from '#src/config.ts';
import type { Store } from '#src/ports.ts';

function harness(config: Config = testConfig()): {
  store: Store;
  deps: InstanceEconomyDeps;
} {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  return {
    store,
    deps: {
      store,
      digest,
      clock,
      ids: sequentialIds(),
      pricing: defaultPricing(),
      config,
      logger: testLogger(),
      meter: silentMeter(),
    },
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

const balanceOf = async (
  store: Store,
  account: Parameters<Store['ledger']['balance']>[0],
) => (await store.ledger.balance(account)).minor;

// 100.00 at the test fee of 30%: the creator's share is 70.00.
const buy = (buyerId: string, kind: 'permanent' | 'temporary' | 'instant') => ({
  buyerId,
  price: toAmount('CREDIT', 10_000n),
  recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
  product: {
    sku: 'sku_sword',
    kind,
    ...(kind === 'temporary' ? { expiresAt: 5_000 } : {}),
  },
});

describe('Instance economy', () => {
  test('instant purchases ride the journal and net at settle, provably', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b1', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess:w1:0');

    for (let i = 0; i < 10; i += 1) {
      const outcome = await lane.purchase(buy('usr_b1', 'instant'));
      assert.equal(outcome.status, 'accepted');
    }
    // Nothing has touched the ledger yet beyond the journal batches.
    assert.equal(await balanceOf(store, spendable('usr_b1')), 100_000n);

    const report = await lane.settle();
    assert.equal(report.mode, 'netted');
    assert.equal(report.netted, 10);
    assert.equal(await balanceOf(store, spendable('usr_b1')), 0n);
    assert.equal(await balanceOf(store, earned('usr_creator')), 70_000n);
    assert.equal(await balanceOf(store, SYSTEM.REVENUE), -70_000n);
    // No entitlement for a consumable.
    assert.equal(await store.entitlements.owns('usr_b1', 'sku_sword'), false);
    const chain = await proveChain({
      ledger: store.ledger,
      digest: deps.digest,
    });
    assert.equal(chain.intact, true);
  });

  test('a permanent purchase owns immediately — before any settle', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b2', 10_000n);
    const lane = openInstanceEconomy(deps, 'sess:w2:0');

    const outcome = await lane.purchase(buy('usr_b2', 'permanent'));
    assert.equal(outcome.status, 'accepted');
    // The global read every other instance, platform, and API does — true right now.
    assert.equal(await store.entitlements.owns('usr_b2', 'sku_sword'), true);

    await lane.settle();
    assert.equal(await store.entitlements.owns('usr_b2', 'sku_sword'), true);
    assert.equal(await balanceOf(store, earned('usr_creator')), 7_000n);
  });

  test('a temporary purchase carries its expiry on the grant', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b3', 10_000n);
    const lane = openInstanceEconomy(deps, 'sess:w3:0');

    await lane.purchase(buy('usr_b3', 'temporary'));
    assert.equal(await store.entitlements.owns('usr_b3', 'sku_sword'), true);
    for await (const grant of store.entitlements.list('usr_b3')) {
      assert.equal(grant.expiresAt, 5_000);
    }
  });

  test('a purchase the money rejects never keeps its grant', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b4', 5_000n); // half the price
    const lane = openInstanceEconomy(deps, 'sess:w4:0');

    const outcome = await lane.purchase(buy('usr_b4', 'permanent'));
    assert.equal(outcome.status, 'rejected');
    assert.equal((outcome as { reason: string }).reason, 'INSUFFICIENT_FUNDS');
    assert.equal(await store.entitlements.owns('usr_b4', 'sku_sword'), false);
  });

  test('the lane keeps the maturity gate: immature funds cannot be spent in-session', async () => {
    const config = mergeConfig(testConfig(), {
      maturityHorizonMs: { card: 1_000 },
    });
    const { store, deps } = harness(config);
    await fund(store, 'usr_b5', 100_000n); // topped up at t=0, matures at t=1000; clock is 0
    const lane = openInstanceEconomy(deps, 'sess:w5:0');

    const outcome = await lane.purchase(buy('usr_b5', 'permanent'));
    assert.equal(outcome.status, 'rejected');
    assert.equal(await store.entitlements.owns('usr_b5', 'sku_sword'), false);
  });

  test('the per-user cap bounds a buyer and rejects with RISK_DENIED', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b6', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess:w6:0', {
      perUserCapMinor: 15_000n,
    });

    assert.equal(
      (await lane.purchase(buy('usr_b6', 'instant'))).status,
      'accepted',
    );
    const second = await lane.purchase(buy('usr_b6', 'instant'));
    assert.equal(second.status, 'rejected');
    assert.equal((second as { reason: string }).reason, 'RISK_DENIED');
    assert.equal(lane.spentOf('usr_b6').minor, 10_000n);
  });

  test('orderIds are session-prefixed; a foreign one is refused; a repeat replays', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b7', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess:w7:0');

    await assert.rejects(
      () =>
        lane.purchase({ ...buy('usr_b7', 'instant'), orderId: 'ord_main_1' }),
      (error: unknown) => (error as { code?: string }).code === 'OP.MALFORMED',
    );

    const orderId = 'sess:sess:w7:0:custom_1';
    const first = await lane.purchase({ ...buy('usr_b7', 'instant'), orderId });
    const repeat = await lane.purchase({
      ...buy('usr_b7', 'instant'),
      orderId,
    });
    assert.deepEqual(repeat, first);
    // The replayed repeat charged nothing extra.
    assert.equal(lane.spentOf('usr_b7').minor, 10_000n);
  });

  test('the cross-lane backstop: funds drained after accept revoke at settle, exactly once', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b8', 10_000n);
    const lane = openInstanceEconomy(deps, 'sess:w8:0');

    const outcome = await lane.purchase(buy('usr_b8', 'permanent'));
    assert.equal(outcome.status, 'accepted');
    assert.equal(await store.entitlements.owns('usr_b8', 'sku_sword'), true);

    // Another lane (or node) drains the buyer before this session settles.
    await store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_drain_b8',
        legs: [
          debit(spendable('usr_b8'), toAmount('CREDIT', 10_000n)),
          credit(SYSTEM.REVENUE, toAmount('CREDIT', 10_000n)),
        ],
        meta: { kind: 'test_drain' },
      }),
    );

    const report = await lane.settle();
    assert.equal(report.mode, 'replayed');
    assert.equal(report.rejected.length, 1);
    assert.equal(report.revoked.length, 1);
    assert.equal(report.revoked[0]!.sku, 'sku_sword');
    assert.equal(await store.entitlements.owns('usr_b8', 'sku_sword'), false);
    assert.equal(await balanceOf(store, earned('usr_creator')), 0n);
    const chain = await proveChain({
      ledger: store.ledger,
      digest: deps.digest,
    });
    assert.equal(chain.intact, true);
  });

  test('concurrent purchases serialize: distinct seqs, one clean settle', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_c1', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess:c1:0');

    // The HTTP edge's shape: in-flight purchases racing on one lane. The writer queue must
    // keep the session chain linear — no forked seq, no lost movement.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => lane.purchase(buy('usr_c1', 'instant'))),
    );
    assert.equal(
      outcomes.every((o) => o.status === 'accepted'),
      true,
    );
    const seqs = outcomes
      .map((o) => (o as { seq: number }).seq)
      .sort((a, b) => a - b);
    assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5, 6, 7]);

    const report = await lane.settle();
    assert.equal(report.mode, 'netted');
    assert.equal(await balanceOf(store, spendable('usr_c1')), 20_000n);
    assert.equal(await balanceOf(store, earned('usr_creator')), 56_000n);
    const chain = await proveChain({
      ledger: store.ledger,
      digest: deps.digest,
    });
    assert.equal(chain.intact, true);
  });

  test('racing first purchases hold the immature slice once and release it fully', async () => {
    const config = mergeConfig(testConfig(), {
      maturityHorizonMs: { card: 1_000 },
    });
    const { store, deps } = harness(config);
    await fund(store, 'usr_c2', 100_000n); // all immature: funded at t=0, clock is 0
    const registry = createReservations();
    const lane = openInstanceEconomy(deps, 'sess:c2:0', {
      reservations: registry,
    });

    const [a, b] = await Promise.all([
      lane.purchase(buy('usr_c2', 'instant')),
      lane.purchase(buy('usr_c2', 'instant')),
    ]);
    assert.equal(a.status, 'rejected');
    assert.equal(b.status, 'rejected');

    await lane.settle();
    // Held once, released once — a doubled hold would leave residue in the shared registry and
    // starve the buyer across every later epoch.
    assert.equal(registry.pending(spendable('usr_c2')), 0n);
  });

  test("pending() shows this tier's in-flight spend and clears after settle", async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b9', 100_000n);
    const registry = createReservations();
    const lane = openInstanceEconomy(deps, 'sess:w9:0', {
      reservations: registry,
    });

    await lane.purchase(buy('usr_b9', 'instant'));
    await lane.purchase(buy('usr_b9', 'instant'));
    assert.equal((await lane.pending('usr_b9')).minor, 20_000n);

    await lane.settle();
    assert.equal((await lane.pending('usr_b9')).minor, 0n);
    // The shared registry is fully released too — nothing leaks into other sessions.
    assert.equal(registry.pending(spendable('usr_b9')), 0n);
  });

  test('a settled lane refuses further purchases; the next epoch takes them', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b10', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess:w10:0');
    await lane.purchase(buy('usr_b10', 'instant'));
    await lane.settle();

    await assert.rejects(
      () => lane.purchase(buy('usr_b10', 'instant')),
      (error: unknown) =>
        (error as { code?: string }).code === 'SESSION.SETTLED',
    );
    const next = openInstanceEconomy(deps, 'sess:w10:1');
    assert.equal(
      (await next.purchase(buy('usr_b10', 'instant'))).status,
      'accepted',
    );
  });

  test('settle enqueues one economy.instance.settled event', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_b11', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess:w11:0');
    await lane.purchase(buy('usr_b11', 'instant'));
    await lane.settle();

    const batch = await store.outbox.claimBatch(10);
    const settled = batch.filter(
      (message) => message.event.type === 'economy.instance.settled',
    );
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.event.subject, 'sess:w11:0');
    assert.equal(settled[0]!.event.data.netted, 1);
  });

  test('the manager routes scopes to lanes and rotates epochs seamlessly', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_m1', 100_000n);
    const manager = openInstanceEconomies(deps);

    const lane = manager.laneFor('wrld_a');
    assert.equal(manager.laneFor('wrld_a'), lane); // sticky until rotation
    assert.notEqual(manager.laneFor('wrld_b'), lane);

    await lane.purchase(buy('usr_m1', 'instant'));
    const report = await manager.rotate('wrld_a');
    assert.equal(report!.netted, 1);
    assert.equal(await balanceOf(store, earned('usr_creator')), 7_000n);

    const next = manager.laneFor('wrld_a');
    assert.notEqual(next, lane);
    assert.equal(
      (await next.purchase(buy('usr_m1', 'instant'))).status,
      'accepted',
    );
    await manager.settleAll();
    assert.equal(await balanceOf(store, earned('usr_creator')), 14_000n);
  });

  test('the manager shares one registry, so scopes cannot double-spend one buyer', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_m2', 10_000n); // exactly one purchase's worth
    const manager = openInstanceEconomies(deps);

    const first = await manager
      .laneFor('wrld_a')
      .purchase(buy('usr_m2', 'instant'));
    assert.equal(first.status, 'accepted');
    // The manager's own pending view spans every lane it runs.
    assert.equal((await manager.pending('usr_m2')).minor, 10_000n);
    const second = await manager
      .laneFor('wrld_b')
      .purchase(buy('usr_m2', 'instant'));
    assert.equal(second.status, 'rejected');
  });

  test('the sweep rotates epochs by movement count', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_m3', 100_000n);
    const manager = openInstanceEconomies(deps, { epochMaxMovements: 2 });

    await manager.laneFor('wrld_a').purchase(buy('usr_m3', 'instant'));
    assert.equal((await manager.sweep()).settled.length, 0); // one movement: not due
    await manager.laneFor('wrld_a').purchase(buy('usr_m3', 'instant'));
    const { settled, failed } = await manager.sweep();
    assert.equal(failed.length, 0);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.scope, 'wrld_a');
    assert.equal(settled[0]!.report.netted, 2);
    assert.equal(await balanceOf(store, earned('usr_creator')), 14_000n);
  });

  test('the manager accepts a whole Ports bag as its deps', async () => {
    const { store } = harness();
    // The structural promise a host relies on: openPorts' bag drops straight in.
    const ports = makePorts(store);
    await fund(store, 'usr_m4', 100_000n);
    const manager = openInstanceEconomies(ports);
    const outcome = await manager
      .laneFor('wrld_a')
      .purchase(buy('usr_m4', 'instant'));
    assert.equal(outcome.status, 'accepted');
    await manager.settleAll();
    assert.equal(await balanceOf(store, earned('usr_creator')), 7_000n);
  });

  test('start() drives the sweep through the injected Scheduler', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_m5', 100_000n);
    let tick: (() => Promise<void>) | null = null;
    const manager = openInstanceEconomies(
      {
        ...deps,
        scheduler: {
          every: (_ms, task) => {
            tick = task;
            return () => {
              tick = null;
            };
          },
        },
      },
      { epochMaxMovements: 1 },
    );
    const stop = manager.start(5_000);
    await manager.laneFor('wrld_a').purchase(buy('usr_m5', 'instant'));
    await tick!(); // the scheduler fires: the over-size epoch settles
    assert.equal(await balanceOf(store, earned('usr_creator')), 7_000n);
    stop();
    assert.equal(tick, null);
  });

  test('a failed settle keeps its lane for the next sweep instead of stranding the epoch', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_m6', 100_000n);
    const manager = openInstanceEconomies(deps, { epochMaxMovements: 1 });
    await manager.laneFor('wrld_a').purchase(buy('usr_m6', 'instant'));

    // The store dies under the settle; the sweep records the failure and retains the lane.
    const journal = store.movements.bySession.bind(store.movements);
    store.movements.bySession = () => {
      throw new Error('store down');
    };
    const first = await manager.sweep();
    assert.equal(first.settled.length, 0);
    assert.equal(first.failed.length, 1);
    assert.equal(manager.stats().scopes, 1);

    // The store recovers; the next sweep settles the same epoch — no money stranded.
    store.movements.bySession = journal;
    const second = await manager.sweep();
    assert.equal(second.settled.length, 1);
    assert.equal(await balanceOf(store, earned('usr_creator')), 7_000n);
  });

  test('a retried settle keeps the replay report, revokes, and emits once', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_m7', 10_000n);
    const manager = openInstanceEconomies(deps, { epochMaxMovements: 1 });
    await manager.laneFor('wrld_a').purchase(buy('usr_m7', 'permanent'));
    // Drain the buyer out-of-band, so the settle must replay, reject, and revoke.
    await store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_drain_m7',
        legs: [
          debit(spendable('usr_m7'), toAmount('CREDIT', 10_000n)),
          credit(SYSTEM.REVENUE, toAmount('CREDIT', 10_000n)),
        ],
        meta: { kind: 'test_drain' },
      }),
    );

    // The revoke dies once mid-settle; the sweep records the failure and retains the lane.
    const revoke = store.entitlements.revoke.bind(store.entitlements);
    store.entitlements.revoke = () => {
      store.entitlements.revoke = revoke;
      throw new Error('store down');
    };
    const first = await manager.sweep();
    assert.equal(first.failed.length, 1);

    // The retry must not re-ask the session (a second settle would mis-read the compensated
    // chunks as settled and erase the rejections); it redoes only the wrapper's side effects.
    const second = await manager.sweep();
    assert.equal(second.settled.length, 1);
    const report = second.settled[0]!.report;
    assert.equal(report.mode, 'replayed');
    assert.equal(report.rejected.length, 1);
    assert.equal(report.revoked.length, 1);
    assert.equal(await store.entitlements.owns('usr_m7', 'sku_sword'), false);
    const settled = (await store.outbox.claimBatch(10)).filter(
      (message) => message.event.type === 'economy.instance.settled',
    );
    assert.equal(settled.length, 1);
  });

  test("the game-server edge routes purchases into the scope's lane over HTTP", async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const ports = makePorts(store);
    const manager = openInstanceEconomies(ports);
    const handler = createServer({
      economy: createEconomy(ports),
      ports,
      authenticate: false,
      instances: manager,
    });
    await fund(store, 'usr_h1', 100_000n);

    const respond = (body: Record<string, unknown>) =>
      handler(
        new Request('https://economy.test/instances/wrld_a/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    const accepted = await respond({
      buyerId: 'usr_h1',
      price: 'CREDIT:100.00',
      recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
      product: { sku: 'sku_sword', kind: 'permanent' },
    });
    assert.equal(accepted.status, 200);
    const outcome = (await accepted.json()) as { status: string };
    assert.equal(outcome.status, 'accepted');
    assert.equal(await store.entitlements.owns('usr_h1', 'sku_sword'), true);

    // A business "no" is a 200 rejected outcome, exactly like /submit.
    const broke = await respond({
      buyerId: 'usr_broke_h',
      price: 'CREDIT:100.00',
      recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
      product: { sku: 'sku_sword', kind: 'instant' },
    });
    assert.equal(broke.status, 200);
    assert.equal(
      ((await broke.json()) as { status: string }).status,
      'rejected',
    );

    await manager.settleAll();
    assert.equal(await balanceOf(store, earned('usr_creator')), 7_000n);
  });

  test('the edge binds a user principal to their own wallet', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const ports = makePorts(store);
    const handler = createServer({
      economy: createEconomy(ports),
      ports,
      authenticate: async () => ({ kind: 'user', userId: 'usr_other' }),
      instances: openInstanceEconomies(ports),
    });
    const response = await handler(
      new Request('https://economy.test/instances/wrld_a/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          buyerId: 'usr_victim',
          price: 'CREDIT:100.00',
          recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
          product: { sku: 'sku_sword', kind: 'instant' },
        }),
      }),
    );
    assert.equal(response.status, 401);
  });

  test('the edge faults a missing or empty recipient sellerId as malformed', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const ports = makePorts(store);
    const handler = createServer({
      economy: createEconomy(ports),
      ports,
      authenticate: false,
      instances: openInstanceEconomies(ports),
    });
    const respond = (recipients: unknown) =>
      handler(
        new Request('https://economy.test/instances/wrld_a/purchase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            buyerId: 'usr_h2',
            price: 'CREDIT:100.00',
            recipients,
            product: { sku: 'sku_sword', kind: 'instant' },
          }),
        }),
      );
    for (const recipients of [
      [{ shareBps: 10_000 }],
      [{ sellerId: '  ', shareBps: 10_000 }],
    ]) {
      const response = await respond(recipients);
      assert.equal(response.status, 400);
      const payload = (await response.json()) as { code: string };
      assert.equal(payload.code, 'OP.MALFORMED');
    }
  });

  test('the edge 404s when no lane manager is configured', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const ports = makePorts(store);
    const handler = createServer({
      economy: createEconomy(ports),
      ports,
      authenticate: false,
    });
    const response = await handler(
      new Request('https://economy.test/instances/wrld_a/purchase', {
        method: 'POST',
        body: '{}',
      }),
    );
    assert.equal(response.status, 404);
  });

  test('share and shape violations fault instead of rejecting', async () => {
    const { deps } = harness();
    const lane = openInstanceEconomy(deps, 'sess:w12:0');
    await assert.rejects(() =>
      lane.purchase({
        ...buy('usr_b12', 'instant'),
        recipients: [{ sellerId: 'usr_creator', shareBps: 5_000 }],
      }),
    );
    await assert.rejects(() =>
      lane.purchase({
        ...buy('usr_b12', 'permanent'),
        recipients: [{ sellerId: 'usr_b12', shareBps: 10_000 }],
      }),
    );
    await assert.rejects(() =>
      lane.purchase({
        ...buy('usr_b12', 'permanent'),
        product: { sku: 'sku_sword', kind: 'permanent', expiresAt: 5 },
      }),
    );
    // An unknown kind (the wire can hand any string) must fault, not grant as if permanent.
    await assert.rejects(
      () =>
        lane.purchase({
          ...buy('usr_b12', 'permanent'),
          product: {
            sku: 'sku_sword',
            kind: 'gift' as 'permanent',
          },
        }),
      (error: unknown) => (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });
});
