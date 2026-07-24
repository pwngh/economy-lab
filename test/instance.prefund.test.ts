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
 * Prefund mode (src/instance.ts): the per-(user, session) escrow that makes the fast lane's
 * accept screen session-local. Funding is a real matured-only posting, movements debit the
 * escrow, settle refunds the remainder, and the orphan sweep repairs a refund a crashed lane
 * never posted — the account key is the attribution, never session memory.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openInstanceEconomy } from '#src/instance.ts';
import { sweepOrphanSessions } from '#src/worker/orphans.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { earned, sessionEscrow, spendable, SYSTEM } from '#src/accounts.ts';
import {
  defaultPricing,
  fixedClock,
  makeWorkerCtx,
  seededDigest,
  sequentialIds,
  testConfig,
} from '#test/support/capabilities.ts';

import type { Store } from '#src/ports.ts';

function harness() {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  const deps = {
    store,
    digest,
    clock,
    ids: sequentialIds(),
    pricing: defaultPricing(),
    config: testConfig(),
  };
  return { store, deps };
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

const buy = (buyerId: string, priceMinor: bigint) => ({
  buyerId,
  price: toAmount('CREDIT', priceMinor),
  recipients: [{ sellerId: 'usr_pf_seller', shareBps: 10_000 }],
  product: { sku: 'sku_pf', kind: 'instant' as const },
});

describe('Prefund mode', () => {
  test('funds the escrow once, spends from it, and refunds the remainder at settle', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_pf1', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess_pf_1', {
      prefund: { amountMinor: 50_000n },
    });

    const first = await lane.purchase(buy('usr_pf1', 10_000n));
    assert.equal(first.status, 'accepted');
    // The funding posting is real and durable: spendable dropped by the escrow amount.
    assert.equal(
      (await store.ledger.balance(spendable('usr_pf1'))).minor,
      50_000n,
    );
    assert.equal(
      (await store.ledger.balance(sessionEscrow('usr_pf1', 'sess_pf_1'))).minor,
      50_000n,
    );

    // The escrow is the screen: a purchase past the escrow's remaining headroom refuses, even
    // though spendable still holds plenty.
    const second = await lane.purchase(buy('usr_pf1', 45_000n));
    assert.equal(second.status, 'rejected');

    await lane.settle();
    // The 10k spend settled out of escrow; the 40k remainder came home to spendable.
    assert.equal(
      (await store.ledger.balance(sessionEscrow('usr_pf1', 'sess_pf_1'))).minor,
      0n,
    );
    assert.equal(
      (await store.ledger.balance(spendable('usr_pf1'))).minor,
      90_000n,
    );
    assert.equal(
      (await store.ledger.balance(earned('usr_pf_seller'))).minor > 0n,
      true,
    );
  });

  test('refuses a buyer whose matured spendable cannot cover the escrow amount', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_pf2', 10_000n);
    const lane = openInstanceEconomy(deps, 'sess_pf_2', {
      prefund: { amountMinor: 50_000n },
    });
    const outcome = await lane.purchase(buy('usr_pf2', 1_000n));
    assert.deepEqual(outcome.status, 'rejected');
    assert.equal(
      (await store.ledger.balance(spendable('usr_pf2'))).minor,
      10_000n,
    );
  });

  test('the orphan sweep returns a crashed lane’s escrow remainder to its owner', async () => {
    const { store, deps } = harness();
    await fund(store, 'usr_pf3', 100_000n);
    const lane = openInstanceEconomy(deps, 'sess_pf_3', {
      prefund: { amountMinor: 30_000n },
    });
    const outcome = await lane.purchase(buy('usr_pf3', 5_000n));
    assert.equal(outcome.status, 'accepted');
    await lane.flush();
    // The lane dies here: escrow still holds the unspent 25k, session never settled.
    assert.equal(
      (await store.ledger.balance(sessionEscrow('usr_pf3', 'sess_pf_3'))).minor,
      30_000n,
    );

    const summary = await sweepOrphanSessions(store, makeWorkerCtx(), {
      now: 120_000,
      limit: 100,
      settleOlderThanMs: 60_000,
    });
    assert.equal(summary.settled.length, 1);
    assert.deepEqual(summary.escrowRefunds, [
      { sessionId: 'sess_pf_3', userId: 'usr_pf3', minor: '25000' },
    ]);
    assert.equal(
      (await store.ledger.balance(sessionEscrow('usr_pf3', 'sess_pf_3'))).minor,
      0n,
    );
    // 100k - 5k spent: the whole remainder is home.
    assert.equal(
      (await store.ledger.balance(spendable('usr_pf3'))).minor,
      95_000n,
    );
  });
});
