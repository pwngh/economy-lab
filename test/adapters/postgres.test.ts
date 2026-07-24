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

import { runStoreConformance } from '#test/conformance/store.ts';
import { postgresStore } from '#src/engines/postgres.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { freshName, testPostgresUrl } from '#test/support/adapters.ts';

import type { OutboxMessage, Saga, Store, Subscription } from '#src/ports.ts';

const url = testPostgresUrl(process.env);

runStoreConformance('postgres', () =>
  postgresStore({ url, schemaName: freshName('el_conf') }),
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

  test('outbox.recordFailure bumps attempts by one and keeps the row claimable', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    const id = 'obx_record_failure';
    await live.outbox.enqueue(outboxMessage(id));

    await live.outbox.recordFailure(id);
    await live.outbox.recordFailure(id);

    const batch = await live.outbox.claimBatch(10);
    const row = batch.find((message) => message.id === id);
    assert.notEqual(row, undefined);
    assert.equal(row!.attempts, 2);
    assert.equal(row!.status, 'pending');
  });

  test('outbox.recordFailure is a no-op on a missing or already-terminal row', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    const live = store;
    await live.outbox.recordFailure('obx_does_not_exist');

    const id = 'obx_record_failure_terminal';
    await live.outbox.enqueue(outboxMessage(id));
    await live.outbox.deadLetter(id, 'DISPATCH.FAILURE');
    await live.outbox.recordFailure(id);

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
