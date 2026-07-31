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
 * The price gate is a property of the economy, so it holds on every way in: `submit`,
 * `submitBatch`, and the coalescer that fans a burst into one batch. The batch legs are watched by
 * balance and not by outcome status, because the failure this file exists to catch is money that
 * moved.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createEconomy } from '#src/economy.ts';
import { createSubmitCoalescer } from '#src/batching.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { earned, spendable } from '#src/accounts.ts';
import { makePorts } from '#test/support/capabilities.ts';
import {
  credit as creditOf,
  spend as spendOf,
  topUp as topUpOf,
} from '#test/support/builders.ts';

import type { BatchOutcome, Economy, Operation } from '#src/contract.ts';
import type {
  BatchSlot,
  CallOptions,
  CatalogPort,
  Store,
  Unit,
} from '#src/ports.ts';

const BUYER = 'usr_buyer';
const SELLER = 'usr_seller';
const SKU = 'sku_sword';
const SPLIT = [{ sellerId: SELLER, shareBps: 10_000 }];

// The offer is 100 credits; every mispriced spend below names 1 credit, one hundredth of it.
const OFFER = creditOf('100.00');
const SEEDED_MINOR = 50_000n; // 500 credits
const OFFER_MINOR = 10_000n;

const catalog: CatalogPort = {
  lookup: async (sku) =>
    sku === SKU ? { price: OFFER, recipients: SPLIT } : null,
};

// The defect only exists on a store that HAS batch support: without it `submitBatch` degrades to
// sequential `submit` calls and the gate holds for the wrong reason. This wrapper counts the batch
// transactions the economy opens so each batch leg can prove it took the path it claims to test.
function batchCountingStore(): { store: Store; batches: () => number } {
  const inner = memoryStore();
  let batches = 0;
  return {
    store: {
      ...inner,
      batchTransaction: <T>(
        works: ReadonlyArray<(unit: Unit) => Promise<T>>,
        options?: CallOptions,
      ): Promise<Array<BatchSlot<T>>> => {
        batches += 1;
        return inner.batchTransaction!(works, options);
      },
    },
    batches: () => batches,
  };
}

const buy = (price: string, orderId: string, buyerId = BUYER): Operation =>
  spendOf({
    buyerId,
    sku: SKU,
    price: creditOf(price),
    recipients: SPLIT,
    orderId,
  });

const fund = (economy: Economy, userId = BUYER) =>
  economy.submit(topUpOf({ userId, amount: creditOf('500.00') }));

const outcomeOf = (slot: BatchOutcome) => {
  assert.equal(slot.ok, true, 'the slot came back as a fault');
  return (slot as Extract<BatchOutcome, { ok: true }>).outcome;
};

const mismatch = { reason: 'CATALOG_MISMATCH', sku: SKU, field: 'price' };

const detailOf = (outcome: { status: string; detail?: unknown }) =>
  outcome.status === 'rejected' ? outcome.detail : outcome.status;

