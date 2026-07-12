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

/** Amount is an object: money checks use `assert.deepEqual` (by value), never `assert.equal` (by identity). */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { byCodeUnit } from '#src/bytes.ts';

import type {
  Checkpoint,
  InboxEntry,
  Movement,
  OutboxMessage,
  Saga,
  SagaState,
  Store,
  Unit,
} from '#src/ports.ts';
import type { Operation, Transaction } from '#src/contract.ts';

// Fresh user id per call, so tests don't share balances or hash-chain history.
let userSeq = 0;
function freshUser(): string {
  userSeq += 1;
  return `usr_conf_${userSeq}`;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

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

function outboxRow(userId: string, messageId: string): OutboxMessage {
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

// `key` is both the dedupe key on enqueue and the operation's idempotencyKey.
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

async function derivesBalancesFromLegs(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '5.00', `txn_conf_derived_a_${userId}`);
    await fundSpendable(unit, userId, '2.50', `txn_conf_derived_b_${userId}`);
  });

  assert.deepEqual(await store.ledger.derivedBalances(spendable(userId)), [
    toAmount('CREDIT', 750n),
  ]);
  assert.deepEqual(await store.ledger.derivedBalances(spendable(userId)), [
    await store.ledger.balance(spendable(userId)),
  ]);

  // An account with no legs derives to nothing, not a zero row.
  assert.deepEqual(
    await store.ledger.derivedBalances(spendable(freshUser())),
    [],
  );
}

async function pairsHeadsWithRawSums(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '5.00', `txn_conf_headsum_a_${userId}`);
    await fundSpendable(unit, userId, '2.50', `txn_conf_headsum_b_${userId}`);
  });

  const heads = new Map(await collect(store.ledger.heads()));
  let found = 0;
  for await (const [account, head, sum] of store.ledger.headSums()) {
    assert.equal(head, heads.get(account));
    if (account === spendable(userId)) {
      found += 1;
      assert.equal(sum, -750n);
    }
  }
  assert.equal(found, 1);
}

async function roundTripsCheckpointRows(store: Store): Promise<void> {
  // A v1 row (no sum) and a v2 row cover the schema evolution.
  const v1: Checkpoint = {
    id: 'chk_conf_v1',
    root: 'a'.repeat(64),
    signature: 'bb'.repeat(32),
    count: 2,
    at: 1_000,
    v: 1,
    sum: null,
  };
  const v2: Checkpoint = {
    id: 'chk_conf_v2',
    root: 'c'.repeat(64),
    signature: 'dd'.repeat(32),
    count: 3,
    at: 2_000,
    v: 2,
    sum: '0',
  };

  await store.checkpoints.put(v1);
  assert.deepEqual(await store.checkpoints.latest(), v1);

  await store.checkpoints.put(v2);
  assert.deepEqual(await store.checkpoints.latest(), v2);
}

async function grantsOwnsRevokesEntitlements(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction((unit) =>
    unit.entitlements.grant(userId, 'sku_conf_a', {}),
  );
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_a'), true);
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_b'), false);

  await store.transaction((unit) =>
    unit.entitlements.revoke(userId, 'sku_conf_a'),
  );
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_a'), false);

  await store.transaction((unit) =>
    unit.entitlements.grant(userId, 'sku_conf_a', {}),
  );
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_a'), true);
}

async function appliesExpiryAtReadTime(store: Store): Promise<void> {
  const userId = freshUser();

  // Clock-agnostic on purpose: the SQL conformance drivers run on the real clock while memory
  // runs at 0, so the rows use a far future (owned either way), a negative past (lapsed either
  // way), and null (never lapses). The INCLUSIVE boundary (owned while now <= expiresAt) is
  // pinned separately under a controlled clock in test/adapters/entitlement-bitset.test.ts.
  await store.transaction(async (unit) => {
    await unit.entitlements.grant(userId, 'sku_conf_future', {
      expiresAt: 8.64e15,
    });
    await unit.entitlements.grant(userId, 'sku_conf_past', { expiresAt: -1 });
    await unit.entitlements.grant(userId, 'sku_conf_forever', {
      expiresAt: null,
    });
  });

  assert.equal(await store.entitlements.owns(userId, 'sku_conf_future'), true);
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_past'), false);
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_forever'), true);
}

