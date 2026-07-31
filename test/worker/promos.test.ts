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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { sweepExpiredPromos } from '#src/worker/promos.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { fault } from '#src/errors.ts';
import { sequentialIds } from '#src/runtime.ts';
import { promo, spendable, SYSTEM } from '#src/accounts.ts';
import { seededDigest, makeWorkerCtx } from '#test/support/capabilities.ts';
import { economyWithStore } from '#test/support/economy.ts';
import {
  credit as creditOf,
  grantPromo as grantPromoOp,
  refund as refundOp,
  spend as spendOp,
} from '#test/support/builders.ts';

import type { Meter } from '#src/ports.ts';
import type { Posting, PromoGrant, Store, Unit } from '#src/ports.ts';

function capturingMeter(): {
  meter: Meter;
  counts: Array<{ name: string; n: number; outcome: string | undefined }>;
} {
  const counts: Array<{
    name: string;
    n: number;
    outcome: string | undefined;
  }> = [];
  return {
    meter: {
      count: (name, n, tags) =>
        counts.push({ name, n, outcome: tags?.outcome }),
      observe: () => {},
    },
    counts,
  };
}

// Mirrors operations/promo.ts: one transaction posts the balanced pair (promo account vs
// PROMO_FLOAT, the house pool that funds promos) and opens the grant row.
async function issueGrant(store: Store, grant: PromoGrant): Promise<void> {
  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: grant.id,
      legs: [
        debit(SYSTEM.PROMO_FLOAT, grant.amount),
        credit(promo(grant.userId), grant.amount),
      ],
      meta: { kind: 'grantPromo', expiresAt: grant.expiresAt },
    });
    await unit.promos.open(grant);
  });
}

// Posts one amount but files the row for another. The row is unhashed, so this is the shape the
// re-derivation check exists to catch, and editing the row is the only way to reach it.
async function issueGrantWithEditedRow(
  store: Store,
  grant: PromoGrant,
  rowMinor: bigint,
): Promise<void> {
  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: grant.id,
      legs: [
        debit(SYSTEM.PROMO_FLOAT, grant.amount),
        credit(promo(grant.userId), grant.amount),
      ],
      meta: { kind: 'grantPromo', expiresAt: grant.expiresAt },
    });
    await unit.promos.open({ ...grant, amount: toAmount('CREDIT', rowMinor) });
  });
}

// Drops the live promo balance below the grant, so expiry reverses only the leftover.
// REVENUE is just an arbitrary balanced destination.
async function spendPromo(
  unit: Unit,
  userId: string,
  minor: bigint,
): Promise<void> {
  const amount = toAmount('CREDIT', minor);
  await postEntry(unit.ledger, {
    txnId: `txn_spend_${userId}_${minor}`,
    legs: [debit(promo(userId), amount), credit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test.spend' },
  });
}

// The shape a refund's uncapped raise leaves on the promo pool: the sale's promo legs run
// backwards, so the pooled balance goes up whether or not a grant is still open to claim it.
async function restorePromo(
  unit: Unit,
  userId: string,
  minor: bigint,
): Promise<void> {
  const amount = toAmount('CREDIT', minor);
  await postEntry(unit.ledger, {
    txnId: `txn_refund_${userId}_${minor}`,
    legs: [debit(SYSTEM.PROMO_FLOAT, amount), credit(promo(userId), amount)],
    meta: { kind: 'test.refund' },
  });
}

// Every posting the ledger holds under one metadata `kind`.
async function postingsOfKind(store: Store, kind: string): Promise<Posting[]> {
  const found: Posting[] = [];
  for await (const posting of store.ledger.list()) {
    if (posting.meta.kind === kind) {
      found.push(posting);
    }
  }
  return found;
}

function grantOf(
  userId: string,
  id: string,
  minor: bigint,
  expiresAt: number,
): PromoGrant {
  return {
    id,
    userId,
    amount: toAmount('CREDIT', minor),
    expiresAt,
    reversed: false,
  };
}

// --- the unspent remainder is reversed --------------------------------------------

async function reversesAnUnspentExpiredGrantToPromoFloat(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  const floatBeforeGrant = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  const grant = grantOf('usr_a', 'txn_grant_a', 500n, 1_000);
  await issueGrant(store, grant);

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_a', amount: toAmount('CREDIT', 500n) },
  ]);
  assert.deepEqual(summary.failed, []);

  const promoBal = await store.ledger.balance(promo('usr_a'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));

  const floatAfter = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  assert.deepEqual(floatAfter, floatBeforeGrant);

  const again = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(again.reversed, []);
  await store.close();
}

