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

// The accrual split (config.accrualDrain): parked shares (I2), drain settlement and idempotent
// replay (I3), refund exactness on both row paths (I4), and the payout reserve coupling (I8).
// Flag-off exactness is covered by the rest of the suite running with the flag off.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { spend } from '#src/operations/spend.ts';
import { refund } from '#src/operations/refund.ts';
import { subscribe } from '#src/operations/subscribe.ts';
import { requestPayout } from '#src/operations/requestPayout.ts';
import { drainAccruals } from '#src/worker/accrual.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import {
  SYSTEM,
  earned,
  platformShard,
  shardsOf,
  spendable,
} from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { mergeConfig } from '#src/config.ts';
import {
  fixedClock,
  makeCtx,
  makeWorkerCtx,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';
import {
  credit as creditOf,
  refund as refundOf,
  requestPayout as requestPayoutOf,
  spend as spendOf,
  subscribe as subscribeOf,
} from '#test/support/builders.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome, WorkerCtx } from '#src/contract.ts';
import type { Leg, Store } from '#src/ports.ts';

// At least 2, so the shard routing is actually exercised; 1 would collapse to the pooled account.
const SHARDS = 2;

type Fixture = {
  store: Store;
  ctx: Ctx;
  workerCtx: WorkerCtx;
  issue(userId: string, amount: Amount): Promise<void>;
  run(operation: Operation): Promise<Outcome>;
  drain(): ReturnType<typeof drainAccruals>;
  balanceOf(account: AccountRef): Promise<Amount>;
  accrualBalanceMinor(): Promise<bigint>;
};

function setup(): Fixture {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const config = mergeConfig(testConfig(), {
    accrualDrain: true,
    platformShards: SHARDS,
  });
  const ctx: Ctx = makeCtx({ clock, digest, config });
  const workerCtx: WorkerCtx = makeWorkerCtx({ clock, digest, config });
  const store: Store = memoryStore({ digest, clock });
  const handlers = { spend, refund, subscribe, requestPayout } as const;
  return {
    store,
    ctx,
    workerCtx,
    issue: async (userId, amount) => {
      await store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: ctx.ids.next('txn'),
          legs: [
            debit(SYSTEM.STORED_VALUE, amount),
            credit(spendable(userId), amount),
          ],
          meta: { kind: 'topUp', source: 'card' },
        }),
      );
    },
    run: (operation) =>
      store.transaction((unit) =>
        handlers[operation.kind as keyof typeof handlers](operation, unit, ctx),
      ),
    drain: () => drainAccruals(store, workerCtx, { now: 0, limit: 100 }),
    balanceOf: (account) => store.ledger.balance(account),
    accrualBalanceMinor: async () => {
      let minor = 0n;
      for (const shard of shardsOf(SYSTEM.SETTLEMENT_ACCRUAL, SHARDS)) {
        minor += (await store.ledger.balance(shard)).minor;
      }
      return minor;
    },
  };
}

function committed(
  outcome: Outcome,
): asserts outcome is Extract<Outcome, { status: 'committed' }> {
  assert.equal(outcome.status, 'committed');
}

// 100.00 at the test fee of 30%: the seller's share is 70.00.
const PRICE = creditOf('100.00');
const SHARE = creditOf('70.00');

async function sell(fx: Fixture, orderId: string): Promise<void> {
  await fx.issue('usr_buyer', PRICE);
  const outcome = await fx.run(
    spendOf({
      buyerId: 'usr_buyer',
      sku: 'sku_hat',
      price: PRICE,
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId,
    }),
  );
  committed(outcome);
}