async function listsNonRevokedGrantsSorted(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction(async (unit) => {
    await unit.entitlements.grant(userId, 'sku_conf_z', {});
    await unit.entitlements.grant(userId, 'sku_conf_a', { expiresAt: -5 });
    await unit.entitlements.grant(userId, 'sku_conf_m', {});
    await unit.entitlements.revoke(userId, 'sku_conf_m');
  });

  const grants = await collect(store.entitlements.list(userId));
  // sku order is identical on every engine.
  assert.deepEqual(grants, [
    { sku: 'sku_conf_a', expiresAt: -5 },
    { sku: 'sku_conf_z', expiresAt: null },
  ]);
}

function movementRow(
  sessionId: string,
  seq: number,
  idempotencyKey: string,
): Movement {
  const amount = toAmount('CREDIT', 250n);
  return {
    sessionId,
    seq,
    idempotencyKey,
    legs: [
      debit(spendable('usr_conf_viewer'), amount),
      credit(spendable('usr_conf_creator'), amount),
    ],
    prevHash: '0'.repeat(64),
    hash: `${seq}`.padStart(64, 'f'),
    recordedAt: seq,
  };
}

async function journalAppendsAndStreamsBySession(store: Store): Promise<void> {
  const sessionId = `sess_conf_a_${freshUser()}`;
  await store.movements.append([
    movementRow(sessionId, 0, `${sessionId}_m0`),
    movementRow(sessionId, 1, `${sessionId}_m1`),
  ]);
  await store.movements.append([movementRow(sessionId, 2, `${sessionId}_m2`)]);

  const rows = await collect(store.movements.bySession(sessionId));
  assert.deepEqual(
    rows,
    [0, 1, 2].map((seq) => movementRow(sessionId, seq, `${sessionId}_m${seq}`)),
  );
}

async function journalRejectsDuplicateBatches(store: Store): Promise<void> {
  const sessionId = `sess_conf_b_${freshUser()}`;
  await store.movements.append([movementRow(sessionId, 0, `${sessionId}_m0`)]);

  await assert.rejects(
    store.movements.append([
      movementRow(sessionId, 1, `${sessionId}_m1`),
      movementRow(sessionId, 2, `${sessionId}_m0`),
    ]),
  );
  await assert.rejects(
    store.movements.append([movementRow(sessionId, 0, `${sessionId}_m3`)]),
  );

  const rows = await collect(store.movements.bySession(sessionId));
  assert.equal(rows.length, 1);
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

// Outbound twin of bumpsInboxAttemptThenDeadLetters. Like the relay worker, recordFailure and
// deadLetter run on the top-level store, not inside store.transaction(...).
async function recordsFailureThenDeadLettersOutbox(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  const messageId = `obx_conf_dead_${userId}`;
  await store.transaction((unit) =>
    unit.outbox.enqueue(outboxRow(userId, messageId)),
  );

  await store.outbox.recordFailure(messageId);
  const afterFail = await store.outbox.claimBatch(10);
  const failed = afterFail.find((message) => message.id === messageId);
  assert.notEqual(failed, undefined);
  assert.equal(failed!.attempts, 1);
  assert.equal(failed!.status, 'pending');
  assert.equal(failed!.reason, null);

  // The reason is persisted on the 'dead' record itself, not a side-channel; claimBatch never
  // returns a terminal row, but the SQL decoders still carry it.
  await store.outbox.deadLetter(messageId, 'poison');
  const afterDead = await store.outbox.claimBatch(10);
  assert.equal(
    afterDead.some((message) => message.id === messageId),
    false,
  );

  await store.outbox.recordFailure(messageId);
  await store.outbox.markRelayed([messageId]);
  await store.outbox.deadLetter(messageId, 'again');
  const stillDead = await store.outbox.claimBatch(10);
  assert.equal(
    stillDead.some((message) => message.id === messageId),
    false,
  );
}

// claimInbound returns only 'pending' rows; 'applied' is terminal.
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

async function dedupesInboxByKey(store: Store): Promise<void> {
  const userId = freshUser();
  const key = `evt_conf_dedupe_${userId}`;
  const firstId = `ibx_conf_dedupe_a_${userId}`;
  const secondId = `ibx_conf_dedupe_b_${userId}`;

  const first = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, firstId, key)),
  );
  const duplicate = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, secondId, key)),
  );

  assert.equal(first.id, firstId);
  assert.equal(duplicate.id, firstId);
  assert.equal(duplicate.key, key);

  const batch = await store.inbox.claimInbound({ now: 0, limit: 10 });
  const mine = batch.filter((entry) => entry.key === key);
  assert.deepEqual(
    mine.map((entry) => entry.id),
    [firstId],
  );
}

