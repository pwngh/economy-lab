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
 * Amount is an object, not a number, so two equal amounts are not the same reference. Money
 * checks therefore use `assert.deepEqual`, which compares by value, never `assert.equal`, which
 * compares by identity.
 */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { byCodeUnit } from '#src/bytes.ts';

import type { InboxEntry, Saga, SagaState, Store, Unit } from '#src/ports.ts';
import type { Operation, Transaction } from '#src/contract.ts';

// Fresh user id per call, so tests don't share balances or hash-chain history.
let userSeq = 0;
function freshUser(): string {
  userSeq += 1;
  return `usr_conf_${userSeq}`;
}

// Funds a user's spendable balance with one balanced posting. It credits the user and debits a
// platform account so the lines cancel to zero. Both accounts exist, so postEntry's
// known-account check passes.
async function fundSpendable(
  unit: Unit,
  userId: string,
  dollars: string,
  txnId: string,
): Promise<Transaction> {
  const amount = decodeAmount(dollars, 'CREDIT');
  return postEntry(unit.ledger, {
    txnId,
    legs: [credit(spendable(userId), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { source: 'card' },
  });
}

// Builds one outbox message. The caller passes a distinct message id so a test can assert which
// message it enqueued.
function outboxRow(
  userId: string,
  messageId: string,
): {
  id: string;
  event: {
    id: string;
    type: string;
    version: number;
    occurredAt: number;
    subject: string;
    data: Record<string, unknown>;
    audience: 'internal' | 'client';
  };
  status: 'pending';
  attempts: number;
  reason: string | null;
} {
  return {
    id: messageId,
    event: {
      id: `evt_${messageId}`,
      type: 'economy.credits.topped_up',
      version: 1,
      occurredAt: 0,
      subject: userId,
      data: {},
      audience: 'internal',
    },
    status: 'pending',
    attempts: 0,
    reason: null,
  };
}

// Builds one inbox row, a verified inbound event already mapped to the topUp it applies. This is
// the inbound mirror of `outboxRow`. `key` is the provider event id. That id is the dedupe key on
// enqueue and also doubles as the operation's idempotencyKey. The caller passes a distinct row id
// so a test can assert which row it enqueued.
function inboxRow(userId: string, rowId: string, key: string): InboxEntry {
  return {
    id: rowId,
    key,
    operation: {
      kind: 'topUp',
      idempotencyKey: key,
      actor: { kind: 'system', service: 'webhook:billing' },
      userId,
      amount: toAmount('CREDIT', 1_000n),
      source: 'card',
    } as Operation,
    status: 'pending',
    attempts: 0,
    receivedAt: 0,
    reason: null,
  };
}

async function appendRoundTripsBalance(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction((unit) =>
    fundSpendable(unit, userId, '5.00', 'txn_conf_balance'),
  );

  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 500n),
  );
}

async function commitsDurablyAndRollsBack(store: Store): Promise<void> {
  const committedUser = freshUser();
  const thrownUser = freshUser();
  await store.transaction((unit) =>
    fundSpendable(unit, committedUser, '3.00', 'txn_conf_durable'),
  );

  await assert.rejects(
    store.transaction(async (unit) => {
      await fundSpendable(unit, thrownUser, '9.00', 'txn_conf_rollback');
      throw new Error('abort the unit of work');
    }),
  );

  assert.deepEqual(
    await store.ledger.balance(spendable(committedUser)),
    toAmount('CREDIT', 300n),
  );
  assert.deepEqual(
    await store.ledger.balance(spendable(thrownUser)),
    toAmount('CREDIT', 0n),
  );
}

async function claimsOnceAndReplays(store: Store): Promise<void> {
  const userId = freshUser();
  const key = `idem_conf_${userId}`;

  const recorded = await store.transaction(async (unit) => {
    const first = await unit.idempotency.claim(key);
    assert.equal(first.claimed, true);
    const transaction = await fundSpendable(
      unit,
      userId,
      '2.00',
      'txn_conf_idem',
    );
    await unit.idempotency.record(key, transaction);
    return transaction;
  });

  const replay = await store.transaction((unit) => unit.idempotency.claim(key));

  assert.equal(replay.claimed, false);
  assert.deepEqual(
    (replay as { claimed: false; transaction: Transaction }).transaction,
    recorded,
  );
}

