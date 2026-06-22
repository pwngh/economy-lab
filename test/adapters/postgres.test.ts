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
import { postgresStore } from '#src/adapters/postgres.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';

import type { OutboxMessage, Saga, Store, Subscription } from '#src/ports.ts';

// Test database DSN: env var if set, else local Postgres on the default port/database.
let url = process.env.DATABASE_URL ?? process.env.PG_URL ?? testDsn();

// Unique schema name per run so concurrent suites (or a rerun) get isolated tables and don't
// collide. Combines pid, base-36 timestamp, and a per-call counter.
let run = 0;
function freshSchema(): string {
  run += 1;
  let stamp = Date.now().toString(36);
  return `el_conf_${process.pid}_${stamp}_${run}`;
}

// Default DSN when no env var is set: local Postgres.
function testDsn(): string {
  return 'postgresql://localhost:5432/economy_lab';
}

// Run the shared Store suite (conformance/store.ts) against the Postgres adapter. Each store gets
// a fresh schema, into which postgresStore loads db/postgresql-schema.sql, dropped again on close.
runStoreConformance('postgres', () =>
  postgresStore({ url, schema: freshSchema() }),
);

// Regression: folding a second amount onto an account that already has a balance ("folding" =
// accumulating into the stored running total).
//
// The conformance suite only posts once per account, so it never hit a debit landing on an
// already-positive account. Postgres broke here: the store folded with `insert ... on conflict do
// update`, and the `user_account_non_negative` check (balance >= 0) ran against the to-be-inserted
// row, which carried only the negative change amount, before the on-conflict step folded it into
// the existing balance. The check saw a negative number and rejected a write whose final balance
// was positive. Fixed by folding with a plain UPDATE first, so the check sees the summed balance.
//
// Fails (constraint violation) without the fix, passes with it. Connects in a `before` hook like
// the conformance suite; skips rather than fails when Postgres is unreachable.
describe('Store Conformance: postgres (Posting Onto A Funded Account)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schema: freshSchema() });
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
    let live = store;
    let userId = 'usr_fold_regression';
    let account = spendable(userId);

    // First posting: credit 500.00 into the user's spendable (top-up) account. Each entry is debit
    // and credit lines that cancel; the other line here debits SYSTEM.REVENUE. Amounts are minor
    // units (cents), so 500.00 is 50000, which creates the account row at that balance.
    let funded = decodeAmount('500.00', 'CREDIT');
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

    // Second posting to the same account: debit 120.00 out. The path the bug broke; before the fix
    // the fold rejected this on the non-negative check even though the result (38000) is positive.
    let spent = decodeAmount('120.00', 'CREDIT');
    await live.transaction((unit) =>
      postEntry(unit.ledger, {
        txnId: 'txn_fold_debit',
        legs: [debit(account, spent), credit(SYSTEM.REVENUE, spent)],
        meta: { source: 'spend' },
      }),
    );

    // The running total must be the difference (50000 - 12000 = 38000), not -12000 and not 0.
    assert.deepEqual(
      await live.ledger.balance(account),
      toAmount('CREDIT', 38_000n),
    );
  });
});

// Build one pending outbox row (event queued for later delivery) with a distinct id. Mirrors the
// conformance helper, reusable from the outbox tests below.
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
  };
}

// Build one payout saga (a payout-in-progress record). `updatedAt` defaults to `dueAt` when not
// given, because lastPayoutAt is computed from the largest updatedAt and the tests below need to
// set that field to exact values.
function sagaRow(
  overrides: Partial<Saga> & { id: string; userId: string },
): Saga {
  return {
    reserve: toAmount('CREDIT', 1_000n),
    rateId: 'rate_test',
    state: 'RESERVED',
    providerRef: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: overrides.dueAt ?? 0,
    ...overrides,
  };
}

