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
 * The entitlement bitset read model (src/adapters/entitlement-bitset.ts), proven two ways. First,
 * the whole Store conformance suite runs against a decorated memory store: decoration must be
 * observationally invisible, entitlement semantics included. Second, the behaviors the decorator
 * adds are pinned directly — read-time deadline expiry, TTL-bounded cross-process staleness,
 * invalidation when a transaction ends (commit AND rollback), LRU eviction, and the
 * zero-allocation warm path.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { runStoreConformance } from '#test/conformance/store.ts';
import { cachedEntitlements } from '#src/adapters/entitlement-bitset.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { fixedClock } from '#test/support/capabilities.ts';

// The full conformance suite against the decorated store. The same fixed clock is shared with the
// backing store, so expiry decisions in the bitmap and in the store agree.
runStoreConformance('memory+bitset', () => {
  const clock = fixedClock(0);
  return cachedEntitlements(memoryStore({ clock }), { clock });
});

// Builds a decorated store over an advancing fake clock, returning both handles: writes through
// `base` simulate another process (no invalidation event reaches the decorator).
function build(opts?: { ttlMs?: number; maxUsers?: number }) {
  const clock = fixedClock(0);
  const base = memoryStore({ clock });
  const store = cachedEntitlements(base, { clock, ...opts });
  return { clock, base, store };
}

describe('Entitlement bitset read model', () => {
  test('serves a warm hit from the bitmap and matches the store', async () => {
    const { store, clock } = build();
    await store.transaction((unit) =>
      unit.entitlements.grant('usr_bs_1', 'wrld_pass', {}),
    );

    assert.equal(await store.entitlements.owns('usr_bs_1', 'wrld_pass'), true);
    // Second read is the warm path: the synchronous probe answers without the store.
    assert.equal(
      store.__bitset.check('usr_bs_1', 'wrld_pass', clock.now()),
      true,
    );
    assert.equal(
      store.__bitset.check('usr_bs_1', 'other_sku', clock.now()),
      false,
    );
    assert.equal(await store.entitlements.owns('usr_bs_1', 'other_sku'), false);
  });

  test('a time-limited grant self-expires in the bitmap, boundary inclusive', async () => {
    const { store, clock } = build();
    await store.transaction((unit) =>
      unit.entitlements.grant('usr_bs_2', 'sub_month', { expiresAt: 1_000 }),
    );
    assert.equal(await store.entitlements.owns('usr_bs_2', 'sub_month'), true);

    // Exactly at the deadline: still owned (inclusive), straight from the warm bitmap.
    clock.advance(1_000);
    assert.equal(
      store.__bitset.check('usr_bs_2', 'sub_month', clock.now()),
      true,
    );
    assert.equal(await store.entitlements.owns('usr_bs_2', 'sub_month'), true);

    // One ms past: lapsed, with no write and no invalidation event ever occurring.
    clock.advance(1);
    assert.equal(
      store.__bitset.check('usr_bs_2', 'sub_month', clock.now()),
      false,
    );
    assert.equal(await store.entitlements.owns('usr_bs_2', 'sub_month'), false);
  });

  test('a cross-process revoke is stale for at most the TTL, then self-heals', async () => {
    const { store, base, clock } = build({ ttlMs: 5_000 });
    await store.transaction((unit) =>
      unit.entitlements.grant('usr_bs_3', 'avatar_x', {}),
    );
    assert.equal(await store.entitlements.owns('usr_bs_3', 'avatar_x'), true);

    // Another process revokes: the decorator sees no event, so the bitmap reads stale-positive.
    await base.entitlements.revoke('usr_bs_3', 'avatar_x');
    assert.equal(await store.entitlements.owns('usr_bs_3', 'avatar_x'), true);

    // Past the TTL the bitmap refills from the store and heals.
    clock.advance(5_001);
    assert.equal(await store.entitlements.owns('usr_bs_3', 'avatar_x'), false);
  });

  test('a rolled-back grant leaves no stale bit, even when read mid-transaction', async () => {
    const { store } = build();
    await assert.rejects(
      store.transaction(async (unit) => {
        await unit.entitlements.grant('usr_bs_4', 'hat_y', {});
        // Mid-transaction read: the memory adapter makes the uncommitted grant visible, so this
        // poisons the bitmap with owned=true — the invalidation when the transaction ends is
        // what un-poisons it.
        assert.equal(await store.entitlements.owns('usr_bs_4', 'hat_y'), true);
        throw new Error('abort');
      }),
    );

    assert.equal(await store.entitlements.owns('usr_bs_4', 'hat_y'), false);
  });

  test('a committed write wins over a bitmap refilled mid-transaction', async () => {
    const { store } = build();
    await store.transaction((unit) =>
      unit.entitlements.grant('usr_bs_5', 'cape_z', {}),
    );
    await store.transaction(async (unit) => {
      await unit.entitlements.revoke('usr_bs_5', 'cape_z');
      // Poison the bitmap during the transaction; end-of-transaction invalidation must clear it.
      await store.entitlements.owns('usr_bs_5', 'cape_z');
    });

    assert.equal(await store.entitlements.owns('usr_bs_5', 'cape_z'), false);
  });

  test('evicts the least recently used bitmap past the resident cap', async () => {
    const { store } = build({ maxUsers: 2 });
    for (const user of ['usr_bs_a', 'usr_bs_b', 'usr_bs_c']) {
      await store.transaction((unit) =>
        unit.entitlements.grant(user, 'item', {}),
      );
      await store.entitlements.owns(user, 'item');
    }

    assert.equal(store.__bitset.residentUsers(), 2);
    // The evicted user still answers correctly — one cold read rebuilds them.
    assert.equal(await store.entitlements.owns('usr_bs_a', 'item'), true);
  });

  test('the warm path allocates nothing', async (t) => {
    if (typeof global.gc !== 'function') {
      t.skip('needs --expose-gc; run: node --expose-gc --test this file');
      return;
    }
    const { store, clock } = build();
    await store.transaction((unit) =>
      unit.entitlements.grant('usr_bs_hot', 'hot_sku', {}),
    );
    await store.entitlements.owns('usr_bs_hot', 'hot_sku'); // warm the bitmap
    const now = clock.now();
    const check = store.__bitset.check;

    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100_000; i++) {
      if (check('usr_bs_hot', 'hot_sku', now) !== true) {
        throw new Error('unreachable');
      }
    }
    const grown = process.memoryUsage().heapUsed - before;

    // 100k warm checks must not allocate per call; allow slack for runtime noise.
    assert.ok(grown < 262_144, `heap grew ${grown} bytes over 100k checks`);
  });
});
