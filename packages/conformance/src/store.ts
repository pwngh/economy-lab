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

import { describe, test as nodeTest, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { countedCases } from './cases.js';
import { credit, debit, postEntry } from '@pwngh/economy-lab';
import { memoryStore } from '@pwngh/economy-lab/adapters';
import { decodeAmount, toAmount } from '@pwngh/economy-lab';
import { spendable, SYSTEM } from '@pwngh/economy-lab';
import { byCodeUnit } from '@pwngh/economy-lab/store-kit';
import {
  STORE_CAPABILITIES,
  capabilitiesOf,
  capabilityConflicts,
} from '@pwngh/economy-lab/store-kit';

import type { Amount } from '@pwngh/economy-lab';
import type {
  Attempt,
  Checkpoint,
  InboxMessage,
  Movement,
  OutboxMessage,
  Posting,
  Saga,
  SagaState,
  Sale,
  Store,
  StoreCapability,
  Subscription,
  Unit,
} from '@pwngh/economy-lab/ports';
import type { AccountRef } from '@pwngh/economy-lab';
import type { Operation, Transaction } from '@pwngh/economy-lab';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Whether `promise` settles inside `ms`. The timer is cleared on the winning path so a losing
// race does not hold the test process's event loop open.
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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
    correlationId: null,
  };
}

// `key` is both the dedupe key on enqueue and the operation's idempotencyKey.
function inboxRow(userId: string, rowId: string, key: string): InboxMessage {
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

// `Ledger.statement` promises commit order, and a posting is allowed several legs on one account —
// the legs table is built for it, with the hash-chain link per account rather than per leg — so a
// run of postings and the legs inside one of them both have to come back in the order they were
// written. An engine ordering by `posted_at` instead of a commit-order column passes this only
// while the clock happens to rise; test/adapters/statement-order.test.ts takes that away.
async function statementRunsInCommitOrder(store: Store): Promise<void> {
  const userId = freshUser();
  const account = spendable(userId);
  const shares = ['1.01', '1.02', '1.03'].map((share) =>
    decodeAmount(share, 'CREDIT'),
  );

  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: `txn_conf_stmt_split_${userId}`,
      legs: shares.flatMap((amount) => [
        credit(account, amount),
        debit(SYSTEM.REVENUE, amount),
      ]),
      meta: {},
    });
    await fundSpendable(unit, userId, '2.00', `txn_conf_stmt_b_${userId}`);
    await fundSpendable(unit, userId, '3.00', `txn_conf_stmt_c_${userId}`);
  });

  const statement = await store.ledger.statement(account, {
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(statement.account, account);
  assert.equal(statement.cursor, null);
  assert.deepEqual(
    statement.entries.map((entry) => entry.amount.minor),
    [101n, 102n, 103n, 200n, 300n],
  );
  assert.deepEqual(
    statement.entries.map((entry) => entry.txnId),
    [
      `txn_conf_stmt_split_${userId}`,
      `txn_conf_stmt_split_${userId}`,
      `txn_conf_stmt_split_${userId}`,
      `txn_conf_stmt_b_${userId}`,
      `txn_conf_stmt_c_${userId}`,
    ],
  );
}

// `timeline` is what the maturity calculation consumes, so its unit is a lot rather than a leg: one
// per balance-raising leg, carrying the source and maturity time the posting's meta named. A
// balance-lowering leg is not a lot, and the sign filter belongs in the store — a caller that
// filtered instead would read every spend leg to drop it.
async function streamsTimelineLotsOldestFirst(store: Store): Promise<void> {
  const userId = freshUser();
  const account = spendable(userId);
  const first = decodeAmount('4.00', 'CREDIT');
  const second = decodeAmount('6.00', 'CREDIT');
  const txn = (suffix: string): string => `txn_conf_lot_${suffix}_${userId}`;

  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: txn('a'),
      legs: [credit(account, first), debit(SYSTEM.REVENUE, first)],
      meta: { source: 'card', maturesAt: 7_000 },
    });
    await postEntry(unit.ledger, {
      txnId: txn('b'),
      legs: [credit(account, second), debit(SYSTEM.REVENUE, second)],
      meta: { source: 'promo', maturesAt: 9_000 },
    });
    await postEntry(unit.ledger, {
      txnId: txn('spend'),
      legs: [debit(account, first), credit(SYSTEM.REVENUE, first)],
      meta: { source: 'spend', maturesAt: 11_000 },
    });
  });

  const lots = await collect(store.ledger.timeline(account));
  assert.deepEqual(
    lots.map((lot) => lot.txnId),
    [txn('a'), txn('b')],
    'commit order, and the spend leg is not a lot',
  );
  assert.deepEqual(
    lots.map((lot) => lot.amount),
    [first, second],
  );
  assert.deepEqual(
    lots.map((lot) => lot.source),
    ['card', 'promo'],
  );
  assert.deepEqual(
    lots.map((lot) => lot.maturesAt),
    [7_000, 9_000],
  );
  // Read as finite rather than compared: Postgres dates a transaction once and MySQL dates each
  // statement, so both postings' times are the store's to choose (see the archive case).
  assert.equal(
    lots.every((lot) => Number.isFinite(lot.toppedUpAt)),
    true,
  );

  const newestFirst = await collect(
    store.ledger.timeline(account, { order: 'desc' }),
  );
  assert.deepEqual(
    newestFirst.map((lot) => lot.txnId),
    [txn('b'), txn('a')],
  );

  // `limit` and `offset` are the maturity tail's paging: it stops once it has covered the live
  // balance rather than reading the whole history.
  assert.deepEqual(
    (await collect(store.ledger.timeline(account, { limit: 1 }))).map(
      (lot) => lot.txnId,
    ),
    [txn('a')],
  );
  assert.deepEqual(
    (await collect(store.ledger.timeline(account, { offset: 1 }))).map(
      (lot) => lot.txnId,
    ),
    [txn('b')],
  );
  assert.deepEqual(
    (
      await collect(
        store.ledger.timeline(account, { order: 'desc', limit: 1, offset: 1 }),
      )
    ).map((lot) => lot.txnId),
    [txn('a')],
  );
}

// One posting that both raises and lowers the same account. Nothing forbids it: `assertBalanced`
// works per currency across the whole posting, so the two legs cancel against their counterparts
// and the posting is valid. It is the only input that reaches a per-leg lot filter, because a
// store that selects lots by posting sees both legs and a store that selects them by leg sees
// neither the spend leg nor this case.
async function skipsALoweringLegOnARaisingPosting(store: Store): Promise<void> {
  const userId = freshUser();
  const account = spendable(userId);
  const raised = decodeAmount('9.00', 'CREDIT');
  const lowered = decodeAmount('4.00', 'CREDIT');
  const txnId = `txn_conf_mixedleg_${userId}`;

  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId,
      legs: [
        credit(account, raised),
        debit(SYSTEM.REVENUE, raised),
        debit(account, lowered),
        credit(SYSTEM.REVENUE, lowered),
      ],
      meta: { source: 'card' },
    }),
  );

  assert.deepEqual(
    await store.ledger.balance(account),
    toAmount('CREDIT', 500n),
  );
  const lots = await collect(store.ledger.timeline(account));
  assert.deepEqual(
    lots.map((lot) => lot.amount),
    [raised],
    'the lowering leg of a raising posting was streamed as a lot',
  );
}

// --- The differential: one input, two implementations -------------------------------

// The postings the differential runs, written out once so both stores get the same input. Three
// legs to one account inside one posting, then a second posting, then a spend in a later
// transaction: a run whose order no single column recovers, and a balance-lowering leg the lot
// index has to drop.
async function postDifferentialWorkload(
  store: Store,
  userId: string,
): Promise<void> {
  const account = spendable(userId);
  const shares = ['1.01', '1.02', '1.03'].map((share) =>
    decodeAmount(share, 'CREDIT'),
  );
  const second = decodeAmount('2.00', 'CREDIT');
  const spend = decodeAmount('1.00', 'CREDIT');

  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: `txn_conf_diff_split_${userId}`,
      legs: shares.flatMap((amount) => [
        credit(account, amount),
        debit(SYSTEM.REVENUE, amount),
      ]),
      meta: { source: 'card', maturesAt: 7_000 },
    });
    await postEntry(unit.ledger, {
      txnId: `txn_conf_diff_b_${userId}`,
      legs: [credit(account, second), debit(SYSTEM.REVENUE, second)],
      meta: { source: 'promo', maturesAt: 9_000 },
    });
  });
  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: `txn_conf_diff_spend_${userId}`,
      legs: [debit(account, spend), credit(SYSTEM.REVENUE, spend)],
      meta: { source: 'spend' },
    });
  });
}

// Every read the differential compares, reduced to what the port promises identically. Nothing
// derived from the store's own digest, clock or id generator is in here: the hash chain head is
// reproducible across engines under one seed, but the seed is the host's, so comparing it would
// fail an honest store for using a different one. The account id is folded to `U` so the two
// transcripts are comparable without sharing a user.
async function readDifferentialTranscript(
  store: Store,
  userId: string,
): Promise<Record<string, unknown>> {
  const account = spendable(userId);
  const fold = (txnId: string): string => txnId.replace(userId, 'U');
  const money = (amount: Amount): string =>
    `${amount.currency}:${amount.minor}`;

  const statement = await store.ledger.statement(account, {
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
  });
  const lots = await collect(store.ledger.timeline(account));
  const newestFirst = await collect(
    store.ledger.timeline(account, { order: 'desc' }),
  );

  return {
    'statement.txnIds': statement.entries.map((entry) => fold(entry.txnId)),
    'statement.amounts': statement.entries.map((entry) => money(entry.amount)),
    'statement.cursor': statement.cursor,
    // Not the timestamps themselves — Postgres dates a transaction once and MySQL dates each
    // statement — but whether the column rises with commit order at all. Every shipped store
    // answers true, and a store answering false is one whose ordering key is not a commit-order
    // column: the `Q36` defect, which no other case in this suite can see.
    'statement.postedAtRises': statement.entries.every(
      (entry, index) =>
        index === 0 || entry.postedAt >= statement.entries[index - 1]!.postedAt,
    ),
    'timeline.txnIds': lots.map((lot) => fold(lot.txnId)),
    'timeline.amounts': lots.map((lot) => money(lot.amount)),
    'timeline.sources': lots.map((lot) => lot.source),
    'timeline.maturesAt': lots.map((lot) => lot.maturesAt),
    'timeline.desc': newestFirst.map((lot) => fold(lot.txnId)),
    balance: money(await store.ledger.balance(account)),
    derivedBalances: (await store.ledger.derivedBalances(account)).map(money),
  };
}

const DIFFERENTIAL_READS = [
  'balance',
  'derivedBalances',
  'statement.amounts',
  'statement.cursor',
  'statement.postedAtRises',
  'statement.txnIds',
  'timeline.amounts',
  'timeline.desc',
  'timeline.maturesAt',
  'timeline.sources',
  'timeline.txnIds',
] as const;

/**
 * Runs one written-out workload against the store under test and against a fresh memory oracle, and
 * compares the two transcripts. Every other case in this suite holds a store against a constant
 * this file wrote; this one holds it against another implementation.
 *
 * That catches the shape every engine defect here has had — one engine wrong while the reference is
 * right, on a field nobody wrote an expectation for. It does not catch two implementations agreeing
 * on a wrong answer, which is why the anchors below pin the size of what was compared and the other
 * cases keep their constants.
 *
 * On the memory registration the oracle is the subject's own implementation and this proves nothing;
 * its value is on the Postgres, MySQL and HTTP rows.
 *
 * Exported so `test/conformance-contract.test.ts` can run it against a store that diverges from the
 * oracle on one field and watch it refuse.
 */
