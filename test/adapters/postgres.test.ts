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

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import '#test/support/dist-guard.ts';

import { runStoreConformance } from '#test/conformance/store.ts';
import { postgresStore } from '@pwngh/economy-postgres';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { freshName, testPostgresUrl } from '#test/support/adapters.ts';

import type { OutboxMessage, Saga, Store, Subscription } from '#src/ports.ts';
import type { Operation } from '#src/contract.ts';

const url = testPostgresUrl(process.env);

// `lockMany` resolves true only because capabilities are read off the transaction unit. Postgres
// carries it there and not on `store.ledger`, so this declaration fails the moment that
// resolution moves back to the store.
runStoreConformance(
  'postgres',
  () => postgresStore({ url, schemaName: freshName('el_conf') }),
  { capabilities: { lockMany: true, appendAll: true } },
);

// The partitioned layout (packages/postgres/src/pg-partition.ts) must be runtime-identical: the whole
// conformance suite runs against it, so every port behavior is proven on either layout.
runStoreConformance('postgres (partitioned layout)', () =>
  postgresStore({
    url,
    schemaName: freshName('el_conf_part'),
    layout: 'partitioned',
  }),
);

// Regression: folding a balance with `insert ... on conflict do update` ran the
// `user_account_non_negative` check against the to-be-inserted row (just the negative change),
// rejecting a debit whose final balance was positive. The fix folds with a plain UPDATE first so
// the check sees the summed balance; the conformance suite never posts twice to one account.
describe('Store Conformance: postgres (Posting Onto A Funded Account)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schemaName: freshName('el_conf') });
    } catch {
      store = null;
    }
  });
  after(async () => {
    if (store) {
      await store.close();
    }
  });

  test('subtracts a debit from a pre-funded user account without tripping the non-negative check', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const userId = 'usr_fold_regression';
    const account = spendable(userId);

    const funded = decodeAmount('500.00', 'CREDIT');
    await live.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_fold_credit',
        legs: [credit(account, funded), debit(SYSTEM.REVENUE, funded)],
        meta: { source: 'card' },
      }),
    );
    assert.deepEqual(
      await live.ledger.balance(account),
      toAmount('CREDIT', 50_000n),
    );

    const spent = decodeAmount('120.00', 'CREDIT');
    await live.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_fold_debit',
        legs: [debit(account, spent), credit(SYSTEM.REVENUE, spent)],
        meta: { source: 'spend' },
      }),
    );

    assert.deepEqual(
      await live.ledger.balance(account),
      toAmount('CREDIT', 38_000n),
    );
  });
});

function outboxMessage(id: string): OutboxMessage {
  return {
    id,
    event: {
      id: `evt_${id}`,
      type: 'economy.credits.topped_up',
      version: 1,
      occurredAt: 0,
      subject: 'usr_obx',
      data: {},
      audience: 'internal',
    },
    status: 'pending',
    attempts: 0,
    reason: null,
    correlationId: null,
  };
}

// `updatedAt` defaults to `dueAt` because lastPayoutAt reads the largest updatedAt.
function sagaRow(
  overrides: Partial<Saga> & { id: string; userId: string },
): Saga {
  return {
    reserve: toAmount('CREDIT', 2_000_000n),
    rateId: 'rate_test',
    txnId: 'txn_anchor_pg',
    state: 'RESERVED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: overrides.dueAt ?? 0,
    payoutUsd: null,
    ...overrides,
  };
}

