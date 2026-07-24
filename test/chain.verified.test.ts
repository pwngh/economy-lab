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

// Verified-at-use reads: no money movement derives from unverified history. Every reversal-family
// handler re-proves the posting it reads against that posting's own chain links, cross-checks the
// unhashed side tables (sales, accrual rows) against sealed metadata, and faults CHAIN.BROKEN on
// any mismatch — tampering fails the operation instead of shaping it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { verifiedPosting } from '#src/chain.ts';
import { spend } from '#src/operations/spend.ts';
import { refund } from '#src/operations/refund.ts';
import { reverse } from '#src/operations/reverse.ts';
import { drainAccruals } from '#src/worker/accrual.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';
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
  spend as spendOf,
} from '#test/support/builders.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome, WorkerCtx } from '#src/contract.ts';
import type { Leg, Store } from '#src/ports.ts';

const PRICE = creditOf('100.00');

type Fixture = {
  store: Store;
  ctx: Ctx;
  workerCtx: WorkerCtx;
  ledger: MemoryLedger;
  issue(userId: string, amount: Amount): Promise<void>;
  run(operation: Operation): Promise<Outcome>;
};

function setup(options: { accrual: boolean } = { accrual: false }): Fixture {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const config = mergeConfig(testConfig(), {
    accrualDrain: options.accrual,
    platformShards: options.accrual ? 2 : 1,
  });
  const ctx = makeCtx({ clock, digest, config });
  const workerCtx = makeWorkerCtx({ clock, digest, config });
  const store = memoryStore({ digest, clock });
  const handlers = { spend, refund, reverse } as const;
  return {
    store,
    ctx,
    workerCtx,
    ledger: store.ledger as MemoryLedger,
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
  };
}

async function sell(fx: Fixture, orderId: string): Promise<string> {
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
  assert.equal(outcome.status, 'committed');
  return (outcome as Extract<Outcome, { status: 'committed' }>).transaction.id;
}

function chainBroken(error: unknown): boolean {
  return (error as { code?: string }).code === 'CHAIN.BROKEN';
}

describe('verifiedPosting', () => {
  test('returns a clean posting and faults on in-place edited legs', async () => {
    const fx = setup();
    const txnId = await sell(fx, 'ord_v1');

    const clean = await verifiedPosting(
      { ledger: fx.store.ledger, digest: fx.ctx.digest },
      txnId,
    );
    assert.equal(clean?.txnId, txnId);

    // The lazy attacker: edit stored legs, leave every hash untouched.
    fx.ledger.__tamper(txnId, (legs: Leg[]) => {
      legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
    });
    await assert.rejects(
      () =>
        verifiedPosting(
          { ledger: fx.store.ledger, digest: fx.ctx.digest },
          txnId,
        ),
      chainBroken,
    );
  });

  test('answers null for an unknown id, like Ledger.posting', async () => {
    const fx = setup();
    assert.equal(
      await verifiedPosting(
        { ledger: fx.store.ledger, digest: fx.ctx.digest },
        'txn_missing',
      ),
      null,
    );
  });
});

describe('refund reads only verified history', () => {
  test('faults instead of refunding when the sale posting was edited in place', async () => {
    const fx = setup();
    const txnId = await sell(fx, 'ord_v2');
    fx.ledger.__tamper(txnId, (legs: Leg[]) => {
      legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
    });
    await assert.rejects(
      () => fx.run(refundOf({ orderId: 'ord_v2' })),
      chainBroken,
    );
  });

  test('faults when the unhashed sales row no longer matches its posting', async () => {
    const fx = setup();
    await sell(fx, 'ord_v3');
    // The side-table attack: inflate the sales copy of the legs; the posting stays honest.
    const sale = await fx.store.sales.get('ord_v3');
    await fx.store.transaction((unit) =>
      unit.sales.put({
        ...sale!,
        legs: sale!.legs.map((leg, i) =>
          i === 0
            ? {
                ...leg,
                amount: { ...leg.amount, minor: leg.amount.minor * 2n },
              }
            : leg,
        ),
      }),
    );
    await assert.rejects(
      () => fx.run(refundOf({ orderId: 'ord_v3' })),
      chainBroken,
    );
  });

  test('faults when an accrual row does not match the sealed share map', async () => {
    const fx = setup({ accrual: true });
    const txnId = await sell(fx, 'ord_v4');
    // The fabricated row: same order, same creating txnId, attacker as the seller.
    await fx.store.transaction((unit) =>
      unit.accruals.put([
        {
          orderId: 'ord_v4',
          sellerId: 'usr_attacker',
          seq: 0,
          amount: creditOf('50.00'),
          shard: SYSTEM.SETTLEMENT_ACCRUAL,
          status: 'pending',
          txnId,
          settledTxnId: null,
          recordedAt: 0,
        },
      ]),
    );
    await assert.rejects(
      () => fx.run(refundOf({ orderId: 'ord_v4' })),
      chainBroken,
    );
  });
});

describe('the drain reads only provable rows', () => {
  test('a fabricated row dead-ends its seller loudly; honest sellers still settle', async () => {
    const fx = setup({ accrual: true });
    const txnId = await sell(fx, 'ord_v5');
    await fx.store.transaction((unit) =>
      unit.accruals.put([
        {
          orderId: 'ord_v5',
          sellerId: 'usr_attacker',
          seq: 0,
          amount: creditOf('50.00'),
          shard: SYSTEM.SETTLEMENT_ACCRUAL,
          status: 'pending',
          txnId,
          settledTxnId: null,
          recordedAt: 0,
        },
      ]),
    );
    const summary = await drainAccruals(fx.store, fx.workerCtx, {
      now: 0,
      limit: 100,
    });
    assert.deepEqual(
      summary.failed.map((entry) => [entry.sellerId, entry.code]),
      [['usr_attacker', 'CHAIN.BROKEN']],
    );
    assert.equal(summary.drained.length, 1);
    assert.equal(summary.drained[0]!.sellerId, 'usr_seller');
    const attacker = await fx.store.ledger.balance(spendable('usr_attacker'));
    assert.equal(attacker.minor, 0n);
  });
});

describe('reverse reads only verified history', () => {
  test('faults instead of reversing an edited posting', async () => {
    const fx = setup();
    const txnId = await sell(fx, 'ord_v6');
    fx.ledger.__tamper(txnId, (legs: Leg[]) => {
      legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
    });
    await assert.rejects(
      () =>
        fx.run({
          kind: 'reverse',
          idempotencyKey: 'idem_rev_v6',
          actor: { kind: 'operator', operatorId: 'op_1' },
          txnId,
          reason: 'test reversal of tampered posting',
        } as Operation),
      chainBroken,
    );
  });
});