export async function agreesWithTheMemoryOracle(store: Store): Promise<void> {
  const userId = freshUser();
  const oracle = memoryStore();
  let expected: Record<string, unknown>;
  try {
    await postDifferentialWorkload(oracle, userId);
    expected = await readDifferentialTranscript(oracle, userId);
  } finally {
    await oracle.close();
  }

  await postDifferentialWorkload(store, userId);
  const actual = await readDifferentialTranscript(store, userId);

  // The roster and the sizes are the anchors. Two empty transcripts are deep-equal, so without
  // them a store answering nothing at all would agree with the oracle on everything.
  assert.deepEqual(Object.keys(actual).sort(), [...DIFFERENTIAL_READS]);
  assert.equal(
    (expected['statement.txnIds'] as string[]).length,
    5,
    'the oracle read a statement of five entries',
  );
  assert.equal((expected['timeline.txnIds'] as string[]).length, 4);

  for (const read of DIFFERENTIAL_READS) {
    assert.deepEqual(
      actual[read],
      expected[read],
      `${read} differs from the memory oracle over the same input`,
    );
  }
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
    kid: null,
  };
  const v2: Checkpoint = {
    id: 'chk_conf_v2',
    root: 'c'.repeat(64),
    signature: 'dd'.repeat(32),
    count: 3,
    at: 2_000,
    v: 2,
    sum: '0',
    kid: 'feedfacefeedface',
  };

  await store.checkpoints.put(v1);
  assert.deepEqual(await store.checkpoints.latest(), v1);

  await store.checkpoints.put(v2);
  assert.deepEqual(await store.checkpoints.latest(), v2);
}

// The incremental seal's snapshot table. `putSealHeads` writes only the accounts a seal touched, so
// an upsert has to leave every leaf it was not handed; `replaceAll` is the full-replay seal's
// rewrite, which drops the strays a corruption left behind.
async function roundTripsSealedHeadLeaves(store: Store): Promise<void> {
  const kept = spendable(freshUser());
  const rewritten = spendable(freshUser());
  const leaves = async (): Promise<
    Map<AccountRef, readonly [string, bigint]>
  > =>
    new Map(
      (await store.checkpoints.sealHeads!()).map(([account, head, sum]) => [
        account,
        [head, sum] as const,
      ]),
    );

  await store.checkpoints.putSealHeads!([
    [rewritten, 'a'.repeat(64), 5n],
    [kept, 'b'.repeat(64), -7n],
  ]);
  const written = await leaves();
  assert.deepEqual(written.get(rewritten), ['a'.repeat(64), 5n]);
  assert.deepEqual(written.get(kept), ['b'.repeat(64), -7n]);

  await store.checkpoints.putSealHeads!([[rewritten, 'c'.repeat(64), 9n]]);
  const upserted = await leaves();
  assert.deepEqual(upserted.get(rewritten), ['c'.repeat(64), 9n]);
  assert.deepEqual(
    upserted.get(kept),
    ['b'.repeat(64), -7n],
    'a leaf this seal did not touch survives it',
  );

  await store.checkpoints.putSealHeads!([[rewritten, 'd'.repeat(64), 1n]], {
    replaceAll: true,
  });
  const replaced = await leaves();
  assert.deepEqual(replaced.get(rewritten), ['d'.repeat(64), 1n]);
  assert.equal(
    replaced.has(kept),
    false,
    'replaceAll drops every leaf absent from the write',
  );
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

  // This is clock-agnostic on purpose. The SQL conformance drivers run on the real clock while memory
  // runs at 0, so the rows use a far future (owned either way), a negative past (lapsed either
  // way), and null (never lapses). The inclusive boundary (owned while now <= expiresAt) is
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
  // sku order is identical on every engine. An unattributed grant lists the empty source.
  assert.deepEqual(grants, [
    { sku: 'sku_conf_a', expiresAt: -5, sources: [''] },
    { sku: 'sku_conf_z', expiresAt: null, sources: [''] },
  ]);
}

// One sku, two sources. Revoking by name must end exactly one of them, and the sku's expiry must
// follow the longest surviving source, or a refund confiscates an item another order still pays
// for.
async function revokesOneSourceAndKeepsTheOther(store: Store): Promise<void> {
  const userId = freshUser();

  await store.transaction(async (unit) => {
    await unit.entitlements.grant(userId, 'sku_conf_two', {
      source: 'sale:ord_1',
      expiresAt: 8.64e15,
    });
    await unit.entitlements.grant(userId, 'sku_conf_two', {
      source: 'sale:ord_2',
      expiresAt: null,
    });
  });
  assert.deepEqual(await collect(store.entitlements.list(userId)), [
    {
      sku: 'sku_conf_two',
      expiresAt: null,
      sources: ['sale:ord_1', 'sale:ord_2'],
    },
  ]);

  await store.transaction((unit) =>
    unit.entitlements.revoke(userId, 'sku_conf_two', { source: 'sale:ord_2' }),
  );
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_two'), true);
  assert.deepEqual(await collect(store.entitlements.list(userId)), [
    { sku: 'sku_conf_two', expiresAt: 8.64e15, sources: ['sale:ord_1'] },
  ]);

  // A source no live grant carries changes nothing.
  await store.transaction((unit) =>
    unit.entitlements.revoke(userId, 'sku_conf_two', { source: 'sale:ord_9' }),
  );
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_two'), true);

  // No source is the operator door: it takes what is left.
  await store.transaction((unit) =>
    unit.entitlements.revoke(userId, 'sku_conf_two'),
  );
  assert.equal(await store.entitlements.owns(userId, 'sku_conf_two'), false);
  assert.deepEqual(await collect(store.entitlements.list(userId)), []);
}

// The sale summary rides the charge's transaction, so a rolled-back charge must leave no row — the
// same rule the outbox and inbox rows follow. Two details the memory adapter alone would not force:
// the summary names its charge and `sales.txn_id` is a foreign key on both SQL engines, so the
// posting has to be real; and `recipientId` is set rather than left off, because a store that drops
// the field and one that answers null are different answers.
async function roundTripsSaleAndDropsItOnRollback(store: Store): Promise<void> {
  const buyerId = freshUser();
  const orderId = `ord_conf_sale_${buyerId}`;
  const price = decodeAmount('12.00', 'CREDIT');
  const txnId = `txn_conf_sale_${buyerId}`;
  const charge = (id: string): Posting => ({
    txnId: id,
    legs: [debit(spendable(buyerId), price), credit(SYSTEM.REVENUE, price)],
    meta: { source: 'spend' },
  });
  const sale: Sale = {
    orderId,
    buyerId,
    recipientId: freshUser(),
    sku: `sku_conf_sale_${buyerId}`,
    price,
    fee: decodeAmount('1.20', 'CREDIT'),
    legs: [...charge(txnId).legs],
    txnId,
    postedAt: 4_000,
  };

  assert.equal(
    await store.sales.get(orderId),
    null,
    'an order id nobody sold reads null, never a partial row',
  );

  await store.transaction((unit) =>
    fundSpendable(unit, buyerId, '24.00', `txn_conf_sale_fund_${buyerId}`),
  );
  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, charge(txnId));
    await unit.sales.put(sale);
  });
  assert.deepEqual(await store.sales.get(orderId), sale);

  // The upsert is keyed on the order id, so a corrected summary replaces the row rather than
  // adding a second one under the same key.
  const corrected: Sale = { ...sale, fee: decodeAmount('2.40', 'CREDIT') };
  await store.transaction((unit) => unit.sales.put(corrected));
  assert.deepEqual(await store.sales.get(orderId), corrected);

  const rolledBack = `ord_conf_sale_rb_${buyerId}`;
  const rolledBackTxn = `txn_conf_sale_rb_${buyerId}`;
  await assert.rejects(
    store.transaction(async (unit) => {
      await postEntry(unit.ledger, charge(rolledBackTxn));
      await unit.sales.put({
        ...sale,
        orderId: rolledBack,
        txnId: rolledBackTxn,
      });
      throw new Error('conformance: roll the sale back');
    }),
    /conformance: roll the sale back/,
  );
  assert.equal(await store.sales.get(rolledBack), null);
  assert.deepEqual(
    await store.sales.get(orderId),
    corrected,
    'the rollback took its own row and nothing else',
  );
}

// Velocity is the risk gate's input, and it is counted per idempotency key so a genuine retry of one
// request cannot look like two attempts. Rejected attempts count too — a burst of denials is itself
// the signal. The window's slide is not asserted here: the trailing window's length is the store's
// own construction parameter and the suite cannot inject a clock, so an attempt aging out is not a
// portable claim.
async function countsVelocityAttemptsOncePerKey(store: Store): Promise<void> {
  const subject = freshUser();
  // One timestamp for every attempt, so the window holds all of them under any window length a
  // store was built with.
  const at = Date.now();
  const attempt = (
    suffix: string,
    dollars: string,
    outcome: 'committed' | 'rejected',
  ): Attempt => ({
    idempotencyKey: `idem_conf_vel_${subject}_${suffix}`,
    amount: decodeAmount(dollars, 'CREDIT'),
    at,
    outcome,
  });

  const fresh = await store.trust.read(subject);
  assert.equal(fresh.subject, subject);
  assert.equal(fresh.attempts, 0);
  assert.equal(fresh.spent.minor, 0n);
  assert.equal(fresh.windowStart, 0, 'no live attempt, so no window start');

  const committed = await store.trust.record(
    subject,
    attempt('a', '2.00', 'committed'),
  );
  assert.equal(committed.attempts, 1);
  assert.equal(committed.spent.minor, 200n);
  assert.equal(committed.windowStart, at);

  const rejected = await store.trust.record(
    subject,
    attempt('b', '3.00', 'rejected'),
  );
  assert.equal(rejected.attempts, 2);
  assert.equal(rejected.spent.minor, 500n, 'a denial counts toward the window');

  const retried = await store.trust.record(
    subject,
    attempt('b', '3.00', 'rejected'),
  );
  assert.equal(retried.attempts, 2, 'record is idempotent on the key');
  assert.equal(retried.spent.minor, 500n);

  await store.trust.bump(subject, attempt('c', '1.00', 'committed'));
  await store.trust.bump(subject, attempt('c', '1.00', 'committed'));
  const bumped = await store.trust.read(subject);
  assert.equal(bumped.attempts, 3, 'bump is idempotent on the key too');
  assert.equal(bumped.spent.minor, 600n);

  // The unit view writes inside the money transaction and the store view on its own connection.
  // A committed attempt lands in the same window either way.
  await store.transaction((unit) =>
    unit.trust.bump(subject, attempt('d', '4.00', 'committed')),
  );
  const both = await store.trust.read(subject);
  assert.equal(both.attempts, 4);
  assert.equal(both.spent.minor, 1_000n);

  // `record` measures the window it just wrote to, so a replayed key measures the same window a
  // plain read does.
  assert.deepEqual(
    await store.trust.record(subject, attempt('d', '4.00', 'committed')),
    both,
    'record and read agree on one window',
  );
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

// Every journaled session id appears exactly once.
async function journalEnumeratesSessions(store: Store): Promise<void> {
  const sessionIds = store.movements.sessionIds!.bind(store.movements);
  const a = `sess_conf_e_${freshUser()}`;
  const b = `sess_conf_e_${freshUser()}`;
  await store.movements.append([
    movementRow(a, 0, `${a}_m0`),
    movementRow(a, 1, `${a}_m1`),
    movementRow(b, 0, `${b}_m0`),
  ]);
  const ids = await collect(sessionIds());
  assert.equal(ids.filter((id) => id === a).length, 1);
  assert.equal(ids.filter((id) => id === b).length, 1);
}

// `add` must return the post-add total, because the session's accept check adds first and then
// reads the total it got back. A storm of concurrent adds must sum exactly (no lost updates).
// `entries` must list the row for the reconciliation walk.
async function reservationCounterIsExact(store: Store): Promise<void> {
  const counter = store.reservations!;
  const account = spendable(freshUser());
  assert.equal(await counter.add(account, -100n), -100n);
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      counter.add(account, i % 2 === 0 ? -5n : 5n),
    ),
  );
  assert.equal(await counter.pending(account), -100n);
  let listed: bigint | null = null;
  for await (const [id, pending] of counter.entries()) {
    if (id === account) {
      listed = pending;
    }
  }
  assert.equal(listed, -100n);
  assert.equal(await counter.add(account, 100n), 0n);
}