async function reversesOnlyThePartTheUserDidNotSpend(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  const grant = grantOf('usr_b', 'txn_grant_b', 500n, 1_000);
  await issueGrant(store, grant);
  await store.transaction((unit) => spendPromo(unit, 'usr_b', 300n));

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_b', amount: toAmount('CREDIT', 200n) },
  ]);
  const promoBal = await store.ledger.balance(promo('usr_b'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));
  await store.close();
}

// --- a fully-spent grant reverses nothing -----------------------------------------

async function reversesNothingWhenTheGrantIsFullySpent(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  const grant = grantOf('usr_c', 'txn_grant_c', 500n, 1_000);
  await issueGrant(store, grant);
  await store.transaction((unit) => spendPromo(unit, 'usr_c', 500n));

  const floatBefore = await store.ledger.balance(SYSTEM.PROMO_FLOAT);

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // A fully-spent grant is still claimed and listed, with a reversed amount of 0.
  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_c', amount: toAmount('CREDIT', 0n) },
  ]);
  assert.deepEqual(summary.failed, []);

  const floatAfter = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  assert.deepEqual(floatAfter, floatBefore);

  const again = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(again.reversed, []);
  await store.close();
}

// --- two grants for one user never over-reverse -----------------------------------

async function neverOverReversesWhenOneUserHasTwoGrants(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_d', 'txn_grant_d1', 500n, 1_000));
  await issueGrant(store, grantOf('usr_d', 'txn_grant_d2', 500n, 3_000));
  await store.transaction((unit) => spendPromo(unit, 'usr_d', 800n));

  // The 800 spent took all of d1 and 300 of d2, so d1 has nothing left to claw back and the
  // 200 still pooled is d2's, which does not expire for another 2_000ms.
  const first = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(first.reversed, [
    { id: 'txn_grant_d1', amount: toAmount('CREDIT', 0n) },
  ]);
  const afterFirst = await store.ledger.balance(promo('usr_d'));
  assert.deepEqual(afterFirst, toAmount('CREDIT', 200n));

  const second = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 3_000,
    limit: 10,
  });
  assert.deepEqual(second.reversed, [
    { id: 'txn_grant_d2', amount: toAmount('CREDIT', 200n) },
  ]);

  // 200 across the pair, never the 1000 granted and never before each grant's own expiry.
  const promoBal = await store.ledger.balance(promo('usr_d'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));
  await store.close();
}

// Grants that expire together are ordered by id, so the pool splits the same way whichever is
// swept first and the pair still reverses only what is left.
async function splitsThePoolDeterministicallyWhenTwoGrantsExpireTogether(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_n', 'txn_grant_n1', 500n, 1_000));
  await issueGrant(store, grantOf('usr_n', 'txn_grant_n2', 500n, 1_000));
  await store.transaction((unit) => spendPromo(unit, 'usr_n', 800n));

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_n1', amount: toAmount('CREDIT', 0n) },
    { id: 'txn_grant_n2', amount: toAmount('CREDIT', 200n) },
  ]);
  const promoBal = await store.ledger.balance(promo('usr_n'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));
  await store.close();
}

