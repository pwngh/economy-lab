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

// Injected deps for the sweep, all deterministic fakes. The sweep only uses `ids` (txn id for the
// reversal it posts), `logger`, and `meter`; pass a custom `meter` to observe what it counts.
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

// Meter that records every `count` call instead of emitting, so a test can read back how many
// grants the sweep reported as reversed versus failed.
function capturingMeter(): {
  meter: Meter;
  counts: Array<{ name: string; n: number; outcome: string | undefined }>;
} {
  let counts: Array<{ name: string; n: number; outcome: string | undefined }> =
    [];
  return {
    meter: {
      count: (name, n, tags) =>
        counts.push({ name, n, outcome: tags?.outcome }),
      observe: () => {},
    },
    counts,
  };
}

// Issue a promo credit the way operations/promo.ts does. Promos live in the user's "promo"
// account and expire. Records a balanced pair in one transaction: credit `amount` to the user's
// promo account, debit the same from PROMO_FLOAT (the house pool funding promos), plus a grant
// row. After this the user has `amount` of promo balance and the sweep has a claimable grant.
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

// Spend `minor` units of promo balance, as a purchase spends promo credit before real money.
// Balanced pair: debit `minor` from the user's promo account, credit it to REVENUE (arbitrary
// balanced destination). Drops the live balance below the original grant, so on expiry the sweep
// reverses only the leftover.
async function spendPromo(
  unit: Unit,
  userId: string,
  minor: bigint,
): Promise<void> {
  let amount = toAmount('CREDIT', minor);
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
  let store = memoryStore({ digest: seededDigest(1) });
  // PROMO_FLOAT balance before any grant (starts at zero); a later assert confirms the reversal
  // returns it here.
  let floatBeforeGrant = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  let grant = grantOf('usr_a', 'txn_grant_a', 500n, 1_000);
  await issueGrant(store, grant);

  let summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // The full, unspent grant was reversed.
  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_a', amount: toAmount('CREDIT', 500n) },
  ]);
  assert.deepEqual(summary.failed, []);

  // The user's promo balance dropped back to zero.
  let promoBal = await store.ledger.balance(promo('usr_a'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));

  // PROMO_FLOAT is back to its pre-grant balance: the grant moved 500 out, the reversal moves 500
  // back, netting to zero change.
  let floatAfter = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  assert.deepEqual(floatAfter, floatBeforeGrant);

  // The grant is marked reversed, so a second sweep finds nothing.
  let again = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(again.reversed, []);
  await store.close();
}

async function reversesOnlyThePartTheUserDidNotSpend(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  let grant = grantOf('usr_b', 'txn_grant_b', 500n, 1_000);
  await issueGrant(store, grant);
  // Spend 300 of the 500; 200 remains unspent.
  await store.transaction((unit) => spendPromo(unit, 'usr_b', 300n));

  let summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Only the 200 remainder is reversed, not the full grant.
  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_b', amount: toAmount('CREDIT', 200n) },
  ]);
  // The promo balance is fully drained (300 spent + 200 reversed).
  let promoBal = await store.ledger.balance(promo('usr_b'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));
  await store.close();
}

// --- a fully-spent grant reverses nothing -----------------------------------------

async function reversesNothingWhenTheGrantIsFullySpent(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  let grant = grantOf('usr_c', 'txn_grant_c', 500n, 1_000);
  await issueGrant(store, grant);
  // Spend the whole grant: the live promo balance is now zero.
  await store.transaction((unit) => spendPromo(unit, 'usr_c', 500n));

  let floatBefore = await store.ledger.balance(SYSTEM.PROMO_FLOAT);

  let summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // The grant still appears in the result (claimed and processed), but reversed amount is 0 since
  // the user had spent all of it.
  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_c', amount: toAmount('CREDIT', 0n) },
  ]);
  assert.deepEqual(summary.failed, []);

  // Nothing was written to the ledger, so the PROMO_FLOAT pool's balance is unchanged.
  let floatAfter = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  assert.deepEqual(floatAfter, floatBefore);

  // No money moved, but the grant is still marked reversed; a second sweep finds nothing.
  let again = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(again.reversed, []);
  await store.close();
}

// --- two grants for one user never over-reverse -----------------------------------