// Signed state and heads round-trip exactly, and archivePage/prune move whole postings — content
// out, rows gone, balances untouched.
async function archiveSurfacesRoundTrip(store: Store): Promise<void> {
  assert.equal(await store.checkpoints.archiveState!(), null);
  const state = {
    throughSeq: 5,
    cursor: 3,
    root: 'a'.repeat(64),
    signature: 'b'.repeat(64),
    checkpointId: 'chk_conf_arch',
    at: 9,
  };
  const userId = freshUser();
  await store.checkpoints.putArchiveBoundary!(state, [
    { account: spendable(userId), head: 'c'.repeat(64), sum: -25n },
  ]);
  assert.deepEqual(await store.checkpoints.archiveState!(), state);
  const heads = await store.checkpoints.archiveHeads!();
  const mine = heads.find((row) => row.account === spendable(userId));
  assert.deepEqual(mine, {
    account: spendable(userId),
    head: 'c'.repeat(64),
    sum: -25n,
  });

  const txns = [`txn_conf_arch_a_${userId}`, `txn_conf_arch_b_${userId}`];
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', txns[0]!);
    await fundSpendable(unit, userId, '2.00', txns[1]!);
  });
  const page = await store.ledger.archivePage!(null, 500);
  const rows = page.postings.filter((posting) => txns.includes(posting.txnId));
  assert.equal(rows.length, 2);
  // Full content travels. Amounts are compared against what was appended, never counted: a leg
  // handing back the raw column string where an Amount.minor is declared satisfied a leg count on
  // every store. Keyed by txn id because a page's order is the store's choice, not this suite's.
  const archived = new Map(rows.map((posting) => [posting.txnId, posting]));
  assert.equal(archived.size, 2);
  for (const [txnId, minor] of [
    [txns[0]!, 100n],
    [txns[1]!, 200n],
  ] as ReadonlyArray<readonly [string, bigint]>) {
    const posting = archived.get(txnId)!;
    assert.deepEqual(
      new Map(posting.legs.map((leg) => [leg.account, leg.amount])),
      new Map([
        [spendable(userId), toAmount('CREDIT', -minor)],
        [SYSTEM.REVENUE, toAmount('CREDIT', minor)],
      ]),
    );
    assert.deepEqual(posting.meta, { source: 'card' });
    assert.equal(posting.links.length, 2);
    // Both hashes, not just one: prevHash is what makes an archived page re-provable.
    for (const link of posting.links) {
      assert.equal(link.hash.length, 64);
      assert.equal(link.prevHash.length, 64);
    }
  }
  const [first, second] = [archived.get(txns[0]!)!, archived.get(txns[1]!)!];
  assert.ok(first.seq < second.seq);
  // Both postings commit in one transaction, and Postgres dates a transaction once while MySQL
  // dates each statement — so the honest claim is a time that travels and does not go backwards.
  assert.ok(
    Number.isFinite(first.postedAt) && Number.isFinite(second.postedAt),
  );
  assert.ok(first.postedAt <= second.postedAt);

  await store.transaction((unit) => unit.ledger.prune!([txns[0]!]));
  assert.equal(await store.ledger.posting(txns[0]!), null);
  assert.notEqual(await store.ledger.posting(txns[1]!), null);
  // Pruning removes history, never money state.
  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 300n),
  );
  const after = await store.ledger.archivePage!(null, 500);
  assert.equal(
    after.postings.some((posting) => posting.txnId === txns[0]!),
    false,
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

// The undo half of `record`, which the claim half above never reaches: nothing is recorded there,
// so a store could omit it and still pass. A recorded key whose transaction rolls back must be
// unused again, or a retry replays a transaction that never landed and the caller reads a reversed
// charge as a settled one.
async function dropsRecordedKeyOnRollback(store: Store): Promise<void> {
  const userId = freshUser();
  const key = `idem_conf_recorded_rollback_${userId}`;

  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.idempotency.claim(key);
      const transaction = await fundSpendable(
        unit,
        userId,
        '2.00',
        `txn_conf_idem_recorded_${userId}`,
      );
      await unit.idempotency.record(key, transaction);
      throw new Error('roll back after record');
    }),
  );

  assert.deepEqual(
    await store.transaction((unit) => unit.idempotency.claim(key)),
    {
      claimed: true,
    },
  );
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

// A lock is mutual exclusion, and that is what this asserts: while one transaction holds the
// accounts, a second asking for the same set waits until the first commits. It is asserted
// directly because no outcome of the postings can show it. Both engines refuse a forked chain
// three other ways — the chain_links (account_id, prev_hash) unique index, the chain-continuity
// trigger, and the row lock the balance update takes regardless — so a lockMany that does nothing
// still yields a correctly threaded chain. Measured on Postgres and MySQL: with the lock replaced
// by a no-op the chain still threads, with zero retries and zero errors, over a genuine
// simultaneous race. The chain assertions below stay because threading is a real property; they
// are not what catches a no-op.
//
// The holder waits for the waiter to report reaching its own lockMany before starting the grace
// period, so the grace measures the lock rather than the scheduler. A real lock never lets the
// waiter through, so a generous grace costs one wait and cannot produce a false failure.
const LOCK_OVERLAP_MS = 5_000;
const LOCK_GRACE_MS = 250;

async function lockManyExcludesAConcurrentWriter(store: Store): Promise<void> {
  const userId = freshUser();
  const account = spendable(userId);
  const locked = [account, SYSTEM.REVENUE].sort(byCodeUnit);
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '1.00', `txn_conf_lockmany_seed_${userId}`),
  );

  const holderHasLock = deferred();
  const waiterAtLock = deferred();
  let waiterPassedLock = false;
  let overlapped = false;

  const holder = store.transaction(async (unit) => {
    await unit.ledger.lockMany!(locked);
    holderHasLock.resolve();
    overlapped = await settlesWithin(waiterAtLock.promise, LOCK_OVERLAP_MS);
    await sleep(LOCK_GRACE_MS);
    assert.equal(
      waiterPassedLock,
      false,
      'lockMany let a second transaction take the same accounts while it was held',
    );
    await fundSpendable(unit, userId, '2.00', `txn_conf_lockmany_a_${userId}`);
  });

  const waiter = store.transaction(async (unit) => {
    await holderHasLock.promise;
    waiterAtLock.resolve();
    await unit.ledger.lockMany!(locked);
    waiterPassedLock = true;
    await fundSpendable(unit, userId, '3.00', `txn_conf_lockmany_b_${userId}`);
  });

  await Promise.all([holder, waiter]);
  // A store that runs transactions one at a time never overlaps them, so nothing above can
  // observe its lock. The memory adapter is that store and declares lockMany false.
  assert.equal(
    overlapped,
    true,
    'the store never ran the two transactions concurrently, so its lockMany cannot be observed',
  );

  const lineage = await collect(store.ledger.lineage(account));
  assert.equal(lineage.length, 3);
  // Threaded, not forked: every link names its predecessor's hash.
  assert.equal(lineage[1]!.prevHash, lineage[0]!.hash);
  assert.equal(lineage[2]!.prevHash, lineage[1]!.hash);
  const heads = new Map(await collect(store.ledger.heads()));
  assert.equal(heads.get(account), lineage[2]!.hash);
  assert.deepEqual(
    await store.ledger.balance(account),
    toAmount('CREDIT', 600n),
  );
}

// The capacity report reads this gauge as the ledger's history size, so it counts postings the
// store actually holds: appending two raises it by exactly two. A store answering zero for
// "unknown" would report an empty ledger.
//
// The anchor append is what makes that delta exact instead of order-dependent. The gauge is the
// newest commit sequence and a rolled-back append burns a sequence value — measured on memory and
// on Postgres, where one commit, one rollback and one commit read 1, 1, 3 — so a `before` taken
// after any earlier case rolled a posting back reports the last committed row rather than the
// counter, and the two appends below then look like three. Committing one posting first puts the
// two back together, whatever ran before this case.
async function historySizeCountsEveryPosting(store: Store): Promise<void> {
  const size = () => store.transaction((unit) => unit.ledger.historySize!());
  const userId = freshUser();
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '1.00', `txn_conf_hist_anchor_${userId}`),
  );
  const before = await size();
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', `txn_conf_hist_a_${userId}`);
    await fundSpendable(unit, userId, '2.00', `txn_conf_hist_b_${userId}`);
  });
  assert.equal((await size()) - before, 2);
}

async function relaysOutboxOnce(store: Store): Promise<void> {
  const userId = freshUser();
  const messageId = `obx_conf_${userId}`;
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', 'txn_conf_outbox');
    await unit.outbox.enqueue({
      ...outboxRow(userId, messageId),
      correlationId: 'req_conf',
    });
  });

  const batch = await store.outbox.claimBatch(10);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  const afterRelay = await store.outbox.claimBatch(10);

  assert.deepEqual(
    batch.map((message) => message.id),
    [messageId],
  );
  // The correlation id survives the round trip so relay logs can name the request.
  assert.equal(batch[0]!.correlationId, 'req_conf');
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

// This is the outbound twin of bumpsInboxAttemptThenDeadLetters. Like the relay worker,
// bumpAttempt and deadLetter run on the top-level store, not inside store.transaction(...).
//
// The returned count is the whole point of the method: the relay reads its cap off it, and it can
// only do that if the store hands back the number it just wrote. A store that returns the count it
// read before writing, or that answers a terminal row with a number, breaks the cap.
async function countsOutboxAttemptsThenDeadLetters(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  const messageId = `obx_conf_dead_${userId}`;
  await store.transaction((unit) =>
    unit.outbox.enqueue(outboxRow(userId, messageId)),
  );

  assert.equal(await store.outbox.bumpAttempt(messageId), 1);
  assert.equal(await store.outbox.bumpAttempt(messageId), 2);
  const afterBump = await store.outbox.claimBatch(10);
  const counted = afterBump.find((message) => message.id === messageId);
  assert.notEqual(counted, undefined);
  assert.equal(counted!.attempts, 2);
  assert.equal(counted!.status, 'pending');
  assert.equal(counted!.reason, null);

  // The reason is persisted on the 'dead' record itself, not a side-channel. claimBatch never
  // returns a terminal row, but the SQL decoders still carry it.
  await store.outbox.deadLetter(messageId, 'poison');
  const afterDead = await store.outbox.claimBatch(10);
  assert.equal(
    afterDead.some((message) => message.id === messageId),
    false,
  );

  // Zero on a terminal row is what tells the relay another worker has already finished with it.
  assert.equal(await store.outbox.bumpAttempt(messageId), 0);
  assert.equal(await store.outbox.bumpAttempt(`${messageId}_missing`), 0);
  await store.outbox.markRelayed([messageId]);
  await store.outbox.deadLetter(messageId, 'again');
  const stillDead = await store.outbox.claimBatch(10);
  assert.equal(
    stillDead.some((message) => message.id === messageId),
    false,
  );
}