async function reversesOnlyTheExpiringGrantsShareOfThePool(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_m', 'txn_grant_m1', 500n, 1_000));
  await issueGrant(store, grantOf('usr_m', 'txn_grant_m2', 600n, 4_000));
  await store.transaction((unit) => spendPromo(unit, 'usr_m', 400n));

  const first = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // The 400 spent came off the grant that expires first, so 100 of it is left to claw back.
  assert.deepEqual(first.reversed, [
    { id: 'txn_grant_m1', amount: toAmount('CREDIT', 100n) },
  ]);
  const afterFirst = await store.ledger.balance(promo('usr_m'));
  assert.deepEqual(afterFirst, toAmount('CREDIT', 600n));

  const second = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 4_000,
    limit: 10,
  });
  assert.deepEqual(second.reversed, [
    { id: 'txn_grant_m2', amount: toAmount('CREDIT', 600n) },
  ]);
  const afterSecond = await store.ledger.balance(promo('usr_m'));
  assert.deepEqual(afterSecond, toAmount('CREDIT', 0n));
  await store.close();
}

// --- claim cap and ordering -------------------------------------------------------

async function honorsTheClaimLimit(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_e', 'txn_grant_e1', 100n, 1_000));
  await issueGrant(store, grantOf('usr_f', 'txn_grant_e2', 100n, 1_000));
  await issueGrant(store, grantOf('usr_g', 'txn_grant_e3', 100n, 1_000));

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 2,
  });
  assert.equal(summary.reversed.length, 2);

  const next = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 2,
  });
  assert.equal(next.reversed.length, 1);
  await store.close();
}

async function skipsGrantsThatHaveNotYetExpired(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_h', 'txn_grant_h', 500n, 2_000));

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(summary.reversed, []);

  const promoBal = await store.ledger.balance(promo('usr_h'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 500n));
  await store.close();
}

// --- failure isolation: a thrown grant leaves it claimable ------------------------

async function recordsAFailedGrantWithoutMarkingItReversed(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_i', 'txn_grant_i', 500n, 1_000));

  // Reverse and mark-reversed share one transaction, so the throw leaves the grant unmarked
  // and still claimable.
  const failing: Store = {
    ...store,
    transaction: async () => {
      throw fault('STORE.FAILURE', 'tx down', { retryable: true });
    },
  };

  const summary = await sweepExpiredPromos(failing, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.failed, [
    { id: 'txn_grant_i', code: 'STORE.FAILURE' },
  ]);
  // A burn that cannot open its transaction is recorded against the holder, not the grant, so a
  // reader never has to guess whether an id in `failed` names a grant or a user.
  assert.deepEqual(summary.surplus.failed, [
    { userId: 'usr_i', code: 'STORE.FAILURE' },
  ]);

  const stillDue = await store.promos.claimDue(1_000, 10);
  assert.equal(stillDue.length, 1);
  assert.equal(stillDue[0]!.id, 'txn_grant_i');
  await store.close();
}

// --- an unverifiable row is refused, not reversed ---------------------------------

async function refusesAGrantWhoseRowDoesNotMatchItsPosting(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrantWithEditedRow(
    store,
    grantOf('usr_p', 'txn_grant_p', 500n, 1_000),
    900n,
  );

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.failed, [
    { id: 'txn_grant_p', code: 'CHAIN.BROKEN' },
  ]);
  // The burn re-proves the same row on the same terms, so it refuses rather than treating an
  // unverifiable face as claiming nothing and taking the pool.
  assert.deepEqual(summary.surplus.failed, [
    { userId: 'usr_p', code: 'CHAIN.BROKEN' },
  ]);
  assert.deepEqual(summary.surplus.burned, []);
  const promoBal = await store.ledger.balance(promo('usr_p'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 500n));

  // The refusal rolled the transaction back, so the grant is not marked and stays claimable.
  const stillDue = await store.promos.claimDue(1_000, 10);
  assert.equal(stillDue.length, 1);
  await store.close();
}

