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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  cancelSubscription,
  principal,
  credit,
} from '#test/support/builders.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Economy } from '#src/economy.ts';
import type { Store, Subscription } from '#src/ports.ts';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && (error as { code?: string }).code === code;
}

// The economy and the store share one seeded digest and fixed clock so their hashes agree.
function makeEconomyWithStore(): { eco: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { eco: makeEconomy(1, store), store };
}

function activeSubscription(id: string, userId: string): Subscription {
  return {
    id,
    userId,
    sellerId: 'usr_seller',
    sku: 'wrld_membership',
    price: credit('100.00'),
    periodMs: 30 * 24 * 60 * 60_000,
    state: 'ACTIVE',
    period: 1,
    attempts: 0,
    nextDueAt: 30 * 24 * 60 * 60_000,
    updatedAt: 0,
  };
}

// Ownership is enforced in the handler, not central authorize(): cancel debits no account the
// ownership rule could check. These tests drive the full submit pipeline to prove that guard.
describe('cancelSubscription ownership (via submit)', () => {
  test("a user cannot cancel another user's subscription (IDOR) and it stays ACTIVE", async () => {
    const { eco, store } = makeEconomyWithStore();
    await store.subscriptions.open(
      activeSubscription('sub_alice', 'usr_alice'),
    );

    await assert.rejects(
      eco.submit(
        cancelSubscription({
          subscriptionId: 'sub_alice',
          actor: principal('usr_mallory'),
        }),
      ),
      hasCode('AUTH.UNAUTHORIZED'),
    );

    const after = await store.subscriptions.load('sub_alice');
    assert.equal(after?.state, 'ACTIVE');
  });

  test('the owner can cancel their own subscription', async () => {
    const { eco, store } = makeEconomyWithStore();
    await store.subscriptions.open(
      activeSubscription('sub_alice', 'usr_alice'),
    );

    const outcome = await eco.submit(
      cancelSubscription({
        subscriptionId: 'sub_alice',
        actor: principal('usr_alice'),
      }),
    );

    assert.equal(outcome.status, 'committed');
    const after = await store.subscriptions.load('sub_alice');
    assert.equal(after?.state, 'CANCELED');
  });

  test('an operator can cancel any subscription', async () => {
    const { eco, store } = makeEconomyWithStore();
    await store.subscriptions.open(
      activeSubscription('sub_alice', 'usr_alice'),
    );

    const outcome = await eco.submit(
      cancelSubscription({
        subscriptionId: 'sub_alice',
        actor: { kind: 'operator', operatorId: 'op_support' },
      }),
    );

    assert.equal(outcome.status, 'committed');
    const after = await store.subscriptions.load('sub_alice');
    assert.equal(after?.state, 'CANCELED');
  });
});