// claimInbound returns only 'pending' rows. 'applied' is terminal.
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
  // The operation comes back whole, amounts included. An engine that stores it as JSON has to
  // carry the bigint minor across a codec that cannot stringify one, and a store that hands back
  // '1000' for 1000n satisfies an id check while losing the money.
  const operation = batch[0]!.operation as Extract<
    Operation,
    { kind: 'topUp' }
  >;
  assert.equal(operation.kind, 'topUp');
  assert.equal(operation.idempotencyKey, `evt_${rowId}`);
  assert.equal(operation.source, 'card');
  assert.equal(typeof operation.amount.minor, 'bigint');
  assert.deepEqual(operation.amount, toAmount('CREDIT', 1_000n));
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
// matching how the apply worker calls them. The returned count is what the drain reads its cap
// off, so it has to be the number this call wrote.
async function bumpsInboxAttemptThenDeadLetters(store: Store): Promise<void> {
  const userId = freshUser();
  const rowId = `ibx_conf_dead_${userId}`;
  await store.transaction((unit) =>
    unit.inbox.enqueueInbound(inboxRow(userId, rowId, `evt_${rowId}`)),
  );

  assert.equal(await store.inbox.bumpAttempt(rowId), 1);
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

  // Terminal-row operations are no-ops. A second deadLetter does not overwrite the first reason,
  // and a bump on a row someone else finished counts nothing and says so.
  await store.inbox.markApplied(rowId);
  assert.equal(await store.inbox.bumpAttempt(rowId), 0);
  assert.equal(await store.inbox.bumpAttempt(`${rowId}_missing`), 0);
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

// Six rows drained four at a time, one marked per round, so the drain takes six rounds and the
// three rows the first claim handed over and the caller walked away from are named.
const REOFFER_ROWS = 6;
const REOFFER_LIMIT = 4;
// Four times the rounds a correct store needs. It bounds the loop; it never decides the result —
// a drain that stops early on this budget still has to satisfy every assertion below it.
const REOFFER_ROUND_BUDGET = 24;

/**
 * A claim is a read, not a consumption, and that is what makes the port's "a claim under contention
 * can come back short or empty while rows are still pending" something a caller can be written
 * against. A row the claim passed over, and a row it handed to a caller that never marked it, are
 * both still pending and come back on a later claim. The mark is what takes a row out of the sweep.
 *
 * The drain here is written the way a caller has to be. It marks one row per round and abandons the
 * rest of its batch — what a worker killed mid-batch does — and it never reads a round that came
 * back with fewer rows than it asked for as a drained queue. Every shipped store passes because
 * every shipped claim is a plain SELECT. A store that hands each row out once, which is what a lease
 * or a 'claimed' status column does, passes every other case in this suite and fails here.
 *
 * Exported so `test/conformance-contract.test.ts` can run it against exactly that store and watch it
 * refuse: the assertions below are about rows nobody returns, which is the shape that passes while
 * examining nothing.
 */
export async function reOffersEveryUnmarkedRow(store: Store): Promise<void> {
  // Earlier cases leave pending rows behind, and this one reads a claim's contents rather than its
  // size, so it starts from an inbox holding nothing but its own rows.
  for (let round = 0; round < REOFFER_ROUND_BUDGET; round += 1) {
    const left = await store.inbox.claimInbound({ now: 0, limit: 500 });
    if (left.length === 0) {
      break;
    }
    for (const entry of left) {
      await store.inbox.markApplied(entry.id);
    }
  }

  const userId = freshUser();
  const seeded = Array.from(
    { length: REOFFER_ROWS },
    (_unused, k) => `ibx_conf_reoffer_${userId}_${k}`,
  );
  await store.transaction(async (unit) => {
    for (const [index, id] of seeded.entries()) {
      await unit.inbox.enqueueInbound({
        ...inboxRow(userId, id, `evt_${id}`),
        receivedAt: index + 1,
      });
    }
  });

  const rounds: string[][] = [];
  const applied: string[] = [];
  for (
    let round = 0;
    round < REOFFER_ROUND_BUDGET && applied.length < REOFFER_ROWS;
    round += 1
  ) {
    const batch = await store.inbox.claimInbound({
      now: 0,
      limit: REOFFER_LIMIT,
    });
    rounds.push(batch.map((entry) => entry.id));
    if (batch.length === 0) {
      continue;
    }
    await store.inbox.markApplied(batch[0]!.id);
    applied.push(batch[0]!.id);
  }

  // The control, and the reason the three ids below are real rows: with nothing contending, the
  // claim fills its limit with the oldest rows in order.
  assert.deepEqual(rounds[0], seeded.slice(0, REOFFER_LIMIT));

  // Every row the first claim handed over and the caller left unmarked is offered again.
  for (const id of seeded.slice(1, REOFFER_LIMIT)) {
    assert.ok(
      rounds.slice(1).some((round) => round.includes(id)),
      `row ${id} was claimed and left unmarked, and no later claim offered it again`,
    );
  }

  // The drain converged on every seeded row, so nothing was stranded on the way.
  assert.deepEqual([...applied].sort(), [...seeded].sort());

  const afterDrain = await store.inbox.claimInbound({
    now: 0,
    limit: REOFFER_ROWS,
  });
  assert.deepEqual(
    afterDrain.map((entry) => entry.id).filter((id) => seeded.includes(id)),
    [],
  );
}

// stats is a whole-table gauge, so the test works in deltas and then drains every pending row —
// exactly what a relay run does — before asserting the empty shape.
async function reportsOutboxBacklogStats(store: Store): Promise<void> {
  const userId = freshUser();
  const before = await store.outbox.stats();

  await store.transaction(async (unit) => {
    await unit.outbox.enqueue(outboxRow(userId, `obx_conf_stats_a_${userId}`));
    await unit.outbox.enqueue(outboxRow(userId, `obx_conf_stats_b_${userId}`));
  });

  const loaded = await store.outbox.stats();
  assert.equal(loaded.pending, before.pending + 2);
  assert.notEqual(loaded.oldestPendingAgeMs, null);
  assert.ok(loaded.oldestPendingAgeMs! >= 0);

  const batch = await store.outbox.claimBatch(1_000);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  const drained = await store.outbox.stats();
  assert.deepEqual(drained, { pending: 0, oldestPendingAgeMs: null });
}

// reviveDead flips dead rows back to pending with attempts reset, oldest-first. The opening
// drain clears every dead row the suite has left behind, so the limit assertions below see
// only this test's rows.
async function revivesDeadInboxRowsOldestFirst(store: Store): Promise<void> {
  const userId = freshUser();
  const olderId = `ibx_conf_rev_a_${userId}`;
  const newerId = `ibx_conf_rev_b_${userId}`;
  await store.transaction(async (unit) => {
    await unit.inbox.enqueueInbound({
      ...inboxRow(userId, olderId, `evt_${olderId}`),
      receivedAt: 1_000,
    });
    await unit.inbox.enqueueInbound({
      ...inboxRow(userId, newerId, `evt_${newerId}`),
      receivedAt: 2_000,
    });
  });
  await store.inbox.bumpAttempt(olderId);
  await store.inbox.deadLetter(olderId, 'poison');
  await store.inbox.deadLetter(newerId, 'poison');

  assert.deepEqual(await store.inbox.reviveDead(0), []);

  const drainedRows = await store.inbox.reviveDead(1_000);
  const olderRevived = drainedRows.find((entry) => entry.id === olderId);
  const newerRevived = drainedRows.find((entry) => entry.id === newerId);
  for (const entry of [olderRevived, newerRevived]) {
    assert.notEqual(entry, undefined);
    assert.equal(entry!.status, 'pending');
    assert.equal(entry!.attempts, 0);
    assert.equal(entry!.reason, null);
  }

  // Selection is oldest-first by receivedAt: with only these two dead, limit 1 takes the older.
  await store.inbox.deadLetter(olderId, 'again');
  await store.inbox.deadLetter(newerId, 'again');
  const one = await store.inbox.reviveDead(1);
  assert.deepEqual(
    one.map((entry) => entry.id),
    [olderId],
  );
  const rest = await store.inbox.reviveDead(10);
  assert.deepEqual(
    rest.map((entry) => entry.id),
    [newerId],
  );

  // A revived row is claimable again. Once applied it is terminal and nothing is left to revive.
  const claimed = await store.inbox.claimInbound({ now: 0, limit: 1_000 });
  for (const id of [olderId, newerId]) {
    assert.equal(
      claimed.some((entry) => entry.id === id),
      true,
    );
    await store.inbox.markApplied(id);
  }
  assert.deepEqual(await store.inbox.reviveDead(10), []);
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

// read.lineage delegates straight to Ledger.lineage, so proving it here covers the read-surface
// promotion for every store: one link per posting in commit order, genesis first, each
// link chaining from the one before, the last one being the account's current head.
async function streamsAccountLineageInOrder(store: Store): Promise<void> {
  const userId = freshUser();
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '5.00', `txn_conf_lineage_a_${userId}`),
  );
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '2.50', `txn_conf_lineage_b_${userId}`),
  );

  const links = await collect(store.ledger.lineage(spendable(userId)));
  assert.equal(links.length, 2);
  assert.equal(links[0]!.prevHash, '0'.repeat(64));
  assert.equal(links[1]!.prevHash, links[0]!.hash);

  const heads = new Map(await collect(store.ledger.heads()));
  assert.equal(links[1]!.hash, heads.get(spendable(userId)));
}

// This is a regression test. A posting with two lines to one account once collided on the SQL adapters'
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

// The expiry sweep works out how much of the pooled promo balance an expiring grant still claims
// by reading every grant the user holds open, so `liveFor` must return them all — expired or not —
// and nobody else's.
async function listsEveryLivePromoGrantForOneUser(store: Store): Promise<void> {
  const userId = freshUser();
  const other = freshUser();
  const mk = (owner: string, suffix: string, expiresAt: number) => ({
    id: `txn_conf_promo_live_${userId}_${suffix}`,
    userId: owner,
    amount: toAmount('CREDIT', 100n),
    expiresAt,
    reversed: false,
  });
  const expired = mk(userId, 'a', 1_000);
  const later = mk(userId, 'b', 9_000);
  const reversed = mk(userId, 'c', 9_000);
  const stranger = mk(other, 'd', 9_000);
  for (const grant of [expired, later, reversed, stranger]) {
    await store.transaction((unit) => unit.promos.open(grant));
  }
  await store.promos.markReversed(reversed.id);

  const live = await store.promos.liveFor(userId);
  assert.deepEqual(
    live.map((grant) => grant.id).sort(),
    [expired.id, later.id].sort(),
  );
  assert.deepEqual(live[0]!.amount, toAmount('CREDIT', 100n));
  assert.deepEqual(await store.promos.liveFor(freshUser()), []);
}

// The surplus sweep walks `holders` to find pooled promo credit no live grant claims. A user
// whose every grant is reversed is exactly the case the per-grant sweep can no longer reach, so
// dropping them here would strand the money; two grants for one user must still yield one id.
async function streamsEveryPromoHolderOnce(store: Store): Promise<void> {
  const userId = freshUser();
  const closed = freshUser();
  const mk = (owner: string, suffix: string) => ({
    id: `txn_conf_promo_holder_${owner}_${suffix}`,
    userId: owner,
    amount: toAmount('CREDIT', 100n),
    expiresAt: 9_000,
    reversed: false,
  });
  const first = mk(userId, 'a');
  const second = mk(userId, 'b');
  const onlyGrant = mk(closed, 'a');
  for (const grant of [first, second, onlyGrant]) {
    await store.transaction((unit) => unit.promos.open(grant));
  }
  await store.promos.markReversed(onlyGrant.id);

  const holders = await collect(store.promos.holders());
  assert.equal(holders.filter((id) => id === userId).length, 1);
  assert.equal(holders.filter((id) => id === closed).length, 1);
  assert.equal(holders.includes(freshUser()), false);
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
  // This inserts newest first so insertion order is the reverse of the required claim order.
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
    reserve: toAmount('CREDIT', 10_000n),
    rateId: 'rate_conf',
    txnId: 'txn_anchor_conf',
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

// A same-state advance gets no exclusion from the state predicate, because every racing sweep
// satisfies it. `expectAttempts` is the second predicate that makes one exclusive, and the payout
// sweep's attempt bump is the caller that needs it. The zero case is not an extra: the first bump
// always expects zero, so an engine testing the predicate for truthiness rather than for presence
// passes every other case here and still loses that one.
async function advanceComparesExpectedAttempts(store: Store): Promise<void> {
  const userId = freshUser();
  const id = `pay_conf_cas_${userId}`;
  await store.sagas.open(sagaRow(id, userId, { attempts: 0 }));

  // Expecting zero on a row at zero: the predicate holds and the bump lands.
  assert.equal(
    await store.sagas.advance(
      id,
      'SUBMITTED',
      'SUBMITTED',
      { attempts: 1 },
      {
        expectAttempts: 0,
      },
    ),
    true,
  );
  assert.equal((await store.sagas.load(id))!.attempts, 1);

  // A second sweep holding the same stale snapshot expects zero against a row at one. It is
  // refused, and nothing moves — without this the counter would be rewritten to 1 forever.
  assert.equal(
    await store.sagas.advance(
      id,
      'SUBMITTED',
      'SUBMITTED',
      { attempts: 1 },
      {
        expectAttempts: 0,
      },
    ),
    false,
  );
  assert.equal((await store.sagas.load(id))!.attempts, 1);

  // Omitting the predicate leaves the state check alone, so callers that never patch attempts
  // are unaffected.
  assert.equal(
    await store.sagas.advance(id, 'SUBMITTED', 'SUBMITTED', { dueAt: 42 }),
    true,
  );
  assert.equal((await store.sagas.load(id))!.dueAt, 42);

  // The state predicate still governs: a matching attempts count cannot rescue a wrong state.
  assert.equal(
    await store.sagas.advance(
      id,
      'RESERVED',
      'SUBMITTED',
      { attempts: 9 },
      {
        expectAttempts: 1,
      },
    ),
    false,
  );
  assert.equal((await store.sagas.load(id))!.attempts, 1);
}

// claimDue hands the worker only the in-progress states, RESERVED and SUBMITTED: a REQUESTED
// row is a crashed opening (the schema's due indexes exclude it) and the terminal states are
// done, so none of them reach the sweep however overdue.
async function claimsOnlyInProgressDueSagas(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, state: SagaState): Saga =>
    sagaRow(`pay_conf_due_${userId}_${suffix}`, userId, {
      state,
      dueAt: 1_000,
      updatedAt: 1_000,
    });
  const requested = mk('req', 'REQUESTED');
  const reserved = mk('res', 'RESERVED');
  const submitted = mk('sub', 'SUBMITTED');
  const settled = mk('set', 'SETTLED');
  const failed = mk('fail', 'FAILED');
  for (const saga of [requested, reserved, submitted, settled, failed]) {
    await store.transaction((unit) => unit.sagas.open(saga));
  }

  // This claims with a generous limit, then filters to this test's user because the store is shared.
  const mine = (await store.sagas.claimDue(2_000, 1_000))
    .filter((saga) => saga.userId === userId)
    .map((saga) => saga.id)
    .sort();
  assert.deepEqual(mine, [reserved.id, submitted.id].sort());
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
  // The sagas open out of updatedAt order so insertion order isn't the expected list order.
  await store.transaction((unit) => unit.sagas.open(middle));
  await store.transaction((unit) => unit.sagas.open(oldest));
  await store.transaction((unit) => unit.sagas.open(newest));

  const mine = (await collect(store.sagas.list()))
    .filter((saga) => saga.userId === userId)
    .map((saga) => saga.id);
  assert.deepEqual(mine, [newest.id, middle.id, oldest.id]);
}

