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

// Submit micro-batching: K operations, one transaction, a savepoint each. Each slot carries
// exactly what a lone `submit` would produce and never bleeds into its neighbors — the batch is
// an fsync optimization, never a semantics change.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createEconomy } from '#src/economy.ts';
import { createSubmitCoalescer } from '#src/batching.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { httpStore } from '#src/adapters/http.ts';
import { spendable, earned } from '#src/accounts.ts';
import { makePorts } from '#test/support/capabilities.ts';
import {
  credit as creditOf,
  spend as spendOf,
  topUp as topUpOf,
} from '#test/support/builders.ts';

import type { BatchOutcome, Economy, Operation } from '#src/contract.ts';

function economyOf(store = memoryStore()): Economy {
  return createEconomy(makePorts(store));
}

function outcomeOf(slot: BatchOutcome): Extract<BatchOutcome, { ok: true }> {
  assert.equal(slot.ok, true);
  return slot as Extract<BatchOutcome, { ok: true }>;
}

const buyPlan = (buyerId: string, orderId: string): Operation =>
  spendOf({
    buyerId,
    sku: 'sku_hat',
    price: creditOf('10.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    orderId,
  });

describe('submitBatch: independent operations share one transaction', () => {
  test('commits every slot, index-aligned, with the right balances', async () => {
    const economy = economyOf();
    const slots = await economy.submitBatch([
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
      topUpOf({ userId: 'usr_b', amount: creditOf('20.00') }),
      topUpOf({ userId: 'usr_c', amount: creditOf('30.00') }),
    ]);
    assert.equal(slots.length, 3);
    for (const slot of slots) {
      assert.equal(outcomeOf(slot).outcome.status, 'committed');
    }
    assert.equal(
      (await economy.read.balance(spendable('usr_b'))).minor,
      2_000n,
    );
  });

  test("a later slot sees an earlier slot's uncommitted writes", async () => {
    const economy = economyOf();
    const slots = await economy.submitBatch([
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
      buyPlan('usr_a', 'ord_chain'),
    ]);
    assert.equal(outcomeOf(slots[1]!).outcome.status, 'committed');
    assert.equal((await economy.read.balance(spendable('usr_a'))).minor, 0n);
  });
});

describe("submitBatch: one slot's failure stays its own", () => {
  test('a rejected spend rolls back alone; its neighbors commit', async () => {
    const store = memoryStore();
    const economy = createEconomy(makePorts(store));
    const slots = await economy.submitBatch([
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
      buyPlan('usr_broke', 'ord_broke'),
      topUpOf({ userId: 'usr_b', amount: creditOf('5.00') }),
    ]);
    assert.equal(outcomeOf(slots[0]!).outcome.status, 'committed');
    const rejected = outcomeOf(slots[1]!).outcome;
    assert.equal(rejected.status, 'rejected');
    assert.equal(outcomeOf(slots[2]!).outcome.status, 'committed');
    assert.equal((await economy.read.balance(spendable('usr_b'))).minor, 500n);
    assert.equal(await economy.read.entitled('usr_broke', 'sku_hat'), false);
    assert.equal((await economy.read.balance(earned('usr_seller'))).minor, 0n);
  });

  test('a rejected slot still counts toward the velocity window', async () => {
    const store = memoryStore();
    const economy = createEconomy(makePorts(store));
    const operation = buyPlan('usr_broke', 'ord_denied');
    await economy.submitBatch([operation]);
    // The savepoint erased the in-transaction attempt; submitBatch re-records it, exactly as
    // submit does after a rejection's rollback.
    const velocity = await store.trust.read('out:usr_broke');
    assert.equal(velocity.attempts, 1);
  });

  test('a faulting slot comes back as data and spares the batch', async () => {
    const economy = economyOf();
    const malformed = {
      ...buyPlan('usr_a', 'ord_bad'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 123 }], // shares must sum to 10000
    } as Operation;
    const slots = await economy.submitBatch([
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
      malformed,
    ]);
    assert.equal(outcomeOf(slots[0]!).outcome.status, 'committed');
    assert.equal(slots[1]!.ok, false);
  });
});

describe('submitBatch: idempotency keys', () => {
  test('refuses the same key twice in one batch; the first slot stands', async () => {
    const economy = economyOf();
    const first = topUpOf({ userId: 'usr_a', amount: creditOf('10.00') });
    const twin = {
      ...topUpOf({ userId: 'usr_a', amount: creditOf('99.00') }),
      idempotencyKey: first.idempotencyKey,
    } as Operation;
    const slots = await economy.submitBatch([first, twin]);
    assert.equal(outcomeOf(slots[0]!).outcome.status, 'committed');
    assert.equal(slots[1]!.ok, false);
    assert.equal(
      (await economy.read.balance(spendable('usr_a'))).minor,
      1_000n,
    );
  });

  test('replays a key already committed before the batch as duplicate', async () => {
    const economy = economyOf();
    const original = topUpOf({ userId: 'usr_a', amount: creditOf('10.00') });
    await economy.submit(original);
    const slots = await economy.submitBatch([original]);
    assert.equal(outcomeOf(slots[0]!).outcome.status, 'duplicate');
    assert.equal(
      (await economy.read.balance(spendable('usr_a'))).minor,
      1_000n,
    );
  });
});