async function freesKeyOnRollback(store: Store): Promise<void> {
  const userId = freshUser();
  const key = `idem_conf_rollback_${userId}`;

  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.idempotency.claim(key);
      throw new Error('roll back before record');
    }),
  );

  const afterRollback = await store.transaction((unit) =>
    unit.idempotency.claim(key),
  );

  assert.equal(afterRollback.claimed, true);
}

async function grantsLocksWithoutDeadlock(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction(async (unit) => {
    await unit.ledger.lock(spendable(userId));
    await unit.ledger.lock(SYSTEM.REVENUE);
    await unit.ledger.lock(spendable(userId));
  });

  assert.equal(await store.ledger.hasAccount(spendable(userId)), true);
}

async function relaysOutboxOnce(store: Store): Promise<void> {
  const userId = freshUser();
  const messageId = `obx_conf_${userId}`;
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', 'txn_conf_outbox');
    await unit.outbox.enqueue(outboxRow(userId, messageId));
  });

  const batch = await store.outbox.claimBatch(10);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  const afterRelay = await store.outbox.claimBatch(10);

  assert.deepEqual(
    batch.map((message) => message.id),
    [messageId],
  );
  assert.deepEqual(afterRelay, []);
}

async function dropsOutboxOnRollback(store: Store): Promise<void> {
  const userId = freshUser();
  const messageId = `obx_conf_rollback_${userId}`;

  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.outbox.enqueue(outboxRow(userId, messageId));
      throw new Error('roll back the enqueue');
    }),
  );

  const batch = await store.outbox.claimBatch(100);

  assert.equal(
    batch.some((message) => message.id === messageId),
    false,
  );
}

// Pins the same retry-and-dead-letter behavior across adapters. This is the outbound twin of
// bumpsInboxAttemptThenDeadLetters. `recordFailure` counts one failed delivery: it bumps
// `attempts`, leaves the row 'pending', and records no reason yet. `deadLetter` then gives up on
// the poison message, flips it to 'dead', and persists the reason on the record so `claimBatch`
// never hands it back. Like the relay worker, recordFailure and deadLetter run on the top-level
// store, not inside store.transaction(...).
async function recordsFailureThenDeadLettersOutbox(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  const messageId = `obx_conf_dead_${userId}`;
  await store.transaction((unit) =>
    unit.outbox.enqueue(outboxRow(userId, messageId)),
  );

  // One failed delivery bumps attempts from 0 to 1. The row stays pending and is re-claimable. A
  // still-pending row carries no dead-letter reason yet.
  await store.outbox.recordFailure(messageId);
  const afterFail = await store.outbox.claimBatch(10);
  const failed = afterFail.find((message) => message.id === messageId);
  assert.notEqual(failed, undefined);
  assert.equal(failed!.attempts, 1);
  assert.equal(failed!.status, 'pending');
  assert.equal(failed!.reason, null);

  // Give up on the poison message by dead-lettering it, after which it is never claimed again. The
  // reason is persisted on the 'dead' record itself, not in a side-channel, mirroring the saga
  // terminal-outcome test. claimBatch never returns a terminal row, so this test cannot reload it
  // that way, but the SQL decoders carry dead_letter_reason through to reason off the row.
  await store.outbox.deadLetter(messageId, 'poison');
  const afterDead = await store.outbox.claimBatch(10);
  assert.equal(
    afterDead.some((message) => message.id === messageId),
    false,
  );

  // recordFailure, markRelayed, and deadLetter on the now-terminal row are all no-ops that do not
  // throw.
  await store.outbox.recordFailure(messageId);
  await store.outbox.markRelayed([messageId]);
  await store.outbox.deadLetter(messageId, 'again');
  const stillDead = await store.outbox.claimBatch(10);
  assert.equal(
    stillDead.some((message) => message.id === messageId),
    false,
  );
}