// bumpAttempt and deadLetter run on the top-level store, not inside store.transaction(...),
// matching how the apply worker calls them.
async function bumpsInboxAttemptThenDeadLetters(store: Store): Promise<void> {
  const userId = freshUser();
  const rowId = `ibx_conf_dead_${userId}`;
  await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`)),
  );

  await store.inbox.bumpAttempt(rowId);
  const afterBump = await store.inbox.claimInbound({ now: 0, limit: 10 });
  const bumped = afterBump.find((entry) => entry.id === rowId);
  assert.notEqual(bumped, undefined);
  assert.equal(bumped!.attempts, 1);
  assert.equal(bumped!.status, 'pending');
  assert.equal(bumped!.reason, null);

  await store.inbox.deadLetter(rowId, 'poison');
  const afterDead = await store.inbox.claimInbound({ now: 0, limit: 10 });
  assert.equal(
    afterDead.some((entry) => entry.id === rowId),
    false,
  );

  // A duplicate enqueue on the same key returns the stored row, terminal status and all.
  const resolved = await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`)),
  );
  assert.equal(resolved.status, 'dead');
  assert.equal(resolved.reason, 'poison');

  // Terminal-row operations are no-ops; a second deadLetter does not overwrite the first reason.
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

  const heads = new Map(await collect(store.ledger.heads()));
  const link = transaction.links.find(
    (candidate) => candidate.account === spendable(userId),
  );

  assert.notEqual(link, undefined);
  assert.equal(heads.get(spendable(userId)), link!.hash);
  assert.equal(link!.prevHash, '0'.repeat(64));
}

// Regression: a posting with two lines to one account once collided on the SQL adapters'
// (account, prev_hash) key. Every store must accept it, sum both lines into one balance, and
// extend the chain by exactly one step.
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

  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 800n),
  );

  const heads = new Map(await collect(store.ledger.heads()));
  const link = transaction.links.find(
    (candidate) => candidate.account === spendable(userId),
  );

  assert.notEqual(link, undefined);
  assert.equal(heads.get(spendable(userId)), link!.hash);
  assert.equal(link!.prevHash, '0'.repeat(64));
}

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

// claimDue sorts by expiresAt before applying the limit, so "oldest first" holds across the whole
// table, not per insertion order.
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

// Each test's local `mk` overrides only the fields whose behavior it pins.
function sagaRow(id: string, userId: string, overrides: Partial<Saga>): Saga {
  return {
    id,
    userId,
    reserve: toAmount('CREDIT', 100n),
    rateId: 'rate_conf',
    state: 'SUBMITTED',
    providerRef: null,
    reason: null,
    attempts: 0,
    dueAt: 0,
    updatedAt: 0,
    payoutUsd: null,
    ...overrides,
  };
}