describe('the catalog gate holds on every way into the economy', () => {
  test('the economy exposes exactly the two submit entry points this file covers', () => {
    const economy = createEconomy(makePorts(memoryStore(), { catalog }));
    assert.deepEqual(
      Object.keys(economy)
        .filter((key) => key.startsWith('submit'))
        .sort(),
      ['submit', 'submitBatch'],
      'a third submit entry point is not covered by the legs below',
    );
  });

  test('submit refuses a spend that names its own price', async () => {
    const economy = createEconomy(makePorts(memoryStore(), { catalog }));
    assert.equal((await fund(economy)).status, 'committed');

    const outcome = await economy.submit(buy('1.00', 'ord_single'));
    assert.equal(outcome.status, 'rejected');
    assert.deepEqual(detailOf(outcome), mismatch);

    assert.equal(
      (await economy.read.balance(spendable(BUYER))).minor,
      SEEDED_MINOR,
    );
    await economy.close();
  });

  test('submitBatch refuses it too, and the buyer’s wallet does not move', async () => {
    const { store, batches } = batchCountingStore();
    assert.notEqual(
      store.batchTransaction,
      undefined,
      'a store without batch support would prove nothing here',
    );
    const economy = createEconomy(makePorts(store, { catalog }));
    assert.equal((await fund(economy)).status, 'committed');

    // The neighbor is a top-up for someone else: it keeps the shared transaction real without
    // touching the buyer, so the balance below is allowed to be exactly what was seeded.
    const slots = await economy.submitBatch([
      buy('1.00', 'ord_batch'),
      topUpOf({ userId: 'usr_other', amount: creditOf('5.00') }),
    ]);

    assert.equal(batches(), 1, 'submitBatch did not take the batch path');
    assert.equal(
      (await economy.read.balance(spendable(BUYER))).minor,
      SEEDED_MINOR,
    );
    assert.equal((await economy.read.balance(earned(SELLER))).minor, 0n);
    assert.equal(await economy.read.entitled(BUYER, SKU), false);

    assert.deepEqual(detailOf(outcomeOf(slots[0]!)), mismatch);
    assert.equal(outcomeOf(slots[1]!).status, 'committed');
    await economy.close();
  });

  test('the coalescer refuses it too, and the buyer’s wallet does not move', async () => {
    const { store, batches } = batchCountingStore();
    const economy = createEconomy(makePorts(store, { catalog }));
    assert.equal((await fund(economy)).status, 'committed');

    // No CallOptions, which is the coalescer's batching path — the one a host adopts for throughput.
    const coalesced = createSubmitCoalescer(economy);
    const [refused, neighbor] = await Promise.all([
      coalesced.submit(buy('1.00', 'ord_coalesced')),
      coalesced.submit(
        topUpOf({ userId: 'usr_other', amount: creditOf('5.00') }),
      ),
    ]);

    assert.equal(batches(), 1, 'the coalescer did not take the batch path');
    assert.equal(
      (await economy.read.balance(spendable(BUYER))).minor,
      SEEDED_MINOR,
    );
    assert.equal((await economy.read.balance(earned(SELLER))).minor, 0n);
    assert.equal(await economy.read.entitled(BUYER, SKU), false);

    assert.deepEqual(detailOf(refused!), mismatch);
    assert.equal(neighbor!.status, 'committed');
    await economy.close();
  });

  // The control on the refusals: "refused everywhere" is also satisfied by a batch path that
  // refuses everything, so each way in has to still settle the offer at its listed price.
  test('a correctly priced spend still commits through all three', async () => {
    const { store, batches } = batchCountingStore();
    const economy = createEconomy(makePorts(store, { catalog }));
    for (const userId of ['usr_p1', 'usr_p2', 'usr_p3']) {
      assert.equal((await fund(economy, userId)).status, 'committed');
    }

    const direct = await economy.submit(buy('100.00', 'ord_ok_1', 'usr_p1'));
    assert.equal(direct.status, 'committed');

    const slots = await economy.submitBatch([
      buy('100.00', 'ord_ok_2', 'usr_p2'),
    ]);
    assert.equal(outcomeOf(slots[0]!).status, 'committed');

    const coalesced = createSubmitCoalescer(economy);
    assert.equal(
      (await coalesced.submit(buy('100.00', 'ord_ok_3', 'usr_p3'))).status,
      'committed',
    );

    assert.equal(
      batches(),
      2,
      'two of the three legs open a batch transaction',
    );
    for (const userId of ['usr_p1', 'usr_p2', 'usr_p3']) {
      assert.equal(
        (await economy.read.balance(spendable(userId))).minor,
        SEEDED_MINOR - OFFER_MINOR,
        `${userId} did not pay the listed price`,
      );
      assert.equal(await economy.read.entitled(userId, SKU), true);
    }
    await economy.close();
  });

  // The refusals above have to be caused by the port and nothing else, so the same batch with the
  // slot empty must settle at the caller's price.
  test('with the catalog slot empty the batch path prices nothing', async () => {
    const { store, batches } = batchCountingStore();
    const economy = createEconomy(makePorts(store));
    assert.equal((await fund(economy)).status, 'committed');

    const slots = await economy.submitBatch([
      buy('1.00', 'ord_uncataloged'),
      topUpOf({ userId: 'usr_other', amount: creditOf('5.00') }),
    ]);

    assert.equal(batches(), 1);
    assert.equal(outcomeOf(slots[0]!).status, 'committed');
    assert.equal(
      (await economy.read.balance(spendable(BUYER))).minor,
      SEEDED_MINOR - 100n,
    );
    await economy.close();
  });
});