// A later grant's face sets the cut line for this one, so an edited sibling row moves this
// grant's clawback. It is re-proved on the same terms and refused on the same terms.
async function refusesWhenALaterGrantsRowDoesNotMatchItsPosting(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_q', 'txn_grant_q1', 500n, 1_000));
  await issueGrantWithEditedRow(
    store,
    grantOf('usr_q', 'txn_grant_q2', 600n, 4_000),
    900n,
  );

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.failed, [
    { id: 'txn_grant_q1', code: 'CHAIN.BROKEN' },
  ]);
  const promoBal = await store.ledger.balance(promo('usr_q'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 1_100n));
  await store.close();
}

// --- the sweep tallies what it did ------------------------------------------------

async function countsReversedAndFailedOnTheMeter(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_j', 'txn_grant_j', 500n, 1_000));
  // A second holder whose grant already closed, then took a refund back into the pool.
  await issueGrant(store, grantOf('usr_j2', 'txn_grant_j2', 500n, 500));
  await store.transaction((unit) => spendPromo(unit, 'usr_j2', 500n));
  await sweepExpiredPromos(store, makeWorkerCtx(), { now: 500, limit: 10 });
  await store.transaction((unit) => restorePromo(unit, 'usr_j2', 500n));
  const { meter, counts } = capturingMeter();

  await sweepExpiredPromos(
    store,
    makeWorkerCtx({ meter, ids: sequentialIds(500) }),
    {
      now: 1_000,
      limit: 10,
    },
  );

  const of = (name: string, outcome: string): number | undefined =>
    counts.find((c) => c.name === name && c.outcome === outcome)?.n;
  assert.equal(of('worker.promos.expired', 'reversed'), 1);
  assert.equal(of('worker.promos.expired', 'failed'), 0);
  assert.equal(of('worker.promos.surplus', 'scanned'), 2);
  assert.equal(of('worker.promos.surplus', 'burned'), 1);
  assert.equal(of('worker.promos.surplus', 'failed'), 0);
  await store.close();
}

async function leavesSpendableBalancesUntouched(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: 'txn_topup',
      legs: [
        credit(spendable('usr_k'), toAmount('CREDIT', 700n)),
        debit(SYSTEM.STORED_VALUE, toAmount('CREDIT', 700n)),
      ],
      meta: { kind: 'test.fund' },
    }),
  );
  await issueGrant(store, grantOf('usr_k', 'txn_grant_k', 500n, 1_000));

  await sweepExpiredPromos(store, makeWorkerCtx(), { now: 1_000, limit: 10 });

  const spend = await store.ledger.balance(spendable('usr_k'));
  assert.deepEqual(spend, toAmount('CREDIT', 700n));
  await store.close();
}

// --- surplus no live grant claims -------------------------------------------------