// SagaStore.list returns the whole payout board (every state, newest updatedAt first), not the
// due set claimDue hands the worker. Filtered to this test's user because the store is shared.
async function listsSagasNewestFirst(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, updatedAt: number, state: SagaState): Saga =>
    sagaRow(`pay_conf_list_${userId}_${suffix}`, userId, {
      state,
      dueAt: updatedAt,
      updatedAt,
    });
  const oldest = mk('a', 1_000, 'SETTLED');
  const middle = mk('b', 2_000, 'FAILED');
  const newest = mk('c', 3_000, 'RESERVED');
  // Open out of updatedAt order so insertion order isn't the expected list order.
  await store.transaction((unit) => unit.sagas.open(middle));
  await store.transaction((unit) => unit.sagas.open(oldest));
  await store.transaction((unit) => unit.sagas.open(newest));

  const mine = (await collect(store.sagas.list()))
    .filter((saga) => saga.userId === userId)
    .map((saga) => saga.id);
  assert.deepEqual(mine, [newest.id, middle.id, oldest.id]);
}

// findByProviderRef is the inbound-webhook lookup: a provider callback names a payout by the
// rail's reference, never the saga id.
async function findsSagaByProviderRef(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (
    suffix: string,
    providerRef: string | null,
    updatedAt: number,
  ): Saga =>
    sagaRow(`pay_conf_ref_${userId}_${suffix}`, userId, {
      providerRef,
      dueAt: updatedAt,
      updatedAt,
    });
  const target = mk('a', `prov_${userId}_a`, 1_000);
  const other = mk('b', `prov_${userId}_b`, 2_000);
  const unsubmitted = mk('c', null, 3_000);
  await store.transaction((unit) => unit.sagas.open(target));
  await store.transaction((unit) => unit.sagas.open(other));
  await store.transaction((unit) => unit.sagas.open(unsubmitted));

  const found = await store.sagas.findByProviderRef(target.providerRef!);
  assert.equal(found?.id, target.id);
  assert.equal(
    await store.sagas.findByProviderRef(`prov_${userId}_none`),
    null,
  );

  // A duplicated ref resolves to the newest updatedAt, deterministically on every backend.
  const duplicate = mk('d', target.providerRef, 5_000);
  await store.transaction((unit) => unit.sagas.open(duplicate));
  const newest = await store.sagas.findByProviderRef(target.providerRef!);
  assert.equal(newest?.id, duplicate.id);
}

// A payout's terminal outcome lives on the saga record itself, not a side-channel: advance to
// SETTLED carries payoutUsd in its patch, deadLetter records the failure reason.
async function persistsTerminalOutcomeOnTheSaga(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, state: SagaState): Saga =>
    sagaRow(`pay_conf_term_${userId}_${suffix}`, userId, {
      state,
      attempts: 1,
    });
  const settling = mk('settle', 'SUBMITTED');
  const failing = mk('fail', 'SUBMITTED');
  await store.transaction((unit) => unit.sagas.open(settling));
  await store.transaction((unit) => unit.sagas.open(failing));

  const inflight = await store.sagas.load(settling.id);
  assert.equal(inflight!.reason, null);
  assert.equal(inflight!.payoutUsd, null);

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

  await store.transaction((unit) =>
    unit.sagas.deadLetter(failing.id, 'PROVIDER.FAILURE'),
  );
  const failed = await store.sagas.load(failing.id);
  assert.equal(failed!.state, 'FAILED');
  assert.equal(failed!.reason, 'PROVIDER.FAILURE');
  assert.equal(failed!.payoutUsd, null);
}

// Ledger.list returns the whole journal, newest commit first, with each posting's full legs.
// Filtered to this test's txn ids because the store is shared.
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

  const mine = (await collect(store.ledger.list())).filter((posting) =>
    ids.includes(posting.txnId),
  );
  assert.deepEqual(
    mine.map((posting) => posting.txnId),
    [ids[2], ids[1], ids[0]],
  );
  // Each posting carries its full legs (the funding posting has two), not just an id and meta.
  for (const posting of mine) {
    assert.equal(posting.legs.length, 2);
  }
}

