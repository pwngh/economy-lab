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
 * Amount is an object, not a number, so equal amounts aren't the same reference. Money checks
 * use `assert.deepEqual` (value), never `assert.equal` (identity).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';

import type { Store, Unit } from '#src/ports.ts';
import type { Transaction } from '#src/contract.ts';

// Fresh user id per call, so tests don't share balances or hash-chain history.
let userSeq = 0;
function freshUser(): string {
  userSeq += 1;
  return `usr_conf_${userSeq}`;
}

// Funds a user's spendable balance with one balanced posting: credit the user, debit a
// platform account so the lines cancel to zero. Both accounts exist, so postEntry's
// known-account check passes.
async function fundSpendable(
  unit: Unit,
  userId: string,
  dollars: string,
  txnId: string,
): Promise<Transaction> {
  let amount = decodeAmount(dollars, 'CREDIT');
  return postEntry(unit.ledger, {
    txnId,
    legs: [credit(spendable(userId), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { source: 'card' },
  });
}

// Builds one outbox message. Caller passes a distinct message id so a test can assert
// which message it enqueued.
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
  };
}

async function appendRoundTripsBalance(store: Store): Promise<void> {
  let userId = freshUser();

  await store.transaction((unit) =>
    fundSpendable(unit, userId, '5.00', 'txn_conf_balance'),
  );

  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 500n),
  );
}

async function commitsDurablyAndRollsBack(store: Store): Promise<void> {
  let committedUser = freshUser();
  let thrownUser = freshUser();
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
  let userId = freshUser();
  let key = `idem_conf_${userId}`;

  let recorded = await store.transaction(async (unit) => {
    let first = await unit.idempotency.claim(key);
    assert.equal(first.claimed, true);
    let transaction = await fundSpendable(
      unit,
      userId,
      '2.00',
      'txn_conf_idem',
    );
    await unit.idempotency.record(key, transaction);
    return transaction;
  });

  let replay = await store.transaction((unit) => unit.idempotency.claim(key));

  assert.equal(replay.claimed, false);
  assert.deepEqual(
    (replay as { claimed: false; transaction: Transaction }).transaction,
    recorded,
  );
}

async function freesKeyOnRollback(store: Store): Promise<void> {
  let userId = freshUser();
  let key = `idem_conf_rollback_${userId}`;

  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.idempotency.claim(key);
      throw new Error('roll back before record');
    }),
  );

  let afterRollback = await store.transaction((unit) =>
    unit.idempotency.claim(key),
  );

  assert.equal(afterRollback.claimed, true);
}

async function grantsLocksWithoutDeadlock(store: Store): Promise<void> {
  let userId = freshUser();

  await store.transaction(async (unit) => {
    await unit.ledger.lock(spendable(userId));
    await unit.ledger.lock(SYSTEM.REVENUE);
    await unit.ledger.lock(spendable(userId));
  });

  assert.equal(await store.ledger.hasAccount(spendable(userId)), true);
}

async function relaysOutboxOnce(store: Store): Promise<void> {
  let userId = freshUser();
  let messageId = `obx_conf_${userId}`;
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', 'txn_conf_outbox');
    await unit.outbox.enqueue(outboxRow(userId, messageId));
  });

  let batch = await store.outbox.claimBatch(10);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  let afterRelay = await store.outbox.claimBatch(10);

  assert.deepEqual(
    batch.map((message) => message.id),
    [messageId],
  );
  assert.deepEqual(afterRelay, []);
}

async function dropsOutboxOnRollback(store: Store): Promise<void> {
  let userId = freshUser();
  let messageId = `obx_conf_rollback_${userId}`;

  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.outbox.enqueue(outboxRow(userId, messageId));
      throw new Error('roll back the enqueue');
    }),
  );

  let batch = await store.outbox.claimBatch(100);

  assert.equal(
    batch.some((message) => message.id === messageId),
    false,
  );
}

async function recomputesChainHead(store: Store): Promise<void> {
  let userId = freshUser();
  let transaction = await store.transaction((unit) =>
    fundSpendable(unit, userId, '4.00', 'txn_conf_chain'),
  );

  let heads = new Map<string, string>();
  for await (let [account, head] of store.ledger.heads()) {
    heads.set(account, head);
  }
  let link = transaction.links.find(
    (candidate) => candidate.account === spendable(userId),
  );

  assert.notEqual(link, undefined);
  assert.equal(heads.get(spendable(userId)), link!.hash);
  assert.equal(link!.prevHash, '0'.repeat(64));
}