async function neverOverReversesWhenOneUserHasTwoGrants(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  // Two grants of 500 each: the user has 1000 promo in total.
  await issueGrant(store, grantOf('usr_d', 'txn_grant_d1', 500n, 1_000));
  await issueGrant(store, grantOf('usr_d', 'txn_grant_d2', 500n, 1_000));
  // Spend 800: only 200 remains across the two grants combined.
  await store.transaction((unit) => spendPromo(unit, 'usr_d', 800n));

  let summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  // Grants are handled one at a time, re-reading the live promo balance each time. First grant
  // reverses the leftover 200; second re-reads the now-zero balance and reverses nothing. Total
  // reversed is 200, not the full 1000 granted.
  let total = summary.reversed.reduce((sum, r) => sum + r.amount.minor, 0n);
  assert.equal(total, 200n);
  assert.equal(summary.reversed.length, 2);

  // The promo balance never goes negative; it lands at zero.
  let promoBal = await store.ledger.balance(promo('usr_d'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 0n));
  await store.close();
}

// --- claim cap and ordering -------------------------------------------------------

async function honorsTheClaimLimit(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_e', 'txn_grant_e1', 100n, 1_000));
  await issueGrant(store, grantOf('usr_f', 'txn_grant_e2', 100n, 1_000));
  await issueGrant(store, grantOf('usr_g', 'txn_grant_e3', 100n, 1_000));

  // limit 2: only two grants are claimed and reversed this pass.
  let summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 2,
  });
  assert.equal(summary.reversed.length, 2);

  // The third grant is left for the next pass.
  let next = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 2,
  });
  assert.equal(next.reversed.length, 1);
  await store.close();
}

async function skipsGrantsThatHaveNotYetExpired(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_h', 'txn_grant_h', 500n, 2_000));

  // Grant expires at 2000 but we sweep at 1000, before expiry, so nothing is due yet.
  let summary = await sweepExpiredPromos(store, workerCtx(), {
    now: 1_000,
    limit: 10,
  });
  assert.deepEqual(summary.reversed, []);

  // The promo balance is untouched.
  let promoBal = await store.ledger.balance(promo('usr_h'));
  assert.deepEqual(promoBal, toAmount('CREDIT', 500n));
  await store.close();
}

// --- failure isolation: a thrown grant leaves it claimable ------------------------

async function recordsAFailedGrantWithoutMarkingItReversed(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_i', 'txn_grant_i', 500n, 1_000));

  // Wrap the store so opening a transaction always throws. The sweep reverses each grant (and
  // marks it reversed) inside one transaction, so the rollback leaves the grant unmarked and
  // still claimable.
  let failing: Store = {
    ...store,
    transaction: async () => {
      throw fault('STORE.FAILURE', 'tx down', { retryable: true });
    },
  };

  let summary = await sweepExpiredPromos(failing, workerCtx(), {
    now: 1_000,
    limit: 10,
  });

  assert.deepEqual(summary.reversed, []);
  assert.deepEqual(summary.failed, [
    { id: 'txn_grant_i', code: 'STORE.FAILURE' },
  ]);

  // Never marked reversed, so the unwrapped store still reports it as due for a later retry.
  let stillDue = await store.promos.claimDue(1_000, 10);
  assert.equal(stillDue.length, 1);
  assert.equal(stillDue[0]!.id, 'txn_grant_i');
  await store.close();
}

// --- the sweep tallies what it did ------------------------------------------------

async function countsReversedAndFailedOnTheMeter(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
  await issueGrant(store, grantOf('usr_j', 'txn_grant_j', 500n, 1_000));
  let { meter, counts } = capturingMeter();

  await sweepExpiredPromos(store, workerCtx({ meter }), {
    now: 1_000,
    limit: 10,
  });

  let reversed = counts.find((c) => c.outcome === 'reversed');
  let failed = counts.find((c) => c.outcome === 'failed');
  assert.equal(reversed?.name, 'economy.worker.promo.expiry');
  assert.equal(reversed?.n, 1);
  assert.equal(failed?.n, 0);
  await store.close();
}

// The sweep touches only promo accounts, never a user's spendable balance (topped-up real money).
// Fund a spendable account, issue and expire a promo grant, then check spendable is unchanged.
async function leavesSpendableBalancesUntouched(): Promise<void> {
  let store = memoryStore({ digest: seededDigest(1) });
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

  // The promo grant was reversed but the spendable balance is exactly as funded.
  let spend = await store.ledger.balance(spendable('usr_k'));
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