// The reachable path, driven through the real grant, spend and refund handlers: the grant that
// funded the sale expires and closes while the sale stands, and the later refund raises the
// pooled promo balance uncapped. No live grant claims what came back, and `claimDue` never
// visits this user again, so the per-grant clamp structurally cannot reach it.
async function burnsPromoCreditRestoredAfterEveryGrantClosed(): Promise<void> {
  const { economy, store } = economyWithStore();
  const buyer = 'usr_refunder';
  const granted = await economy.submit(
    grantPromoOp({
      userId: buyer,
      amount: creditOf('5.00'),
      expiresAt: 1_000,
    }),
  );
  assert.equal(granted.status, 'committed');
  const sale = await economy.submit(
    spendOp({
      buyerId: buyer,
      sku: 'wrld_pass',
      price: creditOf('5.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
      orderId: 'ord_surplus',
    }),
  );
  assert.equal(sale.status, 'committed');
  assert.deepEqual(await store.ledger.balance(promo(buyer)), creditOf('0.00'));

  const workerCtx = makeWorkerCtx({ ids: sequentialIds(9_000) });
  const expiry = await sweepExpiredPromos(store, workerCtx, {
    now: 1_000,
    limit: 10,
  });
  assert.equal(expiry.reversed.length, 1);
  assert.deepEqual(expiry.reversed[0]!.amount, creditOf('0.00'));
  assert.deepEqual(await store.promos.liveFor(buyer), []);

  const refunded = await economy.submit(refundOp({ orderId: 'ord_surplus' }));
  assert.equal(refunded.status, 'committed');
  // The refund raises every folded negative delta uncapped, so the pooled promo balance is back
  // above the total face of the buyer's live grants — which is zero.
  assert.deepEqual(await store.ledger.balance(promo(buyer)), creditOf('5.00'));

  const floatBefore = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  const after = await sweepExpiredPromos(store, workerCtx, {
    now: 2_000,
    limit: 10,
  });

  assert.deepEqual(after.reversed, []);
  assert.deepEqual(after.surplus.burned, [
    { userId: buyer, amount: creditOf('5.00') },
  ]);
  assert.deepEqual(after.surplus.failed, []);
  assert.deepEqual(await store.ledger.balance(promo(buyer)), creditOf('0.00'));
  assert.deepEqual(
    await store.ledger.balance(SYSTEM.PROMO_FLOAT),
    toAmount('CREDIT', floatBefore.minor - creditOf('5.00').minor),
  );
  await store.close();
}

// A live grant's face is untouchable however the credit got into the pool, so only what sits
// above the total live face burns.
async function burnsOnlyWhatNoLiveGrantClaims(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_s', 'txn_grant_s', 500n, 9_000));
  await store.transaction((unit) => restorePromo(unit, 'usr_s', 300n));

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.surplus.burned, [
    { userId: 'usr_s', amount: toAmount('CREDIT', 300n) },
  ]);
  assert.deepEqual(
    await store.ledger.balance(promo('usr_s')),
    toAmount('CREDIT', 500n),
  );

  // Nothing is left over, so a second run burns nothing and the live grant still stands.
  const again = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(again.surplus.burned, []);
  assert.equal(again.surplus.scanned, 1);
  await store.close();
}

// A pool exactly covered by live faces is examined and left alone. `scanned` is what proves the
// pass looked, since an empty `burned` reads the same whether it walked every holder or none.
async function scansEveryHolderAndBurnsNothingWhenEveryPoolIsClaimed(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_t1', 'txn_grant_t1', 500n, 9_000));
  await issueGrant(store, grantOf('usr_t2', 'txn_grant_t2', 400n, 9_000));
  await store.transaction((unit) => spendPromo(unit, 'usr_t2', 100n));

  const summary = await sweepExpiredPromos(store, makeWorkerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.equal(summary.surplus.scanned, 2);
  assert.deepEqual(summary.surplus.burned, []);
  assert.deepEqual(summary.surplus.failed, []);
  assert.deepEqual(
    await store.ledger.balance(promo('usr_t1')),
    toAmount('CREDIT', 500n),
  );
  assert.deepEqual(
    await store.ledger.balance(promo('usr_t2')),
    toAmount('CREDIT', 300n),
  );
  await store.close();
}

// Grant reversal and surplus burn move money the same way, so only the metadata kind tells them
// apart in history. A burn answers to no grant id, which is why it cannot borrow `promos.expiry`.
async function postsTheBurnUnderItsOwnKind(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_u1', 'txn_grant_u1', 500n, 1_000));
  await issueGrant(store, grantOf('usr_u2', 'txn_grant_u2', 500n, 1_000));
  await store.transaction((unit) => spendPromo(unit, 'usr_u2', 500n));

  // u1's unspent grant reverses; u2's is fully spent, so it closes having posted nothing.
  await sweepExpiredPromos(store, makeWorkerCtx(), { now: 1_000, limit: 10 });
  await store.transaction((unit) => restorePromo(unit, 'usr_u2', 500n));

  const summary = await sweepExpiredPromos(
    store,
    makeWorkerCtx({ ids: sequentialIds(500) }),
    { now: 1_000, limit: 10 },
  );

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.surplus.burned, [
    { userId: 'usr_u2', amount: toAmount('CREDIT', 500n) },
  ]);

  const expiry = await postingsOfKind(store, 'promos.expiry');
  const surplus = await postingsOfKind(store, 'promos.surplus');
  assert.equal(expiry.length, 1);
  assert.equal(expiry[0]!.meta.grantId, 'txn_grant_u1');
  assert.equal(surplus.length, 1);
  assert.equal(surplus[0]!.meta.userId, 'usr_u2');
  assert.equal(surplus[0]!.meta.grantId, undefined);
  await store.close();
}