describe('accrual split: spend parks shares (I2)', () => {
  test('the seller credit lands on an ACCRUAL shard, not earned, with a pending row', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');

    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, 0n);
    assert.equal(await fx.accrualBalanceMinor(), SHARE.minor);

    const rows = await fx.store.transaction((unit) =>
      unit.accruals.claimByOrder('ord_1'),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sellerId, 'usr_seller');
    assert.equal(rows[0]!.status, 'pending');
    assert.equal(rows[0]!.amount.minor, SHARE.minor);

    // I2 as the prover will check it: parked balance equals the positive pending total.
    const stats = await fx.store.accruals.stats();
    assert.equal(stats.pendingMinor, await fx.accrualBalanceMinor());
  });

  test('a promo-funded part parks its seller share too', async () => {
    const fx = setup();
    await fx.store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: fx.ctx.ids.next('txn'),
        legs: [
          debit(SYSTEM.PROMO_FLOAT, creditOf('40.00')),
          credit(`usr_buyer:promo` as AccountRef, creditOf('40.00')),
        ],
        meta: { kind: 'grantPromo' },
      }),
    );
    await sell(fx, 'ord_promo');
    // Promo part (40.00, no fee) + spendable part (60.00 at 30% fee = 42.00) both park.
    assert.equal(await fx.accrualBalanceMinor(), 8_200n);
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, 0n);
  });
});

describe('accrual split: the drain (I3)', () => {
  test('moves parked shares to earned in one posting and empties the pool', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await sell(fx, 'ord_2');

    const summary = await fx.drain();
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.drained.length, 1);
    assert.equal(
      summary.drained[0]!.earnedMinor,
      (2n * SHARE.minor).toString(),
    );

    assert.equal(
      (await fx.balanceOf(earned('usr_seller'))).minor,
      2n * SHARE.minor,
    );
    assert.equal(await fx.accrualBalanceMinor(), 0n);
    assert.equal((await fx.store.accruals.stats()).pendingMinor, 0n);

    // The drain posting id derives from the claimed set, so replays converge on it.
    assert.match(summary.drained[0]!.txnId, /^acc_[0-9a-f]{32}$/);
    const posting = await fx.store.ledger.posting(summary.drained[0]!.txnId);
    assert.notEqual(posting, null);
  });

  test('a second run finds nothing pending and settles nothing', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await fx.drain();
    const again = await fx.drain();
    assert.equal(again.drained.length, 0);
    assert.equal(again.failed.length, 0);
  });

  test('reports itself skipped with the flag off', async () => {
    const fx = setup();
    const off = makeWorkerCtx({ config: testConfig() });
    const summary = await drainAccruals(fx.store, off, { now: 0, limit: 10 });
    assert.equal(summary.skipped, true);
  });
});

describe('accrual split: refund before the drain (I4, pending path)', () => {
  test('restores the buyer in full, claws the exact share from the pool, and voids the row', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');

    const outcome = await fx.run(refundOf({ orderId: 'ord_1' }));
    committed(outcome);

    assert.equal(
      (await fx.balanceOf(spendable('usr_buyer'))).minor,
      PRICE.minor,
    );
    assert.equal(await fx.accrualBalanceMinor(), 0n);
    assert.equal((await fx.balanceOf(SYSTEM.RECEIVABLE)).minor, 0n);

    const rows = await fx.store.transaction((unit) =>
      unit.accruals.claimByOrder('ord_1'),
    );
    assert.equal(rows[0]!.status, 'refunded');

    // The voided row never drains: the seller gets nothing for the refunded order.
    await fx.drain();
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, 0n);
  });
});