// claim runs on the top-level store, not inside store.transaction(...), since the webhook entry
// point checks it as a standalone final gate, not as part of a domain transaction.
async function claimsWebhookEventIdOnce(store: Store): Promise<void> {
  const eventId = `evt_replay_${freshUser()}`;
  const other = `evt_replay_${freshUser()}`;

  const first = await store.replay.claim(eventId);
  const second = await store.replay.claim(eventId);
  const different = await store.replay.claim(other);

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(different.claimed, true);
}

// balanceAccounts lists every account with a cached balance row, including orphans with no legs
// behind them — rows the integrity checker must see but heads() (accounts with entries) would miss.
async function balanceAccountsEnumeratesBalanceRow(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '6.00', 'txn_conf_balacct'),
  );

  const seen = await collect(store.ledger.balanceAccounts());

  assert.equal(seen.includes(spendable(userId)), true);
}

// Every engine lists accounts in locale-independent code-unit order, not the database's collation
// or a Map's insertion order, so the integrity drift report sees identical ordering everywhere.
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

  const seen = await collect(store.ledger.balanceAccounts());

  for (const id of ids) {
    assert.equal(seen.includes(spendable(id)), true);
  }
  assert.deepEqual(seen, [...seen].sort(byCodeUnit));
}

// markBilled is a compare-and-set on next_due_at, so two concurrent renewal sweeps cannot bill
// one period twice.
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

  const won = await store.subscriptions.markBilled(id, secondDue, firstDue);
  assert.equal(won, true);

  const lost = await store.subscriptions.markBilled(id, thirdDue, firstDue);
  assert.equal(lost, false);

  const reloaded = await store.subscriptions.load(id);
  assert.equal(reloaded!.nextDueAt, secondDue);
}

/** Registers the shared conformance tests every Store implementation must pass; each adapter calls this once with a factory. */
export function runStoreConformance(
  name: string,
  makeStore: () => Promise<Store> | Store,
): void {
  describe(`Store Conformance: ${name}`, () => {
    // Probe once: if makeStore throws, every test below skips rather than the before hook failing
    // the suite — the connect-or-skip contract ci.yml's no-services `check` job relies on.
    let store: Store | null = null;
    let unreachable = 'backend unreachable';

    before(async () => {
      try {
        store = await makeStore();
      } catch (error) {
        store = null;
        // Name the reason: a silent skip disguises a provisioning failure as "no backend configured".
        unreachable = `backend unreachable: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    after(async () => {
      if (store) {
        await store.close();
      }
    });

    const withStore = (
      t: TestContext,
      body: (s: Store) => Promise<void> | void,
    ): Promise<void> | void =>
      store ? body(store) : t.skip(`${name} ${unreachable}`);

    test('appends a posting and round-trips the balance as a bigint Amount', (t) =>
      withStore(t, appendRoundTripsBalance));
    test('re-derives per-currency balances from the legs alone', (t) =>
      withStore(t, derivesBalancesFromLegs));
    test('pairs every chain head with its raw leg sum', (t) =>
      withStore(t, pairsHeadsWithRawSums));
    test('round-trips v1 and v2 checkpoint rows through the store', (t) =>
      withStore(t, roundTripsCheckpointRows));
    test('grants, checks, revokes, and regrants entitlements', (t) =>
      withStore(t, grantsOwnsRevokesEntitlements));
    test('applies entitlement expiry at read time', (t) =>
      withStore(t, appliesExpiryAtReadTime));
    test('lists non-revoked entitlement grants sorted by sku', (t) =>
      withStore(t, listsNonRevokedGrantsSorted));
    test('appends movement batches and streams them back by session', (t) =>
      withStore(t, journalAppendsAndStreamsBySession));
    test('rejects a movement batch on a duplicate key or position', (t) =>
      withStore(t, journalRejectsDuplicateBatches));
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
    test('finds a saga by provider ref, newest first on a duplicated ref', (t) =>
      withStore(t, findsSagaByProviderRef));
    test('lists every posting newest-first with its full legs', (t) =>
      withStore(t, listsPostingsNewestFirst));
  });
}
