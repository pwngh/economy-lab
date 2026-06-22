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

// Build the bundle of injected dependencies (clock, id generator, logger, metrics meter, etc.)
// that the sweep runs against. Every piece is a fake test stand-in that behaves the same way on
// every run. The sweep only actually uses three of them: `ids` (to generate the transaction id
// for the reversal it posts), `logger`, and `meter`. A test can pass its own `meter` to observe
// what the sweep counts.
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

// A metrics meter that remembers every `count` call instead of sending it anywhere, so a test
// can read back how many grants the sweep reported as reversed versus failed.
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

// Give a user a promotional credit, exactly the way operations/promo.ts does. A promo is a
// marketing freebie the platform hands out; it lives in the user's "promo" account and expires.
// In double-entry bookkeeping every movement is recorded twice, once on each side, so this
// records the grant as a balanced pair: it adds `amount` to the user's promo account (a credit)
// and records the same `amount` leaving PROMO_FLOAT, the house pool the platform funds promos
// from (a debit). It also writes a grant row, all in one transaction. The result: the user has
// `amount` of promo balance, and the sweep has a grant it can later claim and reverse.
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

// Spend `minor` units of a user's promo balance, the way a real purchase spends promo credit
// before touching real money. This records the spend as a balanced pair: it removes `minor`
// from the user's promo account and adds the same `minor` to the platform's revenue account
// (the test just needs somewhere balanced for the money to land — revenue is an arbitrary
// choice here). After this the user's current promo balance is below the original grant, so
// when the grant expires the sweep should reverse only the leftover, not the full grant.
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
  // Record the PROMO_FLOAT pool's balance before any grant is issued (it starts at zero), so a
  // later assert can confirm the reversal returns it to exactly this starting point.
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

  // The PROMO_FLOAT pool is back to where it stood before the grant. Issuing the grant moved
  // 500 out of the pool; reversing it moves the same 500 back in, so the two cancel out and the
  // pool nets to zero change.
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

  // The grant still shows up in the result (the sweep claimed and processed it), but the amount
  // reversed is 0 because the user had already spent all of it.
  assert.deepEqual(summary.reversed, [
    { id: 'txn_grant_c', amount: toAmount('CREDIT', 0n) },
  ]);
  assert.deepEqual(summary.failed, []);

  // Nothing was written to the ledger, so the PROMO_FLOAT pool's balance is unchanged.
  let floatAfter = await store.ledger.balance(SYSTEM.PROMO_FLOAT);
  assert.deepEqual(floatAfter, floatBefore);

  // Even though no money moved, the grant is still marked reversed, so a later sweep won't pick
  // it up again. This second sweep confirms that: it finds nothing to do.
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

  // The sweep handles the two grants one at a time, re-reading the user's current promo balance
  // each time. The first grant sees the 200 that is left and reverses it; the second grant then
  // re-reads the now-zero balance and reverses nothing. So the total reversed is exactly the 200
  // that was left over, never the full 1000 that was granted.
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

  // The grant expires at 2000 but we sweep at time 1000, before its expiry, so nothing is due
  // to be reversed yet.
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

  // Wrap the store so that opening a database transaction always throws. The sweep reverses each
  // grant inside one transaction, so this makes reversing the grant fail. Marking the grant
  // reversed happens in that same transaction, so when it rolls back the grant is left unmarked
  // and still claimable.
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

  // Because the grant was never marked reversed, the real (unwrapped) store still reports it as
  // due, ready for a later sweep to retry.
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

// Confirm the sweep only ever touches promo accounts and leaves a user's spendable balance
// (real money they topped up) alone. The test first funds a spendable account, then issues and
// expires a promo grant, and checks the spendable balance is exactly as funded afterward.
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
