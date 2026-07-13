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
import { promo, spendable, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fakeProcessor,
  fixedRates,
  testLogger,
  noopMeter,
  testConfig,
} from '#test/support/capabilities.ts';

import type { Meter } from '#src/ports.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { PromoGrant, Store, Unit } from '#src/ports.ts';

function workerCtx(overrides?: { meter?: Meter }): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: overrides?.meter ?? noopMeter(),
    config: testConfig(),
  };
}

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

  const summary = await sweepExpiredPromos(store, workerCtx(), {
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

  const again = await sweepExpiredPromos(store, workerCtx(), {
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

  const summary = await sweepExpiredPromos(store, workerCtx(), {
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

  const summary = await sweepExpiredPromos(store, workerCtx(), {
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

  const again = await sweepExpiredPromos(store, workerCtx(), {
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
  await issueGrant(store, grantOf('usr_d', 'txn_grant_d2', 500n, 1_000));
  await store.transaction((unit) => spendPromo(unit, 'usr_d', 800n));

  const summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Grants are handled one at a time, re-reading the live balance each time, so the pair
  // reverses 200 in total, never the 1000 granted.
  const total = summary.reversed.reduce((sum, r) => sum + r.amount.minor, 0n);
  assert.equal(total, 200n);
  assert.equal(summary.reversed.length, 2);

  const promoBal = await store.ledger.balance(promo('usr_d'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));
  await store.close();
}

// --- claim cap and ordering -------------------------------------------------------

async function honorsTheClaimLimit(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_e', 'txn_grant_e1', 100n, 1_000));
  await issueGrant(store, grantOf('usr_f', 'txn_grant_e2', 100n, 1_000));
  await issueGrant(store, grantOf('usr_g', 'txn_grant_e3', 100n, 1_000));

  const summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 2,
  });
  assert.equal(summary.reversed.length, 2);

  const next = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 2,
  });
  assert.equal(next.reversed.length, 1);
  await store.close();
}

async function skipsGrantsThatHaveNotYetExpired(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_h', 'txn_grant_h', 500n, 2_000));

  const summary = await sweepExpiredPromos(store, workerCtx(), {
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

  const summary = await sweepExpiredPromos(failing, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.failed, [
    { id: 'txn_grant_i', code: 'STORE.FAILURE' },
  ]);

  const stillDue = await store.promos.claimDue(1_000, 10);
  assert.equal(stillDue.length, 1);
  assert.equal(stillDue[0]!.id, 'txn_grant_i');
  await store.close();
}

// --- the sweep tallies what it did ------------------------------------------------

async function countsReversedAndFailedOnTheMeter(): Promise<void> {
  const store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_j', 'txn_grant_j', 500n, 1_000));
  const { meter, counts } = capturingMeter();

  await sweepExpiredPromos(store, workerCtx({ meter }), {
    now: 1_000,
    limit: 10,
  });

  const reversed = counts.find((c) => c.outcome === 'reversed');
  const failed = counts.find((c) => c.outcome === 'failed');
  assert.equal(reversed?.name, 'worker.promos.expired');
  assert.equal(reversed?.n, 1);
  assert.equal(failed?.n, 0);
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

  await sweepExpiredPromos(store, workerCtx(), { now: 1_000, limit: 10 });

  const spend = await store.ledger.balance(spendable('usr_k'));
  assert.deepEqual(spend, toAmount('CREDIT', 700n));
  await store.close();
}

describe('Promo-Expiry Sweep', () => {
  test('reverses an unspent expired grant to PROMO_FLOAT', () =>
    reversesAnUnspentExpiredGrantToPromoFloat());
  test('reverses only the part the user did not spend', () =>
    reversesOnlyThePartTheUserDidNotSpend());
  test('reverses nothing when the grant is fully spent', () =>
    reversesNothingWhenTheGrantIsFullySpent());
  test('never over-reverses when one user has two grants', () =>
    neverOverReversesWhenOneUserHasTwoGrants());

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