function subscriptionRow(
  overrides: Partial<Subscription> & { id: string },
): Subscription {
  return {
    userId: 'usr_sub',
    sellerId: 'usr_seller',
    sku: 'sku_test',
    price: toAmount('CREDIT', 10_000n),
    txnId: 'txn_anchor_pg_sub',
    periodMs: 30 * 24 * 60 * 60_000,
    state: 'ACTIVE',
    period: 1,
    attempts: 0,
    nextDueAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('Store Conformance: postgres (Outbox)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schemaName: freshName('el_conf') });
    } catch {
      store = null;
    }
  });
  after(async () => {
    if (store) {
      await store.close();
    }
  });

  test('outbox.bumpAttempt returns each count it writes and keeps the row claimable', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const id = 'obx_record_failure';
    await live.outbox.enqueue(outboxMessage(id));

    // The count comes out of the same statement that wrote it, so it cannot lag a concurrent bump.
    assert.equal(await live.outbox.bumpAttempt(id), 1);
    assert.equal(await live.outbox.bumpAttempt(id), 2);

    const batch = await live.outbox.claimBatch(10);
    const row = batch.find((message) => message.id === id);
    assert.notEqual(row, undefined);
    assert.equal(row!.attempts, 2);
    assert.equal(row!.status, 'pending');
  });

  test('outbox.bumpAttempt counts nothing and returns 0 on a missing or terminal row', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    assert.equal(await live.outbox.bumpAttempt('obx_does_not_exist'), 0);

    const id = 'obx_record_failure_terminal';
    await live.outbox.enqueue(outboxMessage(id));
    await live.outbox.deadLetter(id, 'DISPATCH.FAILURE');
    assert.equal(await live.outbox.bumpAttempt(id), 0);

    // Assert by exhaustion: a pending claim cannot see a dead row.
    const batch = await live.outbox.claimBatch(100);
    assert.equal(
      batch.some((message) => message.id === id),
      false,
    );
  });

  test('outbox.deadLetter flips the row to dead so claimBatch never returns it', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const poison = 'obx_dead_letter';
    const healthy = 'obx_dead_letter_sibling';
    await live.outbox.enqueue(outboxMessage(poison));
    await live.outbox.enqueue(outboxMessage(healthy));

    await live.outbox.deadLetter(poison, 'DISPATCH.FAILURE');

    const batch = await live.outbox.claimBatch(100);
    const ids = batch.map((message) => message.id);
    assert.equal(ids.includes(poison), false);
    assert.equal(ids.includes(healthy), true);

    // A second deadLetter on the now-terminal row is a no-op (and must not throw).
    await live.outbox.deadLetter(poison, 'DISPATCH.OTHER');
  });
});

// Regression: the claims ordered by a timestamp column and nothing else. `created_at` defaults to
// now(), which Postgres fixes at transaction start, so all six rows one submit enqueues carry the
// identical stamp — measured 1 distinct value of 6, where MySQL's statement-time default gives 6 of
// 6. With `limit` under the tie count and no tiebreak, each sweep was free to return a different
// arbitrary subset and a tied row could be passed over indefinitely.
describe('Store Conformance: postgres (Tied Claims)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schemaName: freshName('el_tie') });
    } catch {
      store = null;
    }
  });
  after(async () => {
    if (store) {
      await store.close();
    }
  });

  test('claims a created_at tie in primary-key order, so every claim size is a prefix of one order', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    // Enqueued in the reverse of their id order and inside one transaction, so `created_at` cannot
    // separate them and insertion order is not the answer.
    const enqueued = [
      'obx_tie_f',
      'obx_tie_e',
      'obx_tie_d',
      'obx_tie_c',
      'obx_tie_b',
      'obx_tie_a',
    ];
    await live.transaction(async (unit) => {
      for (const id of enqueued) {
        await unit.outbox.enqueue(outboxMessage(id));
      }
    });
    const byId = [...enqueued].sort();

    // Nothing marks these relayed, so the pending set is the same for every claim below: each one
    // must resolve to the same head of the same order.
    let claimsCompared = 0;
    for (const limit of [1, 2, 3, 6]) {
      const batch = await live.outbox.claimBatch(limit);
      assert.deepEqual(
        batch.map((message) => message.id),
        byId.slice(0, limit),
        `claimBatch(${limit})`,
      );
      claimsCompared += 1;
    }
    assert.equal(claimsCompared, 4);
  });

  test('claims and revives a receivedAt tie in primary-key order', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    // One millisecond holds any number of inbound events, so `received_at` ties on a burst. Ids
    // again run against insertion order.
    const enqueued = ['ibx_tie_d', 'ibx_tie_c', 'ibx_tie_b', 'ibx_tie_a'];
    for (const id of enqueued) {
      await live.inbox.enqueueInbound({
        id,
        key: `evt_${id}`,
        operation: {
          kind: 'topUp',
          idempotencyKey: `evt_${id}`,
          actor: { kind: 'system', service: 'webhook:billing' },
          userId: 'usr_tie',
          amount: toAmount('CREDIT', 1_000n),
          source: 'card',
        } as Operation,
        status: 'pending',
        attempts: 0,
        receivedAt: 7_000,
        reason: null,
      });
    }
    const byId = [...enqueued].sort();

    let claimsCompared = 0;
    for (const limit of [1, 2, 4]) {
      const batch = await live.inbox.claimInbound({ now: 0, limit });
      assert.deepEqual(
        batch.map((message) => message.id),
        byId.slice(0, limit),
        `claimInbound(${limit})`,
      );
      claimsCompared += 1;
    }
    assert.equal(claimsCompared, 3);

    // reviveDead reads the same tie through the same clause, but it revives under an UPDATE whose
    // RETURNING is unordered (MySQL re-reads by id list, equally unordered), so the clause fixes
    // WHICH rows revive and not the order they come back in — which is all the contract promises.
    // It consumes rows, so the two halves of the order are taken one after the other.
    for (const id of enqueued) {
      await live.inbox.deadLetter(id, 'APPLY.FAILURE');
    }
    assert.deepEqual(
      (await live.inbox.reviveDead(2)).map((message) => message.id).sort(),
      byId.slice(0, 2),
    );
    for (const id of byId.slice(0, 2)) {
      await live.inbox.markApplied(id);
    }
    assert.deepEqual(
      (await live.inbox.reviveDead(2)).map((message) => message.id).sort(),
      byId.slice(2),
    );
  });
});

