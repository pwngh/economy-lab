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

import { fakeInbound, samplePurchase } from '@pwngh/economy-edge/testing';
import {
  edgePurchaseTopUp,
  purchaseTopUpKey,
} from '#src/adapters/edge-inbound.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable } from '#src/accounts.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { credit } from '#test/support/builders.ts';

describe('edge-inbound (verify → topUp)', () => {
  test('maps a verified purchase onto a namespaced, provenance-carrying topUp', () => {
    const purchase = samplePurchase({
      provider: 'steam',
      providerTxnId: 'txn-42',
      providerSku: 'sku-credits-1200',
    });

    const operation = edgePurchaseTopUp(purchase, {
      userId: 'usr_buyer',
      amount: credit('12.00'),
    }) as unknown as Record<string, unknown>;

    assert.equal(operation.kind, 'topUp');
    assert.equal(operation.idempotencyKey, purchaseTopUpKey('steam', 'txn-42'));
    assert.equal(operation.idempotencyKey, 'iap:steam:txn-42');
    assert.deepEqual(operation.actor, {
      kind: 'system',
      service: 'edge:steam',
    });
    assert.equal(operation.userId, 'usr_buyer');
    assert.equal(operation.source, 'steam');
    assert.deepEqual(operation.meta, {
      provider: 'steam',
      providerTxnId: 'txn-42',
      sku: 'sku-credits-1200',
      sourceRef: purchase.sourceRef,
    });
  });

  test('an edge-verified purchase credits the buyer exactly once across redeliveries', async () => {
    const store = memoryStore();
    const economy = makeEconomy(1, store);
    const verified = await fakeInbound().verify({
      provider: 'steam',
      proof: { orderId: '1' },
    });
    assert.equal(verified.ok, true);
    const purchase = verified.ok ? verified.value : samplePurchase();
    const operation = edgePurchaseTopUp(purchase, {
      userId: 'usr_buyer',
      amount: credit('12.00'),
    });

    const first = await economy.submit(operation);
    const second = await economy.submit(operation);

    assert.equal(first.status, 'committed');
    assert.equal(second.status, 'duplicate');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('12.00'),
    );
  });
});