// Inbound mirror of relaysOutboxOnce. A verified event enqueued in the webhook's transaction is
// claimed once, marked applied, then never re-claimed. `claimInbound` hands back only 'pending'
// rows. `markApplied` flips the row to the terminal 'applied' state, so the second claim is empty.
// The inbox applies each event at most once, just as the outbox relays each at most once.
async function appliesInboxOnce(store: Store): Promise<void> {
  const userId = freshUser();
  const rowId = `ibx_conf_${userId}`;
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', 'txn_conf_inbox');
    await unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`));
  });

  const batch = await store.inbox.claimInbound({ now: 0, limit: 10 });
  await store.inbox.markApplied(rowId);
  const afterApply = await store.inbox.claimInbound({ now: 0, limit: 10 });

  assert.deepEqual(
    batch.map((entry) => entry.id),
    [rowId],
  );
  assert.deepEqual(afterApply, []);
}

// Inbound mirror of dropsOutboxOnRollback. An enqueue inside a transaction that throws leaves no
// inbox row, so a rolled-back webhook ingress never queues an apply. This is the same
// all-or-nothing contract the outbox holds for a rolled-back money move.
async function dropsInboxOnRollback(store: Store): Promise<void> {
  const userId = freshUser();
  const rowId = `ibx_conf_rollback_${userId}`;

  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`));
      throw new Error('roll back the enqueue');
    }),
  );

  const batch = await store.inbox.claimInbound({ now: 0, limit: 100 });

  assert.equal(
    batch.some((entry) => entry.id === rowId),
    false,
  );
}

// Pins the same dedupe-by-key behavior across adapters. Enqueuing the same provider event id
// twice inserts one row, and the duplicate enqueue returns that existing row, so a redelivered
// provider event is applied at most once. The two enqueues use different row ids but share one
// `key`. Only the first row id is ever stored or claimed.
async function dedupesInboxByKey(store: Store): Promise<void> {
  const userId = freshUser();
  const key = `evt_conf_dedupe_${userId}`;
  const firstId = `ibx_conf_dedupe_a_${userId}`;
  const secondId = `ibx_conf_dedupe_b_${userId}`;

  const first = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, firstId, key)),
  );
  // Redelivery uses the same provider event id with a fresh row id. It is a no-op that returns the
  // already-stored row.
  const duplicate = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, secondId, key)),
  );

  assert.equal(first.id, firstId);
  assert.equal(duplicate.id, firstId); // the existing row, not the second id
  assert.equal(duplicate.key, key);

  // Only the first row exists, so a claim returns exactly one entry, under the first id.
  const batch = await store.inbox.claimInbound({ now: 0, limit: 10 });
  const mine = batch.filter((entry) => entry.key === key);
  assert.deepEqual(
    mine.map((entry) => entry.id),
    [firstId],
  );
}

