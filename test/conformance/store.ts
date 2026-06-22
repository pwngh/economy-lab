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
 * An Amount (a money value) is an object, not a number, so two equal amounts are not the
 * same reference. Every money check in this file therefore compares values with
 * `assert.deepEqual`, never `assert.equal` (which would compare object identity).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { credit, debit, postEntry } from '#src/ledger.ts';
import { decodeAmount, toAmount } from '#src/money.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';

import type { Store, Unit } from '#src/ports.ts';
import type { Transaction } from '#src/contract.ts';

// Returns a different user id on every call, so each test works on its own fresh user
// and one test's balances and hash-chain history never affect another's.
let userSeq = 0;
function freshUser(): string {
  userSeq += 1;
  return `usr_conf_${userSeq}`;
}

// Adds money to a user's spendable balance with one balanced posting: a credit line that
// raises the user's account and a matching debit line against a platform account, so the
// two lines cancel to zero (every posting must balance). Both accounts already exist, so
// `postEntry`'s check that all named accounts are known will pass.
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

// Builds one outbox message (an event saved to be delivered later). The caller passes a
// distinct message id so a test can check exactly which message it added to the outbox.
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

// Guards against a bug that once broke the SQL-backed stores: a single posting that touches the
// SAME account with TWO lines at once. The SQL adapters insert one row per line and key each row
// on (account, previous-hash); the second line for that account repeats the same pair, which
// their insert rejected. This test posts two credits into one user's spendable account, each
// matched by a debit to a platform account so the whole posting still cancels to zero in every
// currency, while the user's account ends up with two lines in the one posting. Every store must
// accept it, add both lines together into a single balance, and extend that account's
// tamper-evident hash chain by exactly one valid step. It's pinned here for ALL stores, not just
// for whatever postings the `prove` fuzzer happens to generate.
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

  // The stored running balance must equal the two lines added together (3.00 + 5.00 = 8.00),
  // which proves the store combined both lines rather than dropping one.
  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 800n),
  );

  // The account's latest chain hash (its "head") must match the one hash the posting reports for
  // this account: the account grew by exactly ONE step from the all-zeros starting point, and the
  // stored head equals that step's hash (the same hash-chain check as recomputesChainHead above).
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

// Holds every Store adapter to the same promo-grant behaviour, so the in-memory store and
// the database-backed ones can't diverge. Three rules are checked. Opening the same grant
// twice must leave exactly one row: a repeat open with the same id is recognized and not
// re-applied, never overwriting the first. claimDue hands back a grant once its expiry time
// is at or before `now`, oldest expiry first. markReversed takes a grant out of the due set
// and does nothing if run again on a grant that was already reversed.
//
// claimDue and markReversed are called directly on the top-level store here, not inside a
// `store.transaction(...)` block, because the background worker calls them that way too.
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

// Pins claimDue's ordering and cap, the two subtle points of the contract: "oldest
// expiresAt first" must hold ACROSS the whole table (sorted before the limit cap, not in
// insertion order), and the cap is the literal `limit`. Three grants are opened newest
// first; claimDue with limit 2 must hand back the two oldest, in ascending expiresAt order.
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

// Holds every Store adapter to the same webhook-dedup behaviour: an inbound payment-provider
// webhook must be processed at most once even if the provider delivers it more than once. The
// replay store does this with a single atomic "insert this event id only if it isn't already
// there" step: the FIRST claim of an id returns `{ claimed: true }` (process it), and every
// later claim of the same id returns `{ claimed: false }` (a redelivery — skip it). A different
// id is unaffected and still claims.
//
// claim is called directly on the top-level store, not inside a `store.transaction(...)` block,
// because the webhook entry point checks it on its own as a final gate, not as part of a
// domain transaction.
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

// Holds every Store adapter to the same behaviour for `balanceAccounts`, the method that lists
// every account the store keeps a cached running-balance row for. (The store caches a per-account
// balance so reads don't have to re-add every entry; the entries are still the source of truth,
// so a cached row can be wrong — even left behind with no entries under it.) Every account with
// such a cached row must show up in this list. That lets the integrity checker also inspect cached
// rows that walking the accounts-with-entries (`heads()`) would never reach — a stray or stale
// row with no posting behind it. Funding a fresh user creates its cached balance row, so that user
// must then appear in the list.
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

// Holds every Store adapter to the same markBilled behaviour, which stops two background renewal
// sweeps running at once from charging the same subscription twice in one period. markBilled
// updates the row only if the due date the caller expected still matches the row's current
// next_due_at. The first sweeper passes the real current due date, so its update applies (returns
// true and moves the due date forward). A second sweeper that started from the same now-stale due
// date finds no row matching it, so its update does nothing (returns false). Net effect: a
// subscription is billed at most once per period.
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

  // The winning sweeper claimed next_due_at=firstDue and bills with that expected value.
  let won = await store.subscriptions.markBilled(id, secondDue, firstDue);
  assert.equal(won, true);

  // A second sweeper that also claimed the old firstDue loses: the row has already advanced to
  // secondDue, so its conditional update finds no row still matching firstDue and bills nothing.
  let lost = await store.subscriptions.markBilled(id, thirdDue, firstDue);
  assert.equal(lost, false);

  // The losing call changed nothing: next_due_at is still secondDue, not thirdDue.
  let reloaded = await store.subscriptions.load(id);
  assert.equal(reloaded!.nextDueAt, secondDue);
}

/**
 * Registers the shared set of tests that every Store implementation (the in-memory one,
 * and each database-backed adapter) must pass. Each adapter calls this once, passing its
 * own name and a factory that builds a fresh Store, so all adapters are held to the same
 * behaviour instead of each one defining its own idea of correct.
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
