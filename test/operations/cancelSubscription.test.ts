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

import { handleCancelSubscription } from '#src/operations/cancelSubscription.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { cancelSubscription, credit } from '#test/support/builders.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';

import type { Ctx, Outcome } from '#src/contract.ts';
import type { Store, Subscription, SubscriptionState } from '#src/ports.ts';

// Fresh in-memory store plus a deterministic Ctx (clock, ids, pricing, etc). Tests call the
// handler directly, not through a request router.
function makeContext(): { store: Store; ctx: Ctx } {
  let store = memoryStore();
  let ctx: Ctx = {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
  return { store, ctx };
}

// Subscription record in the given state, saved via store.open before the handler runs.
function activeSubscription(
  id: string,
  state: SubscriptionState = 'ACTIVE',
): Subscription {
  return {
    id,
    userId: 'usr_subscriber',
    sellerId: 'usr_seller',
    sku: 'wrld_membership',
    price: credit('5.00'),
    periodMs: 30 * 24 * 60 * 60_000,
    state,
    period: 1,
    attempts: 0,
    nextDueAt: 30 * 24 * 60 * 60_000,
    updatedAt: 0,
  };
}

// Runs the cancel handler in one transaction, then reloads the subscription. Returns the outcome
// (committed/rejected) and the record afterward so a test can check both.
async function cancel(
  store: Store,
  ctx: Ctx,
  subscriptionId: string,
): Promise<{ outcome: Outcome; after: Subscription | null }> {
  let outcome = await store.transaction((unit) =>
    handleCancelSubscription(cancelSubscription({ subscriptionId }), unit, ctx),
  );
  let after = await store.subscriptions.load(subscriptionId);
  return { outcome, after };
}

// True when the thrown value is an Error carrying the given fault `code`.
function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

describe('cancelSubscription', () => {
  test('cancels an active subscription', async () => {
    let { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_active'));

    let { outcome, after } = await cancel(store, ctx, 'sub_active');

    assert.equal(outcome.status, 'committed');
    assert.equal(after?.state, 'CANCELED');
  });

  test('writes no ledger entries — cancellation only changes state', async () => {
    let { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_marker'));

    let { outcome } = await cancel(store, ctx, 'sub_marker');

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
    let { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_lapsed', 'LAPSED'));

    let { outcome, after } = await cancel(store, ctx, 'sub_lapsed');

    assert.equal(outcome.status, 'committed');
    assert.equal(after?.state, 'CANCELED');
  });

  test('rejects an unknown subscription as UNKNOWN_SUBSCRIPTION', async () => {
    let { store, ctx } = makeContext();

    let { outcome } = await cancel(store, ctx, 'sub_absent');

    assert.equal(outcome.status, 'rejected');
    assert.equal(
      outcome.status === 'rejected' && outcome.reason,
      'UNKNOWN_SUBSCRIPTION',
    );
  });

  test('throws MALFORMED for a blank subscriptionId instead of degrading to UNKNOWN_SUBSCRIPTION', async () => {
    let { store, ctx } = makeContext();

    await assert.rejects(
      store.transaction((unit) =>
        handleCancelSubscription(
          cancelSubscription({ subscriptionId: '   ' }),
          unit,
          ctx,
        ),
      ),
      isCode('OP.MALFORMED'),
    );
  });

  test('rejects an already-canceled subscription as UNKNOWN_SUBSCRIPTION', async () => {
    let { store, ctx } = makeContext();
    await store.subscriptions.open(activeSubscription('sub_done', 'CANCELED'));

    let { outcome } = await cancel(store, ctx, 'sub_done');

    assert.equal(outcome.status, 'rejected');
    assert.equal(
      outcome.status === 'rejected' && outcome.reason,
      'UNKNOWN_SUBSCRIPTION',
    );
  });
});