describe('submitBatch: nothing to transact', () => {
  test('an empty batch resolves to no slots', async () => {
    const economy = economyOf();
    assert.deepEqual(await economy.submitBatch([]), []);
  });

  test('a batch decided entirely pre-transaction still fills every slot', async () => {
    const economy = economyOf();
    // A user actor debiting another user's account fails authorization before any transaction.
    const forbidden = {
      ...buyPlan('usr_a', 'ord_forbidden'),
      actor: { kind: 'user', userId: 'usr_other' },
    } as Operation;
    const slots = await economy.submitBatch([forbidden]);
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.ok, false);
  });
});

describe('submitBatch: fallback without store batch support', () => {
  test('an HTTP-backed store degrades to sequential submits, same slots', async () => {
    const store = httpStore();
    assert.equal(store.batchTransaction, undefined);
    const economy = createEconomy(makePorts(store));
    const slots = await economy.submitBatch([
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
      buyPlan('usr_broke', 'ord_seq'),
    ]);
    assert.equal(outcomeOf(slots[0]!).outcome.status, 'committed');
    assert.equal(outcomeOf(slots[1]!).outcome.status, 'rejected');
    await economy.close();
  });
});

describe('the submit coalescer', () => {
  test('same-turn submits coalesce and each caller gets its own outcome', async () => {
    const economy = economyOf();
    const coalesced = createSubmitCoalescer(economy);
    const [a, b, denied] = await Promise.all([
      coalesced.submit(topUpOf({ userId: 'usr_a', amount: creditOf('10.00') })),
      coalesced.submit(topUpOf({ userId: 'usr_b', amount: creditOf('20.00') })),
      coalesced.submit(buyPlan('usr_broke', 'ord_co')),
    ]);
    assert.equal(a!.status, 'committed');
    assert.equal(b!.status, 'committed');
    assert.equal(denied!.status, 'rejected');
    assert.equal(
      (await economy.read.balance(spendable('usr_a'))).minor,
      1_000n,
    );
  });

  test('a fault rejects only its own caller', async () => {
    const economy = economyOf();
    const coalesced = createSubmitCoalescer(economy);
    const malformed = {
      ...buyPlan('usr_a', 'ord_bad_co'),
      recipients: [],
    } as unknown as Operation;
    const good = coalesced.submit(
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
    );
    const bad = coalesced.submit(malformed);
    assert.equal((await good).status, 'committed');
    await assert.rejects(bad);
  });

  test('splits a burst larger than maxBatch and completes it all', async () => {
    const economy = economyOf();
    const coalesced = createSubmitCoalescer(economy, { maxBatch: 2 });
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        coalesced.submit(
          topUpOf({ userId: `usr_${i}`, amount: creditOf('1.00') }),
        ),
      ),
    );
    assert.equal(
      outcomes.every((o) => o.status === 'committed'),
      true,
    );
  });

  test('a failed batch commit rejects its whole chunk; later chunks still flush', async () => {
    const economy = economyOf();
    const boom = new Error('store down');
    let failures = 1;
    const flaky: Pick<Economy, 'submit' | 'submitBatch'> = {
      submit: (operation, options) => economy.submit(operation, options),
      submitBatch: (operations) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(boom);
        }
        return economy.submitBatch(operations);
      },
    };
    const coalesced = createSubmitCoalescer(flaky, { maxBatch: 2 });
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        coalesced.submit(
          topUpOf({ userId: `usr_${i}`, amount: creditOf('1.00') }),
        ),
      ),
    );
    assert.equal(settled[0]!.status, 'rejected');
    assert.equal((settled[0] as PromiseRejectedResult).reason, boom);
    assert.equal(settled[1]!.status, 'rejected');
    assert.equal((settled[1] as PromiseRejectedResult).reason, boom);
    assert.equal(settled[2]!.status, 'fulfilled');
    assert.equal(settled[3]!.status, 'fulfilled');
    assert.equal((await economy.read.balance(spendable('usr_3'))).minor, 100n);
  });

  test('flush drains the queue without waiting for the scheduled turn', async () => {
    const economy = economyOf();
    // A defer that never fires: only the explicit flush can drain the queue.
    const coalesced = createSubmitCoalescer(economy, { defer: () => {} });
    const pending = coalesced.submit(
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
    );
    await coalesced.flush();
    assert.equal((await pending).status, 'committed');
  });

  test('a call carrying options bypasses the queue and submits directly', async () => {
    const economy = economyOf();
    let batches = 0;
    const watched: Pick<Economy, 'submit' | 'submitBatch'> = {
      submit: (operation, options) => economy.submit(operation, options),
      submitBatch: (operations) => {
        batches += 1;
        return economy.submitBatch(operations);
      },
    };
    const coalesced = createSubmitCoalescer(watched);
    const outcome = await coalesced.submit(
      topUpOf({ userId: 'usr_a', amount: creditOf('10.00') }),
      { correlationId: 'req_direct' },
    );
    assert.equal(outcome.status, 'committed');
    assert.equal(batches, 0);
  });
});