// The limit caps burns, not holders walked. A burned pool no longer exceeds its live faces, so
// the next run's walk reaches the holders this one stopped short of.
async function burnsAtMostTheLimitPerRunAndDrainsTheRest(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  const users = ['usr_v1', 'usr_v2', 'usr_v3'];
  for (const userId of users) {
    await issueGrant(
      store,
      grantOf(userId, `txn_grant_${userId}`, 100n, 1_000),
    );
    await store.transaction((unit) => spendPromo(unit, userId, 100n));
  }
  await sweepExpiredPromos(store, makeWorkerCtx(), { now: 1_000, limit: 10 });
  for (const userId of users) {
    await store.transaction((unit) => restorePromo(unit, userId, 100n));
  }

  const first = await sweepExpiredPromos(
    store,
    makeWorkerCtx({ ids: sequentialIds(500) }),
    { now: 1_000, limit: 2 },
  );
  assert.equal(first.surplus.burned.length, 2);

  const second = await sweepExpiredPromos(
    store,
    makeWorkerCtx({ ids: sequentialIds(600) }),
    { now: 1_000, limit: 2 },
  );
  assert.equal(second.surplus.burned.length, 1);
  assert.equal(second.surplus.scanned, 3);

  for (const userId of users) {
    assert.deepEqual(
      await store.ledger.balance(promo(userId)),
      toAmount('CREDIT', 0n),
    );
  }
  await store.close();
}

describe('Promo-Expiry Sweep', () => {
  test('burns promo credit a refund restored after every grant closed', () =>
    burnsPromoCreditRestoredAfterEveryGrantClosed());
  test('burns only what no live grant claims', () =>
    burnsOnlyWhatNoLiveGrantClaims());
  test('scans every holder and burns nothing when every pool is claimed', () =>
    scansEveryHolderAndBurnsNothingWhenEveryPoolIsClaimed());
  test('posts the burn under its own kind', () =>
    postsTheBurnUnderItsOwnKind());
  test('burns at most the limit per run and drains the rest', () =>
    burnsAtMostTheLimitPerRunAndDrainsTheRest());

  test('reverses an unspent expired grant to PROMO_FLOAT', () =>
    reversesAnUnspentExpiredGrantToPromoFloat());
  test('reverses only the part the user did not spend', () =>
    reversesOnlyThePartTheUserDidNotSpend());
  test('reverses nothing when the grant is fully spent', () =>
    reversesNothingWhenTheGrantIsFullySpent());
  test('never over-reverses when one user has two grants', () =>
    neverOverReversesWhenOneUserHasTwoGrants());
  test("reverses only the expiring grant's share of the pool", () =>
    reversesOnlyTheExpiringGrantsShareOfThePool());
  test('splits the pool deterministically when two grants expire together', () =>
    splitsThePoolDeterministicallyWhenTwoGrantsExpireTogether());

  test('refuses a grant whose row does not match its posting', () =>
    refusesAGrantWhoseRowDoesNotMatchItsPosting());
  test("refuses when a later grant's row does not match its posting", () =>
    refusesWhenALaterGrantsRowDoesNotMatchItsPosting());

  test('honors the claim limit', () => honorsTheClaimLimit());
  test('skips grants that have not yet expired', () =>
    skipsGrantsThatHaveNotYetExpired());

  test('records a failed grant without marking it reversed', () =>
    recordsAFailedGrantWithoutMarkingItReversed());
  test('counts reversed and failed on the meter', () =>
    countsReversedAndFailedOnTheMeter());
  test('leaves spendable balances untouched', () =>
    leavesSpendableBalancesUntouched());
});