describe('accrual split: refund after the drain (I4, drained path)', () => {
  test('books the share to RECEIVABLE, leaves earned alone, and appends a negative row', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await fx.drain();

    const outcome = await fx.run(refundOf({ orderId: 'ord_1' }));
    committed(outcome);

    assert.equal(
      (await fx.balanceOf(spendable('usr_buyer'))).minor,
      PRICE.minor,
    );
    // The seller already got the money; recovery is deferred to the drain.
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, SHARE.minor);
    assert.equal((await fx.balanceOf(SYSTEM.RECEIVABLE)).minor, SHARE.minor);

    const rows = await fx.store.transaction((unit) =>
      unit.accruals.claimByOrder('ord_1'),
    );
    const negative = rows.find((row) => row.amount.minor < 0n);
    assert.notEqual(negative, undefined);
    assert.equal(negative!.status, 'pending');
    assert.equal(negative!.amount.minor, -SHARE.minor);
    assert.equal(
      await fx.store.accruals.netPending('usr_seller'),
      -SHARE.minor,
    );
  });

  test('the next drain repays RECEIVABLE from new shares before crediting earned', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await fx.drain();
    committed(await fx.run(refundOf({ orderId: 'ord_1' })));

    // A new sale of the same size funds the recovery exactly.
    await sell(fx, 'ord_2');
    const summary = await fx.drain();
    assert.equal(summary.drained[0]!.recoveredMinor, SHARE.minor.toString());
    assert.equal(summary.drained[0]!.earnedMinor, '0');

    assert.equal((await fx.balanceOf(SYSTEM.RECEIVABLE)).minor, 0n);
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, SHARE.minor);
    assert.equal(await fx.store.accruals.netPending('usr_seller'), 0n);
  });

  test('a share smaller than the debt splits it and carries the residue', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await fx.drain();
    committed(await fx.run(refundOf({ orderId: 'ord_1' })));

    // 50.00 sale: share 35.00 against a 70.00 debt.
    await fx.issue('usr_buyer', creditOf('50.00'));
    committed(
      await fx.run(
        spendOf({
          buyerId: 'usr_buyer',
          sku: 'sku_hat',
          price: creditOf('50.00'),
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
          orderId: 'ord_2',
        }),
      ),
    );
    const summary = await fx.drain();
    assert.equal(summary.drained[0]!.recoveredMinor, '3500');
    assert.equal(summary.drained[0]!.earnedMinor, '0');
    assert.equal((await fx.balanceOf(SYSTEM.RECEIVABLE)).minor, 3_500n);
    assert.equal(await fx.store.accruals.netPending('usr_seller'), -3_500n);
    assert.equal(await fx.accrualBalanceMinor(), 0n);
  });
});

describe('accrual split: payout admission (I8)', () => {
  test('refund debt caps payable earned credit until the drain recovers it', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await fx.drain();
    committed(await fx.run(refundOf({ orderId: 'ord_1' })));

    // earned holds 70.00 but the seller owes 70.00 back: nothing is payable.
    const denied = await fx.run(
      requestPayoutOf({ userId: 'usr_seller', amount: SHARE }),
    );
    assert.equal(denied.status, 'rejected');
    assert.equal(
      (denied as Extract<Outcome, { status: 'rejected' }>).detail.reason,
      'INSUFFICIENT_FUNDS',
    );

    // A new sale drains and repays the debt; the same request now passes.
    await sell(fx, 'ord_2');
    await fx.drain();
    const granted = await fx.run(
      requestPayoutOf({ userId: 'usr_seller', amount: SHARE }),
    );
    committed(granted);
  });
});

describe('accrual split: subscribe parks and routes', () => {
  test('the first-month charge parks the seller share on a routed shard', async () => {
    const fx = setup();
    await fx.issue('usr_sub', creditOf('150.00'));
    const operation = subscribeOf({
      userId: 'usr_sub',
      sellerId: 'usr_seller',
      sku: 'sku_club',
      price: creditOf('150.00'),
    });
    committed(await fx.run(operation));

    // 150.00 at 30% fee: the seller's 105.00 parks; the legs hit the routed shard.
    assert.equal(await fx.accrualBalanceMinor(), 10_500n);
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, 0n);
    const shard = platformShard(
      SYSTEM.SETTLEMENT_ACCRUAL,
      operation.idempotencyKey,
      SHARDS,
    );
    assert.equal((await fx.balanceOf(shard)).minor, 10_500n);

    await fx.drain();
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, 10_500n);
    assert.equal(await fx.accrualBalanceMinor(), 0n);
  });
});