// Regression: a posting that touches the same account with two lines at once. SQL adapters
// insert one row per line keyed on (account, previous-hash); the second line for that account
// repeats the pair and the insert rejected it. Posts two credits into one user's spendable
// account, each matched by a debit so the posting still cancels to zero. Every store must accept
// it, sum both lines into one balance, and extend the account's hash chain by exactly one step.
// Pinned for all stores, not just whatever the `prove` fuzzer generates.
async function storesMultipleLegsToOneAccount(store: Store): Promise<void> {
  let userId = freshUser();
  let first = decodeAmount('3.00', 'CREDIT');
  let second = decodeAmount('5.00', 'CREDIT');

  let transaction = await store.transaction((unit) =>
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
  let heads = new Map<string, string>();
  for await (let [account, head] of store.ledger.heads()) {
    heads.set(account, head);
  }
  let link = transaction.links.find(
    (candidate) => candidate.account === spendable(userId),
  );

  assert.notEqual(link, undefined);
  assert.equal(heads.get(spendable(userId)), link!.hash);
  assert.equal(link!.prevHash, '0'.repeat(64));
}

// Same promo-grant behaviour across adapters. Three rules: opening the same grant twice leaves
// one row (repeat open by id is a no-op, doesn't overwrite); claimDue returns a grant once its
// expiry is at or before `now`, oldest expiry first; markReversed removes a grant from the due
// set and is a no-op if rerun on an already-reversed grant.
//
// claimDue and markReversed run on the top-level store, not inside store.transaction(...),
// matching how the background worker calls them.
async function reversesPromoGrantExactlyOnce(store: Store): Promise<void> {
  let userId = freshUser();
  let id = `txn_conf_promo_${userId}`;
  let grant = {
    id,
    userId,
    amount: toAmount('CREDIT', 500n),
    expiresAt: 1_000,
    reversed: false,
  };
  await store.transaction((unit) => unit.promos.open(grant));
  await store.transaction((unit) => unit.promos.open(grant)); // idempotent: still one row
  let due = await store.promos.claimDue(1_000, 10); // expiresAt <= now, inclusive
  assert.equal(due.length, 1);
  assert.equal(due[0]!.id, id);
  assert.deepEqual(due[0]!.amount, toAmount('CREDIT', 500n));
  await store.promos.markReversed(id);
  assert.deepEqual(await store.promos.claimDue(1_000, 10), []); // reversed → never re-claimed
  await store.promos.markReversed(id); // no-op on already-reversed
}

// Pins claimDue's ordering and cap: "oldest expiresAt first" holds across the whole table
// (sorted before the limit, not insertion order), and the cap is the literal `limit`. Opens
// three grants newest first; claimDue limit 2 returns the two oldest in ascending expiresAt.
async function claimsDuePromosOldestFirstUpToLimit(
  store: Store,
): Promise<void> {
  let userId = freshUser();
  let mk = (suffix: string, expiresAt: number) => ({
    id: `txn_conf_promo_order_${userId}_${suffix}`,
    userId,
    amount: toAmount('CREDIT', 100n),
    expiresAt,
    reversed: false,
  });
  let newest = mk('c', 3_000);
  let middle = mk('b', 2_000);
  let oldest = mk('a', 1_000);
  // Insert newest first so insertion order is the reverse of the required claim order.
  await store.transaction((unit) => unit.promos.open(newest));
  await store.transaction((unit) => unit.promos.open(middle));
  await store.transaction((unit) => unit.promos.open(oldest));

  let due = await store.promos.claimDue(5_000, 2);
  assert.deepEqual(
    due.map((grant) => grant.id),
    [oldest.id, middle.id],
  );
}

// Same webhook-dedup behaviour across adapters: an inbound provider webhook is processed at most
// once even on redelivery. The replay store uses an atomic insert-if-absent on the event id: the
// first claim returns `{ claimed: true }` (process), later claims of the same id return
// `{ claimed: false }` (skip). A different id is unaffected.
//
// claim runs on the top-level store, not inside store.transaction(...), since the webhook entry
// point checks it as a standalone final gate, not part of a domain transaction.
async function claimsWebhookEventIdOnce(store: Store): Promise<void> {
  let eventId = `evt_replay_${freshUser()}`;
  let other = `evt_replay_${freshUser()}`;

  let first = await store.replay.claim(eventId);
  let second = await store.replay.claim(eventId);
  let different = await store.replay.claim(other);

  assert.equal(first.claimed, true); // first sighting wins
  assert.equal(second.claimed, false); // redelivery of the same id is a no-op
  assert.equal(different.claimed, true); // an unrelated id is unaffected
}

// Same behaviour across adapters for `balanceAccounts`, which lists every account with a cached
// running-balance row. (The cache lets reads skip re-summing entries; entries remain the source of
// truth, so a cached row can be wrong or even orphaned with no entries.) Every account with a
// cached row must appear, letting the integrity checker inspect rows that walking `heads()`
// (accounts-with-entries) would miss, e.g. a stale row with no posting behind it. Funding a fresh
// user creates its cached row, so that user must appear.
async function balanceAccountsEnumeratesBalanceRow(
  store: Store,
): Promise<void> {
  let userId = freshUser();
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '6.00', 'txn_conf_balacct'),
  );

  let seen = new Set<string>();
  for await (let account of store.ledger.balanceAccounts()) {
    seen.add(account);
  }

  assert.equal(seen.has(spendable(userId)), true);
}

