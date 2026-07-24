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

// Row anchoring: every unhashed row that drives money (payout sagas, subscriptions, promo
// grants) names the posting that created it, and every money-moving step re-proves the row
// against that posting's sealed metadata and legs first. These tests are the attacks: edited
// anchors, forged rows, overwritten prices — each must fault loudly and move nothing.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { requestPayout } from '#src/operations/requestPayout.ts';
import { subscribe } from '#src/operations/subscribe.ts';
import { advanceDuePayouts } from '#src/worker/payouts.ts';
import { sweepDueSubscriptions } from '#src/worker/subscriptions.ts';
import { sweepExpiredPromos } from '#src/worker/promos.ts';
import { postEntry, debit, credit } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM, earned, promo, spendable } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  makeCtx,
  makeWorkerCtx,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';
import {
  credit as creditOf,
  requestPayout as requestPayoutOf,
  subscribe as subscribeOf,
} from '#test/support/builders.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { Amount } from '#src/money.ts';
import type { Ctx, WorkerCtx } from '#src/contract.ts';
import type { Leg, Processor, Store } from '#src/ports.ts';

type Fixture = {
  store: Store;
  ctx: Ctx;
  workerCtx: (processor?: Processor) => WorkerCtx;
  ledger: MemoryLedger;
  fund(account: Parameters<typeof credit>[0], amount: Amount): Promise<void>;
};

function setup(): Fixture {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const config = testConfig();
  const ctx = makeCtx({ clock, digest, config });
  const store = memoryStore({ digest, clock });
  let seeds = 0;
  return {
    store,
    ctx,
    workerCtx: (processor) =>
      makeWorkerCtx({
        clock,
        digest,
        config,
        ...(processor === undefined ? {} : { processor }),
      }),
    ledger: store.ledger as MemoryLedger,
    fund: async (account, amount) => {
      await store.transaction((unit) =>
        postEntry(unit.ledger, {
          txnId: `txn_fund_${(seeds += 1)}`,
          legs: [debit(SYSTEM.STORED_VALUE, amount), credit(account, amount)],
          meta: { kind: 'topUp', source: 'card' },
        }),
      );
    },
  };
}

function countingProcessor(calls: string[]): Processor {
  return {
    submitPayout: async (input: { key: string }) => {
      calls.push(input.key);
      return { providerRef: `prov_${input.key}` };
    },
  };
}

describe('payout sagas move money only through their anchor', () => {
  test('a tampered reserve posting stops the submit; no USD leaves', async () => {
    const fx = setup();
    await fx.fund(earned('usr_seller'), creditOf('4.00'));
    const outcome = await fx.store.transaction((unit) =>
      requestPayout(
        requestPayoutOf({ userId: 'usr_seller', amount: creditOf('4.00') }),
        unit,
        fx.ctx,
      ),
    );
    assert.equal(outcome.status, 'committed');
    const txnId = (outcome as { transaction: { id: string } }).transaction.id;

    fx.ledger.__tamper(txnId, (legs: Leg[]) => {
      legs[0] = { account: legs[0]!.account, amount: toAmount('CREDIT', 1n) };
    });

    const calls: string[] = [];
    const summary = await advanceDuePayouts(
      fx.store,
      fx.workerCtx(countingProcessor(calls)),
      { now: 1_000_000, limit: 10 },
    );
    assert.deepEqual(calls, []);
    // The saga wedges — no submit, no dead-letter reserve return — and reports itself loudly.
    assert.equal(summary.retrying[0]?.code, 'CHAIN.BROKEN');
    assert.deepEqual(summary.deadLettered, []);
  });

  test('a forged saga row moves nothing', async () => {
    const fx = setup();
    // The forged row names a real, honest posting — just not a requestPayout anchor for it.
    await fx.fund(spendable('usr_mark'), creditOf('20000.00'));
    await fx.store.transaction((unit) =>
      unit.sagas.open({
        id: 'pay_forged',
        userId: 'usr_attacker',
        reserve: creditOf('20000.00'),
        rateId: 'rate_forged',
        txnId: 'txn_fund_1',
        state: 'RESERVED',
        providerRef: null,
        reason: null,
        attempts: 0,
        payoutUsd: toAmount('USD', 10_000n),
        dueAt: 0,
        updatedAt: 0,
      }),
    );
    const calls: string[] = [];
    const summary = await advanceDuePayouts(
      fx.store,
      fx.workerCtx(countingProcessor(calls)),
      { now: 1_000_000, limit: 10 },
    );
    assert.deepEqual(calls, []);
    assert.equal(summary.retrying[0]?.code, 'CHAIN.BROKEN');
    assert.deepEqual(
      await fx.store.ledger.balance(spendable('usr_mark')),
      creditOf('20000.00'),
    );
  });
});

describe('subscriptions renew only through their anchor', () => {
  test('an overwritten price stops the renewal; the buyer is not charged', async () => {
    const fx = setup();
    await fx.fund(spendable('usr_member'), creditOf('300.00'));
    const outcome = await fx.store.transaction((unit) =>
      subscribe(
        subscribeOf({
          userId: 'usr_member',
          sellerId: 'usr_club',
          sku: 'club_pass',
          price: creditOf('100.00'),
          periodMs: 1_000,
        }),
        unit,
        fx.ctx,
      ),
    );
    assert.equal(outcome.status, 'committed');
    const spent = await fx.store.ledger.balance(spendable('usr_member'));

    // The attack: overwrite the unhashed row with an inflated price.
    const subs = await fx.store.subscriptions.claimDue(10_000, 10);
    await fx.store.transaction((unit) =>
      unit.subscriptions.open({ ...subs[0]!, price: creditOf('250.00') }),
    );

    const summary = await sweepDueSubscriptions(fx.store, fx.workerCtx(), {
      now: 10_000,
      limit: 10,
    });
    assert.equal(summary.charged.length, 0);
    assert.deepEqual(
      await fx.store.ledger.balance(spendable('usr_member')),
      spent,
    );
  });
});

describe('promo grants reverse only through their anchor', () => {
  test('a forged grant claws nothing back', async () => {
    const fx = setup();
    await fx.fund(promo('usr_lucky'), creditOf('40.00'));
    // The forged row: names the funding posting, but that posting granted no such promo amount.
    await fx.store.transaction((unit) =>
      unit.promos.open({
        id: 'txn_fund_1',
        userId: 'usr_lucky',
        amount: creditOf('99.00'),
        expiresAt: 1,
        reversed: false,
      }),
    );
    const summary = await sweepExpiredPromos(fx.store, fx.workerCtx(), {
      now: 10,
      limit: 10,
    });
    assert.equal(summary.reversed.length, 0);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0]!.code, 'CHAIN.BROKEN');
    assert.deepEqual(
      await fx.store.ledger.balance(promo('usr_lucky')),
      creditOf('40.00'),
    );
  });
});