describe('accrual split: the flag can be turned off without corrupting history', () => {
  // The hazard, re-entered by config: with the flag off, the legacy fold would claw the
  // pooled shard without voiding the rows. The path choice is data-driven, so it must not.
  test('refunding a parked sale with the flag off still voids the rows exactly', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await sell(fx, 'ord_2');

    // Same digest as the fixture: refund re-proves the sale posting's chain links before trusting
    // a leg, so the verifying digest must be the one that wrote the chain.
    const offCtx = makeCtx({
      clock: fixedClock(0),
      digest: seededDigest(1),
      config: mergeConfig(testConfig(), { platformShards: SHARDS }),
    });
    const outcome = await fx.store.transaction((unit) =>
      refund(refundOf({ orderId: 'ord_1' }), unit, offCtx),
    );
    committed(outcome);

    // ord_1's row is voided; ord_2's share still drains in full — no cross-order theft.
    const rows = await fx.store.transaction((unit) =>
      unit.accruals.claimByOrder('ord_1'),
    );
    assert.equal(rows[0]!.status, 'refunded');
    assert.equal(await fx.accrualBalanceMinor(), SHARE.minor);
    await fx.drain();
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, SHARE.minor);
    assert.equal(await fx.accrualBalanceMinor(), 0n);
  });

  test('refund debt still caps a payout with the flag off', async () => {
    const fx = setup();
    await sell(fx, 'ord_1');
    await fx.drain();
    committed(await fx.run(refundOf({ orderId: 'ord_1' })));

    const offCtx = makeCtx({
      clock: fixedClock(0),
      digest: seededDigest(9),
      config: testConfig(),
    });
    const denied = await fx.store.transaction((unit) =>
      requestPayout(
        requestPayoutOf({ userId: 'usr_seller', amount: SHARE }),
        unit,
        offCtx,
      ),
    );
    assert.equal(denied.status, 'rejected');
  });
});

describe('accrual split: hostile orderId cannot reach foreign rows', () => {
  test('a spend named after a subscription charge refunds only its own shares', async () => {
    const fx = setup();
    // The subscription charge parks rows keyed by its posting id.
    await fx.issue('usr_sub', creditOf('150.00'));
    const subscription = await fx.run(
      subscribeOf({
        userId: 'usr_sub',
        sellerId: 'usr_club_owner',
        sku: 'sku_club',
        price: creditOf('150.00'),
      }),
    );
    committed(subscription);
    const chargeTxnId = subscription.transaction.id;

    // A buyer names their order exactly that posting id, with a different seller.
    await fx.issue('usr_buyer', PRICE);
    committed(
      await fx.run(
        spendOf({
          buyerId: 'usr_buyer',
          sku: 'sku_hat',
          price: PRICE,
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
          orderId: chargeTxnId,
        }),
      ),
    );

    committed(await fx.run(refundOf({ orderId: chargeTxnId })));

    // The buyer is whole; the subscription's parked share is untouched and still drains.
    assert.equal(
      (await fx.balanceOf(spendable('usr_buyer'))).minor,
      PRICE.minor,
    );
    assert.equal(await fx.accrualBalanceMinor(), 10_500n);
    await fx.drain();
    assert.equal((await fx.balanceOf(earned('usr_club_owner'))).minor, 10_500n);
    assert.equal((await fx.balanceOf(earned('usr_seller'))).minor, 0n);
  });
});

describe('accrual split: flag off changes nothing', () => {
  test('spend still credits earned directly and writes no accrual rows', async () => {
    const digest = seededDigest(1);
    const clock = fixedClock(0);
    const ctx = makeCtx({ clock, digest });
    const store = memoryStore({ digest, clock });
    await store.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: ctx.ids.next('txn'),
        legs: [
          debit(SYSTEM.STORED_VALUE, PRICE),
          credit(spendable('usr_buyer'), PRICE),
        ],
        meta: { kind: 'topUp', source: 'card' },
      }),
    );
    const outcome = await store.transaction((unit) =>
      spend(
        spendOf({
          buyerId: 'usr_buyer',
          sku: 'sku_hat',
          price: PRICE,
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
          orderId: 'ord_off',
        }),
        unit,
        ctx,
      ),
    );
    committed(outcome);
    assert.equal(
      (await store.ledger.balance(earned('usr_seller'))).minor,
      SHARE.minor,
    );
    const parked = outcome.transaction.legs.some(
      (leg: Leg) => leg.account === SYSTEM.SETTLEMENT_ACCRUAL,
    );
    assert.equal(parked, false);
    assert.equal((await store.accruals.stats()).pendingMinor, 0n);
  });
});