// Same markBilled behaviour across adapters: stops two concurrent renewal sweeps from charging a
// subscription twice in one period. markBilled updates the row only if the caller's expected due
// date still matches next_due_at. The first sweeper passes the current due date, so its update
// applies (returns true, advances the due date). A second sweeper starting from the now-stale due
// date matches no row and does nothing (returns false). Net: billed at most once per period.
async function markBilledIsCompareAndSet(store: Store): Promise<void> {
  let userId = freshUser();
  let id = `sub_conf_cas_${userId}`;
  let firstDue = 1_000;
  let secondDue = 2_000;
  let thirdDue = 3_000;

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
  let won = await store.subscriptions.markBilled(id, secondDue, firstDue);
  assert.equal(won, true);

  // Second sweeper also claimed firstDue, but the row has advanced to secondDue, so its
  // conditional update matches no row and bills nothing.
  let lost = await store.subscriptions.markBilled(id, thirdDue, firstDue);
  assert.equal(lost, false);

  // The losing call changed nothing: next_due_at is still secondDue, not thirdDue.
  let reloaded = await store.subscriptions.load(id);
  assert.equal(reloaded!.nextDueAt, secondDue);
}

/**
 * Registers the shared tests every Store implementation (in-memory and each db-backed adapter)
 * must pass. Each adapter calls this once with its name and a factory, holding all adapters to
 * the same behaviour.
 *
 * @param name - Label for this adapter, used in the test group title.
 * @param makeStore - Builds a fresh Store to run the tests against.
 */
export function runStoreConformance(
  name: string,
  makeStore: () => Promise<Store> | Store,
): void {
  describe(`Store Conformance: ${name}`, () => {
    let store: Store;

    before(async () => {
      store = await makeStore();
    });
    after(async () => {
      await store.close();
    });

    test('appends a posting and round-trips the balance as a bigint Amount', () =>
      appendRoundTripsBalance(store));
    test('commits a transaction durably and leaves no trace when one throws', () =>
      commitsDurablyAndRollsBack(store));
    test('claims an idempotency key once and replays the recorded transaction', () =>
      claimsOnceAndReplays(store));
    test('frees an idempotency key when its claiming transaction rolls back', () =>
      freesKeyOnRollback(store));
    test('grants account locks without deadlocking', () =>
      grantsLocksWithoutDeadlock(store));
    test('enqueues the outbox in the posting tx and relays once with consumer dedup', () =>
      relaysOutboxOnce(store));
    test('drops the outbox row when its enqueuing transaction rolls back', () =>
      dropsOutboxOnRollback(store));
    test('recomputes a per-account chain head deterministically over the digest', () =>
      recomputesChainHead(store));
    test('stores a posting with multiple debit/credit lines to one account', () =>
      storesMultipleLegsToOneAccount(store));
    test('reverses a promo grant exactly once after it is due', () =>
      reversesPromoGrantExactlyOnce(store));
    test('claims due promo grants oldest first up to the limit', () =>
      claimsDuePromosOldestFirstUpToLimit(store));
    test('claims a webhook event id once and dedups every redelivery', () =>
      claimsWebhookEventIdOnce(store));
    test('enumerates an account that has a stored balance row', () =>
      balanceAccountsEnumeratesBalanceRow(store));
    test('bills a subscription via compare-and-set so a stale renewal run is rejected', () =>
      markBilledIsCompareAndSet(store));
  });
}
