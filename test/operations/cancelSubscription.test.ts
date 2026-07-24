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

import { cancelSubscription } from '#src/operations/cancelSubscription.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  cancelSubscription as cancelSubscriptionOp,
  credit,
} from '#test/support/builders.ts';
import { makeCtx, hasCode as isCode } from '#test/support/capabilities.ts';

import type { Ctx, Outcome } from '#src/contract.ts';
import type { Store, Subscription, SubscriptionState } from '#src/ports.ts';

// Tests call the handler directly rather than through the pipeline, so the Ctx is assembled by hand.
function makeContext(): { store: Store; ctx: Ctx } {
  const store = memoryStore();
  const ctx = makeCtx();
  return { store, ctx };
}

function activeSubscription(
  id: string,
  state: SubscriptionState = 'ACTIVE',
): Subscription {
  return {
    id,
    userId: 'usr_subscriber',
    sellerId: 'usr_seller',
    sku: 'wrld_membership',
    price: credit('100.00'),
    periodMs: 30 * 24 * 60 * 60_000,
    state,
    period: 1,
    attempts: 0,
    nextDueAt: 30 * 24 * 60 * 60_000,
    updatedAt: 0,
  };
}

async function cancel(
  store: Store,
  ctx: Ctx,
  subscriptionId: string,
): Promise<{ outcome: Outcome; after: Subscription | null }> {
  const outcome = await store.transaction((unit) =>
    cancelSubscription(cancelSubscriptionOp({ subscriptionId }), unit, ctx),
  );
  const after = await store.subscriptions.load(subscriptionId);
  return { outcome, after };
}

describe('cancelSubscription', () => {
  test('cancels an active subscription', async () => {
    const { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_active'));

    const { outcome, after } = await cancel(store, ctx, 'sub_active');

    assert.equal(outcome.status, 'committed');
    assert.equal(after?.state, 'CANCELED');
  });

  test('writes no ledger entries — cancellation only changes state', async () => {
    const { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_marker'));

    const { outcome } = await cancel(store, ctx, 'sub_marker');

    assert.equal(outcome.status, 'committed');
    assert.equal(
      outcome.status === 'committed' && outcome.transaction.legs.length,
      0,
    );
    assert.equal(
      outcome.status === 'committed' && outcome.transaction.links.length,
      0,
    );
  });

  test('cancels a lapsed subscription, transitioning it to canceled', async () => {
    const { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_lapsed', 'LAPSED'));

    const { outcome, after } = await cancel(store, ctx, 'sub_lapsed');

    assert.equal(outcome.status, 'committed');
    assert.equal(after?.state, 'CANCELED');
  });

  test('rejects an unknown subscription as UNKNOWN_SUBSCRIPTION', async () => {
    const { store, ctx } = makeContext();

    const { outcome } = await cancel(store, ctx, 'sub_absent');

    assert.equal(outcome.status, 'rejected');
    assert.deepEqual(
      outcome.status === 'rejected' ? outcome.detail : undefined,
      { reason: 'UNKNOWN_SUBSCRIPTION', subscriptionId: 'sub_absent' },
    );
  });

  test('throws MALFORMED for a blank subscriptionId instead of degrading to UNKNOWN_SUBSCRIPTION', async () => {
    const { store, ctx } = makeContext();

    await assert.rejects(
      store.transaction((unit) =>
        cancelSubscription(
          cancelSubscriptionOp({ subscriptionId: '   ' }),
          unit,
          ctx,
        ),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('rejects an already-canceled subscription as UNKNOWN_SUBSCRIPTION', async () => {
    const { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_done', 'CANCELED'));

    const { outcome } = await cancel(store, ctx, 'sub_done');

    assert.equal(outcome.status, 'rejected');
    assert.deepEqual(
      outcome.status === 'rejected' ? outcome.detail : undefined,
      { reason: 'UNKNOWN_SUBSCRIPTION', subscriptionId: 'sub_done' },
    );
  });
});