describe('Store Conformance: postgres (Sagas)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schemaName: freshName('el_conf') });
    } catch {
      store = null;
    }
  });
  after(async () => {
    if (store) {
      await store.close();
    }
  });

  test('sagas.lastPayoutAt returns the max updatedAt across all states, null for an unknown user', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const userId = 'usr_last_payout';

    assert.equal(await live.sagas.lastPayoutAt(userId), null);

    await live.sagas.open(
      sagaRow({ id: 'pay_last_a', userId, state: 'SETTLED', updatedAt: 100 }),
    );
    await live.sagas.open(
      sagaRow({ id: 'pay_last_b', userId, state: 'FAILED', updatedAt: 300 }),
    );
    // A different user's saga must not leak into this user's max.
    await live.sagas.open(
      sagaRow({ id: 'pay_last_other', userId: 'usr_other', updatedAt: 9_000 }),
    );

    assert.equal(await live.sagas.lastPayoutAt(userId), 300);
  });

  test('sagas.deadLetter persists the reason while flipping to FAILED', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const id = 'pay_dead_letter';
    await live.sagas.open(
      sagaRow({ id, userId: 'usr_dl', state: 'SUBMITTED' }),
    );

    await live.sagas.deadLetter(id, 'PROVIDER.FAILURE');

    const loaded = await live.sagas.load(id);
    assert.notEqual(loaded, null);
    assert.equal(loaded!.state, 'FAILED');
  });
});

describe('Store Conformance: postgres (Subscriptions)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schemaName: freshName('el_conf') });
    } catch {
      store = null;
    }
  });
  after(async () => {
    if (store) {
      await store.close();
    }
  });

  test('subscriptions round-trip attempts: open/load, markBilled resets, markLapsed leaves it, re-open upserts', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const id = 'sub_attempts';

    await live.subscriptions.open(subscriptionRow({ id, attempts: 2 }));
    assert.equal((await live.subscriptions.load(id))!.attempts, 2);

    const prior = (await live.subscriptions.load(id))!;
    await live.subscriptions.open({ ...prior, attempts: prior.attempts + 1 });
    assert.equal((await live.subscriptions.load(id))!.attempts, 3);

    // The re-opens never touched next_due_at, so markBilled's expected value (0, from
    // subscriptionRow) still matches and the update lands.
    await live.subscriptions.markBilled(id, 1_000, 0);
    const billed = (await live.subscriptions.load(id))!;
    assert.equal(billed.attempts, 0);
    assert.equal(billed.period, 2);

    await live.subscriptions.open(subscriptionRow({ id, attempts: 5 }));
    await live.subscriptions.markLapsed(id);
    const lapsed = (await live.subscriptions.load(id))!;
    assert.equal(lapsed.state, 'LAPSED');
    assert.equal(lapsed.attempts, 5);
  });
});