// The `states` filter narrows the board to exactly those states, keeping the newest-first
// order. A provided-but-empty list yields nothing (it names zero states, not "all").
async function listsSagasFilteredByState(store: Store): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string, updatedAt: number, state: SagaState): Saga =>
    sagaRow(`pay_conf_filter_${userId}_${suffix}`, userId, {
      state,
      dueAt: updatedAt,
      updatedAt,
    });
  const settled = mk('a', 1_000, 'SETTLED');
  const reserved = mk('b', 2_000, 'RESERVED');
  const submitted = mk('c', 3_000, 'SUBMITTED');
  await store.transaction((unit) => unit.sagas.open(settled));
  await store.transaction((unit) => unit.sagas.open(reserved));
  await store.transaction((unit) => unit.sagas.open(submitted));

  const ids = async (states?: readonly SagaState[]): Promise<string[]> =>
    (await collect(store.sagas.list(states && { states })))
      .filter((saga) => saga.userId === userId)
      .map((saga) => saga.id);

  assert.deepEqual(await ids(['RESERVED']), [reserved.id]);
  assert.deepEqual(await ids(['SUBMITTED', 'RESERVED']), [
    submitted.id,
    reserved.id,
  ]);
  assert.deepEqual(await ids([]), []);
  assert.deepEqual(await ids(), [submitted.id, reserved.id, settled.id]);
}

// Under a coarse or frozen clock two sagas share an `updatedAt`. The contract breaks the tie by
// `id` descending so list order never depends on insertion order or engine internals.
async function listsSagasTiedOnUpdatedAtByIdDescending(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  const mk = (suffix: string): Saga =>
    sagaRow(`pay_conf_tie_${userId}_${suffix}`, userId, { updatedAt: 5_000 });
  const low = mk('a');
  const high = mk('b');
  // The sagas open ascending so insertion order isn't the expected list order.
  await store.transaction((unit) => unit.sagas.open(low));
  await store.transaction((unit) => unit.sagas.open(high));

  const mine = (await collect(store.sagas.list()))
    .filter((saga) => saga.userId === userId)
    .map((saga) => saga.id);
  assert.deepEqual(mine, [high.id, low.id]);
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

  const paid = toAmount('USD', 10_000n);
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
  // This appends in order a, b, c so insertion order isn't the expected list order (which is its reverse).
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
      price: toAmount('CREDIT', 10_000n),
      txnId: `txn_anchor_${userId}`,
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

async function listsSagasForOneUser(store: Store): Promise<void> {
  const mine = freshUser();
  const other = freshUser();
  const mk = (owner: string, suffix: string, updatedAt: number): Saga =>
    sagaRow(`pay_conf_user_${owner}_${suffix}`, owner, {
      state: 'RESERVED',
      dueAt: updatedAt,
      updatedAt,
    });
  const a = mk(mine, 'a', 1_000);
  const b = mk(mine, 'b', 2_000);
  const foreign = mk(other, 'c', 3_000);
  await store.transaction((unit) => unit.sagas.open(a));
  await store.transaction((unit) => unit.sagas.open(b));
  await store.transaction((unit) => unit.sagas.open(foreign));

  const ids = (await collect(store.sagas.list({ userId: mine }))).map(
    (saga) => saga.id,
  );
  assert.deepEqual(ids, [b.id, a.id], 'only the named user, newest first');
}

async function listsSubscriptionsForOneUser(store: Store): Promise<void> {
  const mine = freshUser();
  const other = freshUser();
  const mk = (
    owner: string,
    suffix: string,
    updatedAt: number,
    state: 'ACTIVE' | 'CANCELED',
  ) => ({
    id: `sub_conf_list_${owner}_${suffix}`,
    userId: owner,
    sellerId: `usr_seller_${suffix}`,
    sku: `sku_conf_list_${suffix}`,
    price: toAmount('CREDIT', 10_000n),
    txnId: `txn_anchor_${owner}_${suffix}`,
    periodMs: 1_000,
    state,
    period: 0,
    attempts: 0,
    nextDueAt: 10_000,
    updatedAt,
  });
  const oldest = mk(mine, 'a', 1_000, 'CANCELED');
  const newest = mk(mine, 'b', 2_000, 'ACTIVE');
  const foreign = mk(other, 'c', 3_000, 'ACTIVE');
  await store.transaction(async (unit) => {
    await unit.subscriptions.open(oldest);
    await unit.subscriptions.open(newest);
    await unit.subscriptions.open(foreign);
  });

  const ids = (await collect(store.subscriptions.listFor(mine))).map(
    (sub) => sub.id,
  );
  assert.deepEqual(
    ids,
    [newest.id, oldest.id],
    'every state, only the named user, newest first',
  );
}

function subscriptionRow(
  id: string,
  overrides: Partial<Subscription> & { userId: string },
): Subscription {
  return {
    id,
    sellerId: `usr_seller_conf_${id}`,
    sku: `sku_conf_${id}`,
    price: toAmount('CREDIT', 10_000n),
    txnId: `txn_anchor_conf_${id}`,
    periodMs: 1_000,
    state: 'ACTIVE',
    period: 0,
    attempts: 0,
    nextDueAt: 10_000,
    updatedAt: 0,
    ...overrides,
  };
}

// `activeFor` is what stops a second active subscription on the same (user, sku, seller), which
// would double-bill. The key is all three fields, and a closed row is not a match — a store reading
// two of the three, or ignoring the state, refuses a legitimate resubscribe or allows a double.
async function findsTheOneActiveSubscription(store: Store): Promise<void> {
  const userId = freshUser();
  const sellerId = freshUser();
  const otherSeller = freshUser();
  const sku = `sku_conf_active_${userId}`;
  const live = subscriptionRow(`sub_conf_active_${userId}`, {
    userId,
    sellerId,
    sku,
  });
  const bySecondSeller = subscriptionRow(`sub_conf_active_two_${userId}`, {
    userId,
    sellerId: otherSeller,
    sku,
  });
  const closed = subscriptionRow(`sub_conf_active_closed_${userId}`, {
    userId,
    sellerId,
    sku: `${sku}_closed`,
    state: 'CANCELED',
  });

  assert.equal(
    await store.subscriptions.activeFor(userId, sku, sellerId),
    null,
    'nothing open on the key yet',
  );
  await store.transaction(async (unit) => {
    await unit.subscriptions.open(live);
    await unit.subscriptions.open(bySecondSeller);
    await unit.subscriptions.open(closed);
  });

  assert.equal(
    (await store.subscriptions.activeFor(userId, sku, sellerId))!.id,
    live.id,
  );
  assert.equal(
    (await store.subscriptions.activeFor(userId, sku, otherSeller))!.id,
    bySecondSeller.id,
    'the same user and sku from a second seller is a second subscription',
  );
  assert.equal(
    await store.subscriptions.activeFor(userId, `${sku}_closed`, sellerId),
    null,
    'a canceled row is not active',
  );
  assert.equal(
    await store.subscriptions.activeFor(freshUser(), sku, sellerId),
    null,
  );

  // Cancelling frees the key, which is what lets the user subscribe to the sku again.
  await store.subscriptions.cancel(live.id);
  assert.equal(
    await store.subscriptions.activeFor(userId, sku, sellerId),
    null,
  );
}

// The renewal sweep's claim. It takes ACTIVE rows whose period is up, bounded by `limit`, and both
// terminal marks take a row out of it for good — a lapse for an unpayable renewal, a cancel for a
// user who asked. A store that left either in the due set would keep charging a closed subscription.
async function claimsDueSubscriptionsUntilClosed(store: Store): Promise<void> {
  const userId = freshUser();
  const due = subscriptionRow(`sub_conf_due_${userId}`, {
    userId,
    nextDueAt: 1,
  });
  const alsoDue = subscriptionRow(`sub_conf_due_two_${userId}`, {
    userId,
    nextDueAt: 2,
  });
  const later = subscriptionRow(`sub_conf_due_later_${userId}`, {
    userId,
    nextDueAt: 500_000,
  });
  const canceled = subscriptionRow(`sub_conf_due_cancel_${userId}`, {
    userId,
    nextDueAt: 1,
  });
  const lapsed = subscriptionRow(`sub_conf_due_lapse_${userId}`, {
    userId,
    nextDueAt: 1,
  });
  const rows = [due, alsoDue, later, canceled, lapsed];
  const mine = new Set(rows.map((row) => row.id));

  await store.transaction(async (unit) => {
    for (const row of rows) {
      await unit.subscriptions.open(row);
    }
  });

  await store.subscriptions.cancel(canceled.id);
  await store.subscriptions.markLapsed(lapsed.id);
  assert.equal(
    (await store.subscriptions.load(canceled.id))!.state,
    'CANCELED',
  );
  assert.equal((await store.subscriptions.load(lapsed.id))!.state, 'LAPSED');

  // Filtered to this case's own rows: the claim reads the whole store, and every other
  // subscription case has left rows behind it.
  const claimed = await store.subscriptions.claimDue(2, 100);
  assert.deepEqual(
    claimed
      .filter((sub) => mine.has(sub.id))
      .map((sub) => sub.id)
      .sort(byCodeUnit),
    [due.id, alsoDue.id].sort(byCodeUnit),
    'ACTIVE and due only, so the later period, the cancel and the lapse stay out',
  );
  // The limit bounds the sweep's batch. Two of this case's own rows are due, so a store honouring
  // it returns exactly one whatever else is outstanding.
  assert.equal((await store.subscriptions.claimDue(2, 1)).length, 1);

  // Both terminal marks are no-ops on an id the store does not hold.
  const missing = `sub_conf_due_missing_${userId}`;
  await store.subscriptions.cancel(missing);
  await store.subscriptions.markLapsed(missing);
  assert.equal(await store.subscriptions.load(missing), null);
}

// `lastPayoutAt` enforces the minimum interval between payout requests, so it reads across every
// state — a settled or failed payout still happened. Null for a user with no sagas is what makes a
// first request always allowed.
async function reportsTheLatestPayoutTime(store: Store): Promise<void> {
  const userId = freshUser();
  const other = freshUser();
  const open = (suffix: string, overrides: Partial<Saga>): Promise<void> =>
    store.sagas.open(
      sagaRow(`pay_conf_last_${suffix}_${userId}`, userId, overrides),
    );

  assert.equal(
    await store.sagas.lastPayoutAt(userId),
    null,
    'no sagas, so a first request is always allowed',
  );

  await open('a', { updatedAt: 1_000 });
  assert.equal(await store.sagas.lastPayoutAt(userId), 1_000);

  await open('b', { state: 'SETTLED', updatedAt: 4_000 });
  assert.equal(
    await store.sagas.lastPayoutAt(userId),
    4_000,
    'a terminal saga still counts',
  );

  await open('c', { updatedAt: 2_000 });
  assert.equal(
    await store.sagas.lastPayoutAt(userId),
    4_000,
    'the max never undershoots the latest request',
  );

  assert.equal(await store.sagas.lastPayoutAt(other), null, 'one user only');
}

// This walks the accrual store's whole lifecycle in one pass. Ids are run-unique because the SQL backends
// persist rows across runs.
async function accrualRowsLifecycle(store: Store): Promise<void> {
  const orderId = `ord_${randomUUID()}`;
  const sellerId = freshUser();
  const share = decodeAmount('7.00', 'CREDIT');
  const debt = decodeAmount('-3.00', 'CREDIT');
  const shard = SYSTEM.SETTLEMENT_ACCRUAL;

  await store.transaction((unit) =>
    unit.accruals.put([
      {
        orderId,
        sellerId,
        seq: 0,
        amount: share,
        shard,
        status: 'pending',
        txnId: `txn_${orderId}`,
        settledTxnId: null,
        recordedAt: 5,
      },
      {
        orderId,
        sellerId,
        seq: 1,
        amount: debt,
        shard,
        status: 'pending',
        txnId: `txn_${orderId}`,
        settledTxnId: null,
        recordedAt: 5,
      },
    ]),
  );

  const byOrder = await store.transaction((unit) =>
    unit.accruals.claimByOrder(orderId),
  );
  assert.equal(byOrder.length, 2);
  assert.deepEqual(byOrder[0]!.amount, share);
  assert.equal(byOrder[1]!.amount.minor, debt.minor);

  const sellers = await store.transaction((unit) =>
    unit.accruals.pendingSellers(1_000),
  );
  assert.equal(sellers.includes(sellerId), true);
  assert.equal(
    await store.accruals.netPending(sellerId),
    share.minor + debt.minor,
  );

  await store.transaction(async (unit) => {
    const pending = await unit.accruals.claimPendingBySeller(sellerId, 10);
    assert.equal(pending.length, 2);
    await unit.accruals.markDrained(
      pending.map(({ orderId: o, sellerId: s, seq }) => ({
        orderId: o,
        sellerId: s,
        seq,
      })),
      'txn_drain',
    );
  });

  // Terminal rows survive as the share record but leave every pending view.
  const after = await store.transaction((unit) =>
    unit.accruals.claimByOrder(orderId),
  );
  assert.equal(
    after.every((row) => row.status === 'drained'),
    true,
  );
  // The creator posting stays on the row. The settling posting lands beside it.
  assert.equal(
    after.every((row) => row.txnId === `txn_${orderId}`),
    true,
  );
  assert.equal(
    after.every((row) => row.settledTxnId === 'txn_drain'),
    true,
  );
  assert.equal(await store.accruals.netPending(sellerId), 0n);
  const drained = await store.transaction((unit) =>
    unit.accruals.claimPendingBySeller(sellerId, 10),
  );
  assert.equal(drained.length, 0);

  // A second mark is a no-op: the status guard keeps a terminal row terminal.
  await store.transaction((unit) =>
    unit.accruals.markRefunded([{ orderId, sellerId, seq: 0 }], 'txn_other'),
  );
  const still = await store.transaction((unit) =>
    unit.accruals.claimByOrder(orderId),
  );
  assert.equal(still[0]!.status, 'drained');
}

// lineage with `sinceHash` streams only the links recorded after the named head — the
// incremental seal's tail read — and an unknown hash streams nothing rather than everything.
async function lineageSinceStreamsTheTail(store: Store): Promise<void> {
  const userId = freshUser();
  await store.transaction(async (unit) => {
    await fundSpendable(unit, userId, '1.00', `txn_conf_since_a_${userId}`);
    await fundSpendable(unit, userId, '2.00', `txn_conf_since_b_${userId}`);
    await fundSpendable(unit, userId, '3.00', `txn_conf_since_c_${userId}`);
  });
  const full = await collect(store.ledger.lineage(spendable(userId)));
  assert.equal(full.length, 3);

  const tail = await collect(
    store.ledger.lineage(spendable(userId), { sinceHash: full[0]!.hash }),
  );
  assert.deepEqual(
    tail.map((link) => link.txnId),
    [full[1]!.txnId, full[2]!.txnId],
  );
  assert.equal(tail[0]!.prevHash, full[0]!.hash);

  const none = await collect(
    store.ledger.lineage(spendable(userId), { sinceHash: 'f'.repeat(64) }),
  );
  assert.equal(none.length, 0);
}

// Positive shares must claim ahead of recovery rows whatever their age, so a deep recovery
// backlog can never crowd every share out of the claim window and stall the seller's drain.
async function accrualClaimsPositivesFirst(store: Store): Promise<void> {
  const orderId = `ord_${randomUUID()}`;
  const sellerId = freshUser();
  const row = (seq: number, minor: bigint, recordedAt: number) => ({
    orderId,
    sellerId,
    seq,
    amount: toAmount('CREDIT', minor),
    shard: SYSTEM.SETTLEMENT_ACCRUAL,
    status: 'pending' as const,
    txnId: `txn_${orderId}`,
    settledTxnId: null,
    recordedAt,
  });
  await store.transaction((unit) =>
    // This seeds two older recovery rows and one newer share.
    unit.accruals.put([row(0, -100n, 1), row(1, -100n, 2), row(2, 500n, 9)]),
  );
  const claimed = await store.transaction((unit) =>
    unit.accruals.claimPendingBySeller(sellerId, 2),
  );
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0]!.amount.minor, 500n);
  assert.equal(claimed[1]!.amount.minor, -100n);
}