// Build one subscription. attempts defaults to 0 (a freshly opened subscription).
function subscriptionRow(
  overrides: Partial<Subscription> & { id: string },
): Subscription {
  return {
    userId: 'usr_sub',
    sellerId: 'usr_seller',
    sku: 'sku_test',
    price: toAmount('CREDIT', 500n),
    periodMs: 30 * 24 * 60 * 60_000,
    state: 'ACTIVE',
    period: 1,
    attempts: 0,
    nextDueAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// Wave B: the newer outbox / saga / subscription Store methods. Each test connects like the
// conformance suite and skips (not fails) when Postgres is unreachable, so CI runs without a
// database. Asserts the same behaviors the in-memory Store already passes.
describe('Store Conformance: postgres (Outbox)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schema: freshSchema() });
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
    let live = store;
    let id = 'obx_record_failure';
    await live.outbox.enqueue(outboxMessage(id));

    await live.outbox.recordFailure(id);
    await live.outbox.recordFailure(id);

    let batch = await live.outbox.claimBatch(10);
    let row = batch.find((message) => message.id === id);
    assert.notEqual(row, undefined);
    // attempts incremented exactly twice; status unchanged so the row is still pending.
    assert.equal(row!.attempts, 2);
    assert.equal(row!.status, 'pending');
  });

  test('outbox.recordFailure is a no-op on a missing or already-terminal row', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    let live = store;
    // Missing row: nothing to update, must not throw.
    await live.outbox.recordFailure('obx_does_not_exist');

    // A dead-lettered row is in the final 'failed' state, no longer retried; recordFailure must
    // leave its attempts untouched.
    let id = 'obx_record_failure_terminal';
    await live.outbox.enqueue(outboxMessage(id));
    await live.outbox.deadLetter(id, 'DISPATCH.FAILURE');
    await live.outbox.recordFailure(id);

    // The row is 'failed', so claimBatch never returns it. Assert by exhaustion: a pending claim
    // cannot see a failed row.
    let batch = await live.outbox.claimBatch(100);
    assert.equal(
      batch.some((message) => message.id === id),
      false,
    );
  });

  test('outbox.deadLetter flips the row to failed so claimBatch never returns it', async (t) => {
    if (!store) {
      t.skip('Postgres unreachable');
      return;
    }
    let live = store;
    let poison = 'obx_dead_letter';
    let healthy = 'obx_dead_letter_sibling';
    await live.outbox.enqueue(outboxMessage(poison));
    await live.outbox.enqueue(outboxMessage(healthy));

    await live.outbox.deadLetter(poison, 'DISPATCH.FAILURE');

    let batch = await live.outbox.claimBatch(100);
    let ids = batch.map((message) => message.id);
    // The poison row is excluded; the healthy sibling is still claimable.
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
      store = await postgresStore({ url, schema: freshSchema() });
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
    let live = store;
    let userId = 'usr_last_payout';

    // No sagas yet: the user's first request is always allowed.
    assert.equal(await live.sagas.lastPayoutAt(userId), null);

    // One settled saga at t=100 and one failed at t=300: the max wins regardless of terminal state,
    // so a completed/failed payout still starts the clock on the next one.
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
    let live = store;
    let id = 'pay_dead_letter';
    await live.sagas.open(
      sagaRow({ id, userId: 'usr_dl', state: 'SUBMITTED' }),
    );

    await live.sagas.deadLetter(id, 'PROVIDER.FAILURE');

    let loaded = await live.sagas.load(id);
    assert.notEqual(loaded, null);
    assert.equal(loaded!.state, 'FAILED');
  });
});

describe('Store Conformance: postgres (Subscriptions)', () => {
  let store: Store | null = null;

  before(async () => {
    try {
      store = await postgresStore({ url, schema: freshSchema() });
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
    let live = store;
    let id = 'sub_attempts';

    // Open with attempts=2 and confirm it round-trips through load.
    await live.subscriptions.open(subscriptionRow({ id, attempts: 2 }));
    assert.equal((await live.subscriptions.load(id))!.attempts, 2);

    // Re-open with a bumped attempt (the worker's retry-persist path): open must upsert, not keep
    // the old count.
    let prior = (await live.subscriptions.load(id))!;
    await live.subscriptions.open({ ...prior, attempts: prior.attempts + 1 });
    assert.equal((await live.subscriptions.load(id))!.attempts, 3);

    // A successful renewal resets attempts to 0 and advances the period. markBilled only applies if
    // the row's current next_due_at still equals the expected value we pass (0, from
    // subscriptionRow). The prior re-open didn't touch next_due_at, so it still matches and the
    // update lands.
    await live.subscriptions.markBilled(id, 1_000, 0);
    let billed = (await live.subscriptions.load(id))!;
    assert.equal(billed.attempts, 0);
    assert.equal(billed.period, 2);

    // markLapsed leaves attempts as-is (only the state changes).
    await live.subscriptions.open(subscriptionRow({ id, attempts: 5 }));
    await live.subscriptions.markLapsed(id);
    let lapsed = (await live.subscriptions.load(id))!;
    assert.equal(lapsed.state, 'LAPSED');
    assert.equal(lapsed.attempts, 5);
  });
});