// Pins the same retry-and-dead-letter behavior across adapters. `bumpAttempt` counts one failed
// apply: it increments `attempts` but leaves the row 'pending', so the next sweep re-claims it. It
// never flips the status, since only `deadLetter` does that. `deadLetter` then gives up on the
// poison event and flips it to 'dead' so `claimInbound` never hands it back again. This is the
// inbound mirror of the outbox's recordFailure and deadLetter pair.
//
// bumpAttempt and deadLetter run on the top-level store, not inside store.transaction(...),
// matching how the apply worker calls them.
async function bumpsInboxAttemptThenDeadLetters(store: Store): Promise<void> {
  const userId = freshUser();
  const rowId = `ibx_conf_dead_${userId}`;
  await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`)),
  );

  // One failed apply bumps attempts from 0 to 1. The row stays pending and is re-claimable. A
  // still-pending row carries no dead-letter reason yet.
  await store.inbox.bumpAttempt(rowId);
  const afterBump = await store.inbox.claimInbound({ now: 0, limit: 10 });
  const bumped = afterBump.find((entry) => entry.id === rowId);
  assert.notEqual(bumped, undefined);
  assert.equal(bumped!.attempts, 1);
  assert.equal(bumped!.status, 'pending');
  assert.equal(bumped!.reason, null);

  // Give up on the poison event: dead-letter it, and it's never claimed again.
  await store.inbox.deadLetter(rowId, 'poison');
  const afterDead = await store.inbox.claimInbound({ now: 0, limit: 10 });
  assert.equal(
    afterDead.some((entry) => entry.id === rowId),
    false,
  );

  // The failure reason is persisted on the dead row itself, not in a side-channel, so re-resolving
  // the row by its key reads it back on every backend, mirroring the saga terminal-outcome test. A
  // duplicate enqueue on the same key returns the stored row, terminal status and all.
  const resolved = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`)),
  );
  assert.equal(resolved.status, 'dead');
  assert.equal(resolved.reason, 'poison');

  // markApplied, bumpAttempt, and deadLetter on the now-terminal row are all no-ops that do not
  // throw, so the first dead-letter reason stands. A second deadLetter('again') does not overwrite
  // it.
  await store.inbox.markApplied(rowId);
  await store.inbox.bumpAttempt(rowId);
  await store.inbox.deadLetter(rowId, 'again');
  const stillDead = await store.inbox.claimInbound({ now: 0, limit: 10 });
  assert.equal(
    stillDead.some((entry) => entry.id === rowId),
    false,
  );
  const stillResolved = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`)),
  );
  assert.equal(stillResolved.reason, 'poison');
}

async function recomputesChainHead(store: Store): Promise<void> {
  const userId = freshUser();
  const transaction = await store.transaction((unit) =>
    fundSpendable(unit, userId, '4.00', 'txn_conf_chain'),
  );

  const heads = new Map<string, string>();
  for await (const [account, head] of store.ledger.heads()) {
    heads.set(account, head);
  }
  const link = transaction.links.find(
    (candidate) => candidate.account === spendable(userId),
  );

  assert.notEqual(link, undefined);
  assert.equal(heads.get(spendable(userId)), link!.hash);
  assert.equal(link!.prevHash, '0'.repeat(64));
}

// Regression for a posting that touches the same account with two lines at once. SQL adapters
// insert one row per line keyed on (account, previous-hash). The second line for that account
// repeated the pair, and the insert rejected it. This test posts two credits into one user's
// spendable account, each matched by a debit so the posting still cancels to zero. Every store
// must accept it, sum both lines into one balance, and extend the account's hash chain by exactly
// one step. Pinned for all stores, not just whatever the `prove` fuzzer happens to generate.
async function storesMultipleLegsToOneAccount(store: Store): Promise<void> {
  const userId = freshUser();
  const first = decodeAmount('3.00', 'CREDIT');
  const second = decodeAmount('5.00', 'CREDIT');

  const transaction = await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: 'txn_conf_multileg',
      legs: [
        credit(spendable(userId), first),
        debit(SYSTEM.REVENUE, first),
        credit(spendable(userId), second),
        debit(SYSTEM.REVENUE, second),
      ],
      meta: { source: 'card' },
    }),
  );

  // Stored balance must equal both lines summed (3.00 + 5.00 = 8.00), proving neither was dropped.
  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 800n),
  );

  // The account's chain head must match the hash the posting reports: it grew by one step from the
  // all-zeros start, and the stored head equals that step's hash (same check as recomputesChainHead).
  const heads = new Map<string, string>();
  for await (const [account, head] of store.ledger.heads()) {
    heads.set(account, head);
  }
  const link = transaction.links.find(
    (candidate) => candidate.account === spendable(userId),
  );

  assert.notEqual(link, undefined);
  assert.equal(heads.get(spendable(userId)), link!.hash);
  assert.equal(link!.prevHash, '0'.repeat(64));
}

// Pins the same promo-grant behavior across adapters, covering three rules. First, opening the
// same grant twice leaves one row, because a repeat open by id is a no-op that does not overwrite.
// Second, claimDue returns a grant once its expiry is at or before `now`, oldest expiry first.
// Third, markReversed removes a grant from the due set and is a no-op if rerun on an
// already-reversed grant.
//
// claimDue and markReversed run on the top-level store, not inside store.transaction(...),
// matching how the background worker calls them.
async function reversesPromoGrantExactlyOnce(store: Store): Promise<void> {
  const userId = freshUser();
  const id = `txn_conf_promo_${userId}`;
  const grant = {
    id,
    userId,
    amount: toAmount('CREDIT', 500n),
    expiresAt: 1_000,
    reversed: false,
  };
  await store.transaction((unit) => unit.promos.open(grant));
  await store.transaction((unit) => unit.promos.open(grant)); // idempotent: still one row
  const due = await store.promos.claimDue(1_000, 10); // expiresAt <= now, inclusive
  assert.equal(due.length, 1);
  assert.equal(due[0]!.id, id);
  assert.deepEqual(due[0]!.amount, toAmount('CREDIT', 500n));
  await store.promos.markReversed(id);
  assert.deepEqual(await store.promos.claimDue(1_000, 10), []); // reversed, so never re-claimed
  await store.promos.markReversed(id); // no-op on already-reversed
}

// Pins claimDue's ordering and cap. "Oldest expiresAt first" holds across the whole table, since
// the rows are sorted before the limit is applied rather than returned in insertion order, and the
// cap is the literal `limit`. This test opens three grants newest first, then claimDue with limit 2
// returns the two oldest in ascending expiresAt.
async function claimsDuePromosOldestFirstUpToLimit(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, expiresAt: number) => ({
    id: `txn_conf_promo_order_${userId}_${suffix}`,
    userId,
    amount: toAmount('CREDIT', 100n),
    expiresAt,
    reversed: false,
  });
  const newest = mk('c', 3_000);
  const middle = mk('b', 2_000);
  const oldest = mk('a', 1_000);
  // Insert newest first so insertion order is the reverse of the required claim order.
  await store.transaction((unit) => unit.promos.open(newest));
  await store.transaction((unit) => unit.promos.open(middle));
  await store.transaction((unit) => unit.promos.open(oldest));

  const due = await store.promos.claimDue(5_000, 2);
  assert.deepEqual(
    due.map((grant) => grant.id),
    [oldest.id, middle.id],
  );
}

// SagaStore.list returns the whole payout board, meaning every saga regardless of state, newest
// `updatedAt` first. It is not limited to the due, in-progress sagas that claimDue hands the
// worker. This test opens three sagas out of updatedAt order (one settled, one failed, one in
// flight) and asserts list re-sorts them newest first. The result is filtered to this test's user
// so a future saga test sharing the store cannot perturb it.
async function listsSagasNewestFirst(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, updatedAt: number, state: SagaState): Saga => ({
    id: `pay_conf_list_${userId}_${suffix}`,
    userId,
    reserve: toAmount('CREDIT', 100n),
    rateId: 'rate_conf_list',
    state,
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: updatedAt,
    updatedAt,
    payoutUsd: null,
  });
  const oldest = mk('a', 1_000, 'SETTLED');
  const middle = mk('b', 2_000, 'FAILED');
  const newest = mk('c', 3_000, 'RESERVED');
  // Open out of updatedAt order so insertion order isn't the expected list order.
  await store.transaction((unit) => unit.sagas.open(middle));
  await store.transaction((unit) => unit.sagas.open(oldest));
  await store.transaction((unit) => unit.sagas.open(newest));

  const mine: string[] = [];
  for await (const saga of store.sagas.list()) {
    if (saga.userId === userId) {
      mine.push(saga.id);
    }
  }
  assert.deepEqual(mine, [newest.id, middle.id, oldest.id]);
}

// Pins the same terminal-outcome persistence across adapters. A payout's SETTLED or FAILED outcome
// is stored on the saga record itself, not in a side-channel, so a later load reads it back.
// `advance` to SETTLED carries the gross USD disbursed in its patch (payoutUsd, a USD Amount), and
// `deadLetter` records the failure reason. This test opens two sagas, drives one to each terminal
// state, and asserts load round-trips the stored outcome. It also asserts that a still-in-flight
// saga carries neither outcome field.
async function persistsTerminalOutcomeOnTheSaga(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, state: SagaState): Saga => ({
    id: `pay_conf_term_${userId}_${suffix}`,
    userId,
    reserve: toAmount('CREDIT', 400n),
    rateId: 'rate_conf_term',
    state,
    providerRef: 'prov_conf_term',
    reason: null,
    attempts: 1,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
  });
  const settling = mk('settle', 'SUBMITTED');
  const failing = mk('fail', 'SUBMITTED');
  await store.transaction((unit) => unit.sagas.open(settling));
  await store.transaction((unit) => unit.sagas.open(failing));

  // Before any terminal step, neither outcome field is set.
  const inflight = await store.sagas.load(settling.id);
  assert.equal(inflight!.reason, null);
  assert.equal(inflight!.payoutUsd, null);

  // SETTLED: the USD disbursed is persisted on the record, failure reason stays null.
  const paid = toAmount('USD', 2n);
  const advanced = await store.transaction((unit) =>
    unit.sagas.advance(settling.id, 'SUBMITTED', 'SETTLED', {
      updatedAt: 1,
      payoutUsd: paid,
    }),
  );
  assert.equal(advanced, true);
  const settled = await store.sagas.load(settling.id);
  assert.equal(settled!.state, 'SETTLED');
  assert.deepEqual(settled!.payoutUsd, paid);
  assert.equal(settled!.reason, null);

  // FAILED: the failure reason is persisted on the record, payoutUsd stays null.
  await store.transaction((unit) =>
    unit.sagas.deadLetter(failing.id, 'PROVIDER.FAILURE'),
  );
  const failed = await store.sagas.load(failing.id);
  assert.equal(failed!.state, 'FAILED');
  assert.equal(failed!.reason, 'PROVIDER.FAILURE');
  assert.equal(failed!.payoutUsd, null);
}

// Ledger.list returns the whole journal, meaning every committed posting, newest commit first. It
// is not limited to the postings a given reader minted, the same way SagaStore.list returns the
// whole payout board. This test funds three users with separate postings, then asserts list streams
// them back newest first. That order is the commit sequence, the reverse of the order they were
// appended, and each posting arrives with its full legs intact. The result is filtered to this
// test's txn ids so other postings already in the store cannot perturb it.
async function listsPostingsNewestFirst(store: Store): Promise<void> {
  const userId = freshUser();
  const ids = [
    `txn_conf_list_${userId}_a`,
    `txn_conf_list_${userId}_b`,
    `txn_conf_list_${userId}_c`,
  ];
  // Append in order a, b, c so insertion order isn't the expected list order (which is its reverse).
  for (const id of ids) {
    await store.transaction((unit) => fundSpendable(unit, userId, '1.00', id));
  }

  const mine: string[] = [];
  const legsById = new Map<string, number>();
  for await (const posting of store.ledger.list()) {
    if (ids.includes(posting.txnId)) {
      mine.push(posting.txnId);
      legsById.set(posting.txnId, posting.legs.length);
    }
  }
  // Newest commit first: the reverse of the append order.
  assert.deepEqual(mine, [ids[2], ids[1], ids[0]]);
  // Each posting carries its full legs (the funding posting has two), not just an id and meta.
  for (const id of ids) {
    assert.equal(legsById.get(id), 2);
  }
}

// Pins the same webhook-dedup behavior across adapters. An inbound provider webhook is processed
// at most once, even on redelivery. The replay store uses an atomic insert-if-absent on the event
// id. The first claim returns `{ claimed: true }`, which means process it, and later claims of the
// same id return `{ claimed: false }`, which means skip it. A different id is unaffected.
//
// claim runs on the top-level store, not inside store.transaction(...), since the webhook entry
// point checks it as a standalone final gate, not as part of a domain transaction.
async function claimsWebhookEventIdOnce(store: Store): Promise<void> {
  const eventId = `evt_replay_${freshUser()}`;
  const other = `evt_replay_${freshUser()}`;

  const first = await store.replay.claim(eventId);
  const second = await store.replay.claim(eventId);
  const different = await store.replay.claim(other);

  assert.equal(first.claimed, true); // first sighting wins
  assert.equal(second.claimed, false); // redelivery of the same id is a no-op
  assert.equal(different.claimed, true); // an unrelated id is unaffected
}

// Pins the same behavior across adapters for `balanceAccounts`, which lists every account that has
// a cached running-balance row. The cache lets reads skip re-summing entries. Entries remain the
// source of truth, so a cached row can be wrong or even orphaned with no entries behind it. Every
// account with a cached row must appear, which lets the integrity checker inspect rows that walking
// `heads()` (accounts with entries) would miss, such as a stale row with no posting behind it.
// Funding a fresh user creates its cached row, so that user must appear.
async function balanceAccountsEnumeratesBalanceRow(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '6.00', 'txn_conf_balacct'),
  );

  const seen = new Set<string>();
  for await (const account of store.ledger.balanceAccounts()) {
    seen.add(account);
  }

  assert.equal(seen.has(spendable(userId)), true);
}

// Pins the same order across adapters for `balanceAccounts`. Every engine lists accounts in one
// locale-independent code-unit order, not the database's collation or a Map's insertion order, so a
// caller and the integrity drift report see identical ordering everywhere. This test funds users
// whose ids are created out of order, then asserts the whole listing comes back in code-unit order.
async function balanceAccountsListsInCodeUnitOrder(
  store: Store,
): Promise<void> {
  const base = freshUser();
  const ids = [`${base}_c`, `${base}_a`, `${base}_b`];
  for (const id of ids) {
    await store.transaction((unit) =>
      fundSpendable(unit, id, '1.00', `txn_conf_ord_${id}`),
    );
  }

  const seen: string[] = [];
  for await (const account of store.ledger.balanceAccounts()) {
    seen.push(account);
  }

  for (const id of ids) {
    assert.equal(seen.includes(spendable(id)), true);
  }
  // Already sorted on every engine: equal to its own code-unit-sorted copy.
  assert.deepEqual(seen, [...seen].sort(byCodeUnit));
}

// Pins the same markBilled behavior across adapters, which stops two concurrent renewal sweeps
// from charging a subscription twice in one period. markBilled updates the row only if the caller's
// expected due date still matches next_due_at. The first sweeper passes the current due date, so
// its update applies: it returns true and advances the due date. A second sweeper starting from the
// now-stale due date matches no row and does nothing, returning false. The net result is that the
// subscription is billed at most once per period.
async function markBilledIsCompareAndSet(store: Store): Promise<void> {
  const userId = freshUser();
  const id = `sub_conf_cas_${userId}`;
  const firstDue = 1_000;
  const secondDue = 2_000;
  const thirdDue = 3_000;

  await store.transaction((unit) =>
    unit.subscriptions.open({
      id,
      userId,
      sellerId: freshUser(),
      sku: `sku_conf_cas_${userId}`,
      price: toAmount('CREDIT', 100n),
      periodMs: 1_000,
      state: 'ACTIVE',
      period: 0,
      attempts: 0,
      nextDueAt: firstDue,
      updatedAt: 0,
    }),
  );

  // Winning sweeper claimed next_due_at=firstDue and bills with that expected value.
  const won = await store.subscriptions.markBilled(id, secondDue, firstDue);
  assert.equal(won, true);

  // Second sweeper also claimed firstDue, but the row has advanced to secondDue, so its
  // conditional update matches no row and bills nothing.
  const lost = await store.subscriptions.markBilled(id, thirdDue, firstDue);
  assert.equal(lost, false);

  // The losing call changed nothing: next_due_at is still secondDue, not thirdDue.
  const reloaded = await store.subscriptions.load(id);
  assert.equal(reloaded!.nextDueAt, secondDue);
}

/**
 * Registers the shared tests every Store implementation (in-memory and each db-backed adapter)
 * must pass. Each adapter calls this once with its name and a factory, holding all adapters to
 * the same behavior.
 *
 * @param name - Label for this adapter, used in the test group title.
 * @param makeStore - Builds a fresh Store to run the tests against.
 */
export function runStoreConformance(
  name: string,
  makeStore: () => Promise<Store> | Store,
): void {
  describe(`Store Conformance: ${name}`, () => {
    // The backend may be unreachable, for example in CI's no-services `check` job or with a missing
    // local database. Probe it once here. If makeStore throws, every test below skips, rather than
    // this before hook throwing and canceling the whole suite. That is the graceful contract the
    // standalone describes use, and the one ci.yml's `check` job relies on ("conformance tests skip
    // when no backend reachable").
    let store: Store | null = null;
    let unreachable = 'backend unreachable';

    before(async () => {
      try {
        store = await makeStore();
      } catch (error) {
        store = null;
        // Keep the probe's graceful-skip contract, but name the reason: a silent skip reads as
        // "no backend configured" even when the real cause is a provisioning failure.
        unreachable = `backend unreachable: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    after(async () => {
      if (store) {
        await store.close();
      }
    });

    // Run one conformance body against the live store, or skip when the backend was unreachable.
    const withStore = (
      t: TestContext,
      body: (s: Store) => Promise<void> | void,
    ): Promise<void> | void =>
      store ? body(store) : t.skip(`${name} ${unreachable}`);

    test('appends a posting and round-trips the balance as a bigint Amount', (t) =>
      withStore(t, appendRoundTripsBalance));
    test('commits a transaction durably and leaves no trace when one throws', (t) =>
      withStore(t, commitsDurablyAndRollsBack));
    test('claims an idempotency key once and replays the recorded transaction', (t) =>
      withStore(t, claimsOnceAndReplays));
    test('frees an idempotency key when its claiming transaction rolls back', (t) =>
      withStore(t, freesKeyOnRollback));
    test('grants account locks without deadlocking', (t) =>
      withStore(t, grantsLocksWithoutDeadlock));
    test('enqueues the outbox in the posting tx and relays once with consumer dedup', (t) =>
      withStore(t, relaysOutboxOnce));
    test('drops the outbox row when its enqueuing transaction rolls back', (t) =>
      withStore(t, dropsOutboxOnRollback));
    test('records an outbox delivery failure then dead-letters a poison message', (t) =>
      withStore(t, recordsFailureThenDeadLettersOutbox));
    test('enqueues the inbox in the webhook tx and applies once, never re-claiming', (t) =>
      withStore(t, appliesInboxOnce));
    test('drops the inbox row when its enqueuing transaction rolls back', (t) =>
      withStore(t, dropsInboxOnRollback));
    test('dedupes the inbox by provider event id, returning the existing row', (t) =>
      withStore(t, dedupesInboxByKey));
    test('bumps an inbox apply attempt then dead-letters a poison event', (t) =>
      withStore(t, bumpsInboxAttemptThenDeadLetters));
    test('recomputes a per-account chain head deterministically over the digest', (t) =>
      withStore(t, recomputesChainHead));
    test('stores a posting with multiple debit/credit lines to one account', (t) =>
      withStore(t, storesMultipleLegsToOneAccount));
    test('reverses a promo grant exactly once after it is due', (t) =>
      withStore(t, reversesPromoGrantExactlyOnce));
    test('claims due promo grants oldest first up to the limit', (t) =>
      withStore(t, claimsDuePromosOldestFirstUpToLimit));
    test('claims a webhook event id once and dedups every redelivery', (t) =>
      withStore(t, claimsWebhookEventIdOnce));
    test('enumerates an account that has a stored balance row', (t) =>
      withStore(t, balanceAccountsEnumeratesBalanceRow));
    test('lists balance-row accounts in code-unit order on every engine', (t) =>
      withStore(t, balanceAccountsListsInCodeUnitOrder));
    test('bills a subscription via compare-and-set so a stale renewal run is rejected', (t) =>
      withStore(t, markBilledIsCompareAndSet));
    test('lists every saga newest-first regardless of state', (t) =>
      withStore(t, listsSagasNewestFirst));
    test('persists a payout terminal outcome (settled USD / failed reason) on the saga', (t) =>
      withStore(t, persistsTerminalOutcomeOnTheSaga));
    test('lists every posting newest-first with its full legs', (t) =>
      withStore(t, listsPostingsNewestFirst));
  });
}