// The pending-backlog gauge, and the claim it makes is narrower than "sum the pending rows": only
// the positives count, because a refund debt is money the drain has to recover, not money it owes
// out. The prover reconciles this total against the ACCRUAL shards' balance, so a store folding the
// negatives in would report a shortfall that is not there.
async function gaugesPositivePendingAccruals(store: Store): Promise<void> {
  const orderId = `ord_${randomUUID()}`;
  const sellerId = freshUser();
  const share = decodeAmount('9.00', 'CREDIT');
  const debt = decodeAmount('-4.00', 'CREDIT');
  const row = (seq: number, amount: typeof share) => ({
    orderId,
    sellerId,
    seq,
    amount,
    shard: SYSTEM.SETTLEMENT_ACCRUAL,
    status: 'pending' as const,
    txnId: `txn_${orderId}`,
    settledTxnId: null,
    recordedAt: 1_000,
  });

  // Read as a delta: the gauge covers the whole store and the cases above have left rows behind.
  const before = await store.accruals.stats();
  await store.transaction((unit) =>
    unit.accruals.put([row(0, share), row(1, debt)]),
  );

  const pending = await store.accruals.stats();
  assert.equal(
    pending.pendingMinor - before.pendingMinor,
    share.minor,
    'the debt row is in the backlog and out of its total',
  );
  // The age is read as present and finite, not compared: `recordedAt` is measured against the
  // store's own clock, which the suite cannot set.
  assert.notEqual(pending.oldestPendingAgeMs, null);
  assert.equal(Number.isFinite(pending.oldestPendingAgeMs), true);

  await store.transaction(async (unit) => {
    const claimed = await unit.accruals.claimPendingBySeller(sellerId, 10);
    assert.equal(claimed.length, 2);
    await unit.accruals.markDrained(
      claimed.map(({ orderId: o, sellerId: s, seq }) => ({
        orderId: o,
        sellerId: s,
        seq,
      })),
      `txn_drain_${orderId}`,
    );
  });
  assert.equal(
    (await store.accruals.stats()).pendingMinor,
    before.pendingMinor,
    'a drained row leaves the gauge',
  );
}

// A rolled-back transaction leaves no accrual rows behind, like every other sub-store.
async function accrualPutRollsBack(store: Store): Promise<void> {
  const orderId = `ord_${randomUUID()}`;
  const sellerId = freshUser();
  await assert.rejects(
    store.transaction(async (unit) => {
      await unit.accruals.put([
        {
          orderId,
          sellerId,
          seq: 0,
          amount: decodeAmount('1.00', 'CREDIT'),
          shard: SYSTEM.SETTLEMENT_ACCRUAL,
          status: 'pending',
          txnId: 'txn_rollback',
          settledTxnId: null,
          recordedAt: 0,
        },
      ]);
      throw new Error('boom');
    }),
  );
  const rows = await store.transaction((unit) =>
    unit.accruals.claimByOrder(orderId),
  );
  assert.equal(rows.length, 0);
}

// links(txnId) answers one link per touched account, byte-identical to what lineage streams —
// the verified-read path depends on this fidelity on every adapter.
async function linksMatchLineage(store: Store): Promise<void> {
  const userId = freshUser();
  const txnId = `txn_conf_links_${userId}`;
  await store.transaction((unit) => fundSpendable(unit, userId, '4.00', txnId));

  const links = await store.ledger.links(txnId);
  assert.equal(links.length, 2); // the funding contra account and the user's spendable
  const own = links.find((link) => link.account === spendable(userId));
  assert.notEqual(own, undefined);

  const lineage = await collect(store.ledger.lineage(spendable(userId)));
  const recorded = lineage.find((link) => link.txnId === txnId);
  assert.equal(own!.hash, recorded!.hash);
  assert.equal(own!.prevHash, recorded!.prevHash);
  assert.deepEqual(await store.ledger.links(`txn_missing_${userId}`), []);
}

// linksPage walks the whole log in commit order on a resumable cursor, whole postings per page,
// carrying each link's legs and metadata — the rolling re-proof's read.
async function linksPageWalksTheLog(store: Store): Promise<void> {
  const userId = freshUser();
  const minted = [
    `txn_conf_page_a_${userId}`,
    `txn_conf_page_b_${userId}`,
    `txn_conf_page_c_${userId}`,
  ];
  await store.transaction(async (unit) => {
    for (const txnId of minted) {
      await fundSpendable(unit, userId, '1.00', txnId);
    }
  });

  const seen = new Set<string>();
  let cursor: number | null = null;
  for (;;) {
    const page = await store.ledger.linksPage(cursor, 500);
    for (const link of page.links) {
      if (link.txnId === minted[0] && link.account === spendable(userId)) {
        // Content rides the page: the legs and metadata the re-proof re-hashes.
        assert.equal(link.legs.length, 2);
        assert.equal(link.meta.source, 'card');
      }
      if (minted.includes(link.txnId)) {
        seen.add(`${link.txnId}|${link.account}`);
      }
    }
    if (page.cursor === null) {
      break;
    }
    cursor = page.cursor;
  }
  // Every minted posting's links surfaced exactly once across the walk.
  assert.equal(seen.size, minted.length * 2);
}

// The reproof watermark round-trips.
async function reproofStateRoundTrips(store: Store): Promise<void> {
  await store.checkpoints.putReproof!({ cursor: 42, rotatedAt: 7 });
  assert.deepEqual(await store.checkpoints.reproof!(), {
    cursor: 42,
    rotatedAt: 7,
  });
  await store.checkpoints.putReproof!({ cursor: null, rotatedAt: 7 });
  assert.deepEqual(await store.checkpoints.reproof!(), {
    cursor: null,
    rotatedAt: 7,
  });
}

// Several postings in one round trip must behave exactly like sequential appends — including
// chain threading when the postings share an account, the case the fused operations avoid but
// the engine must still get right.
async function appendAllThreadsChains(store: Store): Promise<void> {
  const userId = freshUser();
  const amountOf = (dollars: string) => decodeAmount(dollars, 'CREDIT');
  const posting = (txnId: string, dollars: string) => ({
    txnId,
    legs: [
      credit(spendable(userId), amountOf(dollars)),
      debit(SYSTEM.REVENUE, amountOf(dollars)),
    ],
    meta: { source: 'card' },
  });
  const [first, second] = await store.ledger.appendAll!([
    posting(`txn_conf_all_a_${userId}`, '1.00'),
    posting(`txn_conf_all_b_${userId}`, '2.00'),
  ]);

  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 300n),
  );
  const lineage = await collect(store.ledger.lineage(spendable(userId)));
  assert.deepEqual(
    lineage.map((link) => link.txnId),
    [first!.id, second!.id],
  );
  // The second posting chained onto the first's new head, exactly as sequential appends would.
  assert.equal(lineage[1]!.prevHash, lineage[0]!.hash);
  const heads = new Map(await collect(store.ledger.heads()));
  assert.equal(heads.get(spendable(userId)), lineage[1]!.hash);
}

// This runs a batch bigger than the 64-item savepoint cliff, with one failing item in the middle.
// The engine's own strategy must produce identical slots — 79 committed exactly once, the failure
// isolated to its slot with no legs left behind.
async function batchSurvivesLargeBatches(store: Store): Promise<void> {
  const users = Array.from({ length: 80 }, () => freshUser());
  const failAt = 40;
  const slots = await store.batchTransaction!(
    users.map((userId, i) => async (unit: Unit) => {
      const txn = await fundSpendable(
        unit,
        userId,
        '1.00',
        `txn_conf_big_${userId}`,
      );
      if (i === failAt) {
        throw new Error('boom');
      }
      return txn;
    }),
  );
  assert.equal(slots.length, 80);
  assert.equal(slots.filter((slot) => slot.ok).length, 79);
  assert.equal(slots[failAt]!.ok, false);
  assert.deepEqual(
    await store.ledger.derivedBalances(spendable(users[failAt]!)),
    [],
  );
  assert.deepEqual(
    await store.ledger.balance(spendable(users[0]!)),
    toAmount('CREDIT', 100n),
  );
  assert.deepEqual(
    await store.ledger.balance(spendable(users[79]!)),
    toAmount('CREDIT', 100n),
  );
}

// A failing item's savepoint rolls back that item alone. Its batch-mates' writes commit together.
async function batchIsolatesFailedItems(store: Store): Promise<void> {
  const alice = freshUser();
  const bob = freshUser();
  const slots = await store.batchTransaction!([
    (unit) => fundSpendable(unit, alice, '5.00', `txn_conf_batch_a_${alice}`),
    async (unit) => {
      await fundSpendable(unit, bob, '9.00', `txn_conf_batch_b_${bob}`);
      throw new Error('boom');
    },
    (unit) => fundSpendable(unit, bob, '2.50', `txn_conf_batch_c_${bob}`),
  ]);
  assert.equal(slots.length, 3);
  assert.equal(slots[0]!.ok, true);
  assert.equal(slots[1]!.ok, false);
  assert.equal(slots[2]!.ok, true);
  // The failed item's 9.00 vanished; its batch-mates' money landed.
  assert.deepEqual(
    await store.ledger.balance(spendable(alice)),
    toAmount('CREDIT', 500n),
  );
  assert.deepEqual(
    await store.ledger.balance(spendable(bob)),
    toAmount('CREDIT', 250n),
  );
}

// A probe hit inside a transaction can be the item's own uncommitted plant, so it must stage
// for commit-promotion, never enter the store-wide known-set directly. After the item's
// savepoint rollback the account's rows are gone, and a poisoned cache would skip the re-plant
// and fail the next posting on the legs foreign key until restart.
async function batchRollbackForgetsFirstUsedAccounts(
  store: Store,
): Promise<void> {
  const userId = freshUser();
  const slots = await store.batchTransaction!([
    async (unit) => {
      // There are two postings. The first plants the brand-new account, and the second's probe
      // hits that uncommitted plant. The throw then rolls both back to the item's savepoint.
      await fundSpendable(unit, userId, '1.00', `txn_conf_replant_a_${userId}`);
      await fundSpendable(unit, userId, '2.00', `txn_conf_replant_b_${userId}`);
      throw new Error('boom');
    },
  ]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0]!.ok, false);
  assert.deepEqual(await store.ledger.derivedBalances(spendable(userId)), []);
  // The fresh transaction must plant the account again. A poisoned cache fails right here.
  await store.transaction((unit) =>
    fundSpendable(unit, userId, '3.00', `txn_conf_replant_c_${userId}`),
  );
  assert.deepEqual(
    await store.ledger.balance(spendable(userId)),
    toAmount('CREDIT', 300n),
  );
}

// The retention surfaces (src/worker/retention.ts) are optional; engines without them skip.
async function retentionDeletesOldIdempotencyRows(store: Store): Promise<void> {
  const remove = store.idempotency.deleteOlderThan!.bind(store.idempotency);
  const user = freshUser();
  const txn = await store.transaction((unit) =>
    fundSpendable(unit, user, '3.00', `txn_conf_ret_${user}`),
  );
  const keys = [`ret_${user}_a`, `ret_${user}_b`, `ret_${user}_c`];
  for (const key of keys) {
    assert.deepEqual(await store.idempotency.claim(key), { claimed: true });
    await store.idempotency.record(key, txn);
  }
  // A recorded key replays. No row was born before epoch 0, so a zero cutoff deletes nothing.
  assert.equal((await store.idempotency.claim(keys[0]!)).claimed, false);
  assert.equal(await remove(0, 1000), 0);
  // A future cutoff catches every row, oldest first, capped by the limit.
  const cutoff = Date.now() + 600_000;
  assert.equal(await remove(cutoff, 2), 2);
  assert.ok((await remove(cutoff, 1000)) >= 1);
  // The deleted keys are open again: a duplicate request would re-execute.
  assert.deepEqual(await store.idempotency.claim(keys[0]!), { claimed: true });
}

async function retentionPrunesSessionJournalRows(store: Store): Promise<void> {
  const prune = store.movements.pruneSession!.bind(store.movements);
  const keep = `sess_conf_keep_${randomUUID()}`;
  const drop = `sess_conf_drop_${randomUUID()}`;
  await store.movements.append([
    movementRow(keep, 0, `${keep}_m0`),
    movementRow(drop, 0, `${drop}_m0`),
    movementRow(drop, 1, `${drop}_m1`),
  ]);
  assert.equal(await prune(drop), 2);
  assert.deepEqual(await collect(store.movements.bySession(drop)), []);
  const ids = await collect(store.movements.sessionIds!());
  assert.ok(!ids.includes(drop));
  assert.ok(ids.includes(keep));
  // The pruned rows' idempotency keys and (sessionId, seq) positions are free again.
  await store.movements.append([movementRow(drop, 0, `${drop}_m0`)]);
  assert.equal(await prune(drop), 1);
}

async function tableSizesGaugeTracksGrowth(store: Store): Promise<void> {
  const sizes = store.tableSizes!.bind(store);
  const before = await sizes();
  for (const value of Object.values(before)) {
    assert.ok(value >= 0);
  }
  const session = `sess_conf_sizes_${randomUUID()}`;
  await store.movements.append([
    movementRow(session, 0, `${session}_m0`),
    movementRow(session, 1, `${session}_m1`),
    movementRow(session, 2, `${session}_m2`),
  ]);
  const key = `sizes_${randomUUID()}`;
  assert.deepEqual(await store.idempotency.claim(key), { claimed: true });
  // Two purchases of one sku are two rows, because rows are keyed by granting source; revoking
  // one is a soft delete, so the gauge still counts it.
  const userId = freshUser();
  await store.transaction(async (unit) => {
    await unit.entitlements.grant(userId, 'sku_conf_sizes', {
      source: 'sale:ord_sizes_1',
    });
    await unit.entitlements.grant(userId, 'sku_conf_sizes', {
      source: 'sale:ord_sizes_2',
    });
  });
  await store.transaction((unit) =>
    unit.entitlements.revoke(userId, 'sku_conf_sizes', {
      source: 'sale:ord_sizes_1',
    }),
  );
  const after = await sizes();
  assert.equal(after.movements - before.movements, 3);
  assert.equal(after.idempotency - before.idempotency, 1);
  assert.equal(after.entitlements - before.entitlements, 2);
}

/** How a store describes itself to the suite. */
export interface StoreConformanceOptions {
  /**
   * What the implementation believes it offers. The suite resolves the truth by looking at the
   * store and refuses any capability the two disagree on, so this is a claim to be checked
   * rather than configuration to be obeyed. Omitted capabilities are resolved and not checked.
   */
  capabilities?: Partial<Record<StoreCapability, boolean>>;
}

// Which registered tests exercise each capability. A capability resolving true with no test
// naming it is a surface the suite would certify without ever calling it, so the gate below fails
// instead of reporting a pass. `test/conformance-contract.test.ts` reads this file's source and
// resolves every title here to a `test(...)` in it, which is why the gate below only has to ask
// whether an offered capability names anything.
export const CAPABILITY_TESTS: Record<StoreCapability, string[]> = {
  appendAll: ['appendAll threads chains exactly like sequential appends'],
  archive: ['round-trips the archival boundary and moves whole postings'],
  batchTransaction: [
    'rolls a batch item back to its savepoint without touching its batch-mates',
    'isolates one failure in a batch past the savepoint cliff',
    're-plants an account whose first use rolled back with its batch item',
  ],
  historySize: ['counts every stored posting in the history-size gauge'],
  idempotencyRetention: [
    'deletes idempotency rows past the cutoff up to the limit',
  ],
  journalRetention: [
    'prunes one session from the journal and frees its keys and positions',
  ],
  journalSessionIds: ['enumerates journaled session ids exactly once each'],
  lockMany: [
    'holds locked accounts against a concurrent transaction until commit',
  ],
  reproof: ['round-trips the rolling re-proof watermark'],
  reservations: ['keeps the reservation counter exact under concurrent adds'],
  sealHeads: ['upserts sealed head leaves and rewrites them all on replaceAll'],
  tableSizes: ['gauges secondary-table sizes and tracks growth'],
};

/**
 * The thrown reason, worded for a skip. A refused `pg` connect arrives as an `AggregateError` whose
 * own `message` is empty and whose reasons live in `errors`, so reading `message` alone produced a
 * skip that named nothing — `backend unreachable: ` and then the end of the line.
 */
function reasonOf(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors
      .map((reason) =>
        reason instanceof Error ? reason.message : String(reason),
      )
      .filter((message) => message !== '');
    const all = [error.message, ...inner].filter((message) => message !== '');
    if (all.length > 0) return all.join('; ');
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

/**
 * Registers the shared conformance suite every {@link Store} implementation must pass — the same
 * tests the built-in memory, Postgres, and MySQL stores run, with the memory adapter as the
 * oracle — so a custom store cannot silently diverge from the ledger invariants. The suite is
 * written for `node --test`. Called at the top level of a test file, it declares one `describe`
 * block. A test that needs an optional surface the store does not offer skips and names the
 * missing {@link StoreCapability}.
 *
 * The factory runs once in a `before` hook. If it throws, every test skips and names the thrown
 * reason instead of failing the suite — the connect-or-skip contract that lets the suite sit in
 * CI jobs with no backend provisioned. A store the factory did produce is closed in the `after`
 * hook.
 *
 * @example
 * import { runStoreConformance } from '@pwngh/economy-conformance';
 * import { myStore } from './my-store.js';
 *
 * runStoreConformance('my-store', () => myStore(process.env.DATABASE_URL!));
 * // node --test runs the suite; passing proves the store upholds the built-ins' contract
 */
export function runStoreConformance(
  name: string,
  makeStore: () => Promise<Store> | Store,
  options: StoreConformanceOptions = {},
): void {
  describe(`Store Conformance: ${name}`, () => {
    // Shadows node:test's `test` for the rest of this suite: every case below is one test in
    // every driver's total, and the count belongs here rather than in a package's tally.
    const test = countedCases('runStoreConformance', 79, (name, body) =>
      nodeTest(name, body),
    );

    // The probe runs once. If makeStore throws, every test below skips rather than the before hook
    // failing the suite — the connect-or-skip contract ci.yml's no-services `check` job relies on.
    let store: Store | null = null;
    let capabilities: Record<StoreCapability, boolean> | null = null;
    let unreachable = 'backend unreachable';

    before(async () => {
      try {
        const live = await makeStore();
        store = live;
        // Ledger capabilities resolve inside a transaction, because that is the only level at
        // which locking means anything and the two levels genuinely disagree: Postgres carries
        // lockMany on the unit's ledger and not on the store's.
        await live.transaction(async (unit) => {
          capabilities = capabilitiesOf(live, unit);
        });
      } catch (error) {
        store = null;
        // The message names the reason, because a silent skip disguises a provisioning failure as "no backend configured".
        unreachable = `backend unreachable: ${reasonOf(error)}`;
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

    // A store that lacks the surface skips by name. The skip is the point: an absent capability
    // used to be an early return inside the test body, which reported a pass having asserted
    // nothing at all.
    const needs = (
      t: TestContext,
      capability: StoreCapability,
      body: (s: Store) => Promise<void> | void,
    ): Promise<void> | void => {
      if (!store || !capabilities) {
        return t.skip(`${name} ${unreachable}`);
      }
      return capabilities[capability]
        ? body(store)
        : t.skip(`${name} does not offer ${capability}`);
    };

    test('carries every capability it declares', (t) =>
      withStore(t, () => {
        assert.deepEqual(
          capabilityConflicts(capabilities!, options.capabilities ?? {}),
          [],
        );
      }));
    test('names a test for every capability it offers', (t) =>
      withStore(t, () => {
        let examined = 0;
        for (const capability of STORE_CAPABILITIES) {
          examined += 1;
          if (!capabilities![capability]) {
            continue;
          }
          assert.notEqual(
            CAPABILITY_TESTS[capability].length,
            0,
            `${name} offers ${capability} and no test names it`,
          );
        }
        // The count is what proves the walk happened. A list of gaps that comes back empty
        // proves nothing.
        assert.equal(examined, STORE_CAPABILITIES.length);
      }));

    test('appends a posting and round-trips the balance as a bigint Amount', (t) =>
      withStore(t, appendRoundTripsBalance));
    test('re-derives per-currency balances from the legs alone', (t) =>
      withStore(t, derivesBalancesFromLegs));
    test('lays a statement out in commit order, legs inside a posting included', (t) =>
      withStore(t, statementRunsInCommitOrder));
    test('streams settlement lots oldest-first, paged, and skips spend legs', (t) =>
      withStore(t, streamsTimelineLotsOldestFirst));
    test('skips a lowering leg on a posting that raises the same account', (t) =>
      withStore(t, skipsALoweringLegOnARaisingPosting));
    test('answers the memory oracle read for read over one written-out workload', (t) =>
      withStore(t, agreesWithTheMemoryOracle));
    test('pairs every chain head with its raw leg sum', (t) =>
      withStore(t, pairsHeadsWithRawSums));
    test('round-trips v1 and v2 checkpoint rows through the store', (t) =>
      withStore(t, roundTripsCheckpointRows));
    test('upserts sealed head leaves and rewrites them all on replaceAll', (t) =>
      needs(t, 'sealHeads', roundTripsSealedHeadLeaves));
    test('grants, checks, revokes, and regrants entitlements', (t) =>
      withStore(t, grantsOwnsRevokesEntitlements));
    test('applies entitlement expiry at read time', (t) =>
      withStore(t, appliesExpiryAtReadTime));
    test('lists non-revoked entitlement grants sorted by sku', (t) =>
      withStore(t, listsNonRevokedGrantsSorted));
    test('revokes one grant source and leaves the sku owned by the other', (t) =>
      withStore(t, revokesOneSourceAndKeepsTheOther));
    test('round-trips a sale summary and drops it when its charge rolls back', (t) =>
      withStore(t, roundTripsSaleAndDropsItOnRollback));
    test('counts a velocity attempt once per idempotency key, denials included', (t) =>
      withStore(t, countsVelocityAttemptsOncePerKey));
    test('walks accrual rows through put, claims, terminal marks, and the net', (t) =>
      withStore(t, accrualRowsLifecycle));
    test('gauges the positive pending accrual backlog and its age', (t) =>
      withStore(t, gaugesPositivePendingAccruals));
    test('claims positive accrual shares ahead of older recovery rows', (t) =>
      withStore(t, accrualClaimsPositivesFirst));
    test('streams a lineage tail from sinceHash and nothing from an unknown hash', (t) =>
      withStore(t, lineageSinceStreamsTheTail));
    test("answers a posting's chain links byte-identical to its lineage", (t) =>
      withStore(t, linksMatchLineage));
    test('pages every stored chain link with content on a resumable cursor', (t) =>
      withStore(t, linksPageWalksTheLog));
    test('round-trips the rolling re-proof watermark', (t) =>
      needs(t, 'reproof', reproofStateRoundTrips));
    test('drops accrual rows when their putting transaction rolls back', (t) =>
      withStore(t, accrualPutRollsBack));
    test('appends movement batches and streams them back by session', (t) =>
      withStore(t, journalAppendsAndStreamsBySession));
    test('rejects a movement batch on a duplicate key or position', (t) =>
      withStore(t, journalRejectsDuplicateBatches));
    test('enumerates journaled session ids exactly once each', (t) =>
      needs(t, 'journalSessionIds', journalEnumeratesSessions));
    test('keeps the reservation counter exact under concurrent adds', (t) =>
      needs(t, 'reservations', reservationCounterIsExact));
    test('round-trips the archival boundary and moves whole postings', (t) =>
      needs(t, 'archive', archiveSurfacesRoundTrip));
    test('commits a transaction durably and leaves no trace when one throws', (t) =>
      withStore(t, commitsDurablyAndRollsBack));
    test('rolls a batch item back to its savepoint without touching its batch-mates', (t) =>
      needs(t, 'batchTransaction', batchIsolatesFailedItems));
    test('isolates one failure in a batch past the savepoint cliff', (t) =>
      needs(t, 'batchTransaction', batchSurvivesLargeBatches));
    test('re-plants an account whose first use rolled back with its batch item', (t) =>
      needs(t, 'batchTransaction', batchRollbackForgetsFirstUsedAccounts));
    test('appendAll threads chains exactly like sequential appends', (t) =>
      needs(t, 'appendAll', appendAllThreadsChains));
    test('claims an idempotency key once and replays the recorded transaction', (t) =>
      withStore(t, claimsOnceAndReplays));
    test('frees an idempotency key when its claiming transaction rolls back', (t) =>
      withStore(t, freesKeyOnRollback));
    test('drops a recorded idempotency key when its transaction rolls back', (t) =>
      withStore(t, dropsRecordedKeyOnRollback));
    test('grants account locks without deadlocking', (t) =>
      withStore(t, grantsLocksWithoutDeadlock));
    test('holds locked accounts against a concurrent transaction until commit', (t) =>
      needs(t, 'lockMany', lockManyExcludesAConcurrentWriter));
    test('counts every stored posting in the history-size gauge', (t) =>
      needs(t, 'historySize', historySizeCountsEveryPosting));
    test('enqueues the outbox in the posting tx and relays once with consumer dedup', (t) =>
      withStore(t, relaysOutboxOnce));
    test('drops the outbox row when its enqueuing transaction rolls back', (t) =>
      withStore(t, dropsOutboxOnRollback));
    test('counts an outbox delivery attempt then dead-letters a poison message', (t) =>
      withStore(t, countsOutboxAttemptsThenDeadLetters));
    test('enqueues the inbox in the webhook tx and applies once, never re-claiming', (t) =>
      withStore(t, appliesInboxOnce));
    test('drops the inbox row when its enqueuing transaction rolls back', (t) =>
      withStore(t, dropsInboxOnRollback));
    test('dedupes the inbox by provider event id, returning the existing row', (t) =>
      withStore(t, dedupesInboxByKey));
    test('bumps an inbox apply attempt then dead-letters a poison event', (t) =>
      withStore(t, bumpsInboxAttemptThenDeadLetters));
    test('hands an unmarked row back on a later claim, so a short claim strands nothing', (t) =>
      withStore(t, reOffersEveryUnmarkedRow));
    test('reports the pending outbox backlog depth and oldest age', (t) =>
      withStore(t, reportsOutboxBacklogStats));
    test('revives dead inbox rows oldest-first with attempts reset', (t) =>
      withStore(t, revivesDeadInboxRowsOldestFirst));
    test('recomputes a per-account chain head deterministically over the digest', (t) =>
      withStore(t, recomputesChainHead));
    test('stores a posting with multiple debit/credit lines to one account', (t) =>
      withStore(t, storesMultipleLegsToOneAccount));
    test('reverses a promo grant exactly once after it is due', (t) =>
      withStore(t, reversesPromoGrantExactlyOnce));
    test('claims due promo grants oldest first up to the limit', (t) =>
      withStore(t, claimsDuePromosOldestFirstUpToLimit));
    test('lists every live promo grant for one user and nobody else', (t) =>
      withStore(t, listsEveryLivePromoGrantForOneUser));
    test('streams every promo holder once, closed grants included', (t) =>
      withStore(t, streamsEveryPromoHolderOnce));
    test('claims a webhook event id once and dedups every redelivery', (t) =>
      withStore(t, claimsWebhookEventIdOnce));
    test('enumerates an account that has a stored balance row', (t) =>
      withStore(t, balanceAccountsEnumeratesBalanceRow));
    test('lists balance-row accounts in code-unit order on every engine', (t) =>
      withStore(t, balanceAccountsListsInCodeUnitOrder));
    test('bills a subscription via compare-and-set so a stale renewal run is rejected', (t) =>
      withStore(t, markBilledIsCompareAndSet));
    test('refuses a same-state advance whose expected attempt count has moved', (t) =>
      withStore(t, advanceComparesExpectedAttempts));
    test('lists every saga newest-first regardless of state', (t) =>
      withStore(t, listsSagasNewestFirst));
    test('filters the saga list to exactly the named states', (t) =>
      withStore(t, listsSagasFilteredByState));
    test('breaks a saga-list updatedAt tie by id descending', (t) =>
      withStore(t, listsSagasTiedOnUpdatedAtByIdDescending));
    test('filters the saga list to one user, pushed down on every engine', (t) =>
      withStore(t, listsSagasForOneUser));
    test("lists one user's subscriptions, every state, newest first", (t) =>
      withStore(t, listsSubscriptionsForOneUser));
    test('finds the one active subscription on a (user, sku, seller) key', (t) =>
      withStore(t, findsTheOneActiveSubscription));
    test('claims due subscriptions until a cancel or a lapse closes them', (t) =>
      withStore(t, claimsDueSubscriptionsUntilClosed));
    test("reports the user's latest payout time across every saga state", (t) =>
      withStore(t, reportsTheLatestPayoutTime));
    test('persists a payout terminal outcome (settled USD / failed reason) on the saga', (t) =>
      withStore(t, persistsTerminalOutcomeOnTheSaga));
    test('finds a saga by provider ref, newest first on a duplicated ref', (t) =>
      withStore(t, findsSagaByProviderRef));
    test('claims only RESERVED and SUBMITTED due sagas, never REQUESTED or terminal', (t) =>
      withStore(t, claimsOnlyInProgressDueSagas));
    test('lists every posting newest-first with its full legs', (t) =>
      withStore(t, listsPostingsNewestFirst));
    test('streams an account lineage in commit order (read.lineage)', (t) =>
      withStore(t, streamsAccountLineageInOrder));
    test('deletes idempotency rows past the cutoff up to the limit', (t) =>
      needs(t, 'idempotencyRetention', retentionDeletesOldIdempotencyRows));
    test('prunes one session from the journal and frees its keys and positions', (t) =>
      needs(t, 'journalRetention', retentionPrunesSessionJournalRows));
    test('gauges secondary-table sizes and tracks growth', (t) =>
      needs(t, 'tableSizes', tableSizesGaugeTracksGrowth));
  });
}
