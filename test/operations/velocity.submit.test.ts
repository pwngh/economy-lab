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

import { makeEconomy } from '#test/support/economy.ts';
import {
  requestPayout as buildRequestPayout,
  credit,
} from '#test/support/builders.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit as debitLeg } from '#src/ledger.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Store } from '#src/ports.ts';
import type { Outcome } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';

// What these tests guard: the "velocity" check, a fraud throttle that denies an operation once
// a user's recent money movement in a rolling time window goes over a ceiling. The check runs
// inside the public `economy.submit` entry point, so these tests call that entry point directly.
//
// Why they exist: requestPayout used to slip past the throttle. An earlier copy of the velocity
// rule lived inside economy.ts and only recognized spend/topUp/grantPromo, so a payout was
// neither counted toward the ceiling nor stopped by it. economy.ts now calls the single shared
// rule in trust.ts, which covers payout too; these are the regression tests that pin that down
// end to end.
//
// How the setup forces the throttle to fire: the time window is one hour and the clock is frozen
// at 0, so every attempt in a test lands in the same window and the per-user total only adds up.
// The ceiling is overridden to a tiny value via config — 1_000 minor units, i.e. 10.00 CREDIT,
// since CREDIT (like dollars) has 100 minor units to the whole — so two 6.00 attempts bracket it:
// 6.00 alone fits under 10.00, but 6.00 + 6.00 = 12.00 would cross it, so the second is denied.

// Build a storage backend wired with the same fake hashing (a fixed-seed digest) and the same
// frozen clock the economy will use. Using one identical store lets us write starting balances
// into it by hand below, then pass that very store to `makeEconomy` so both halves of a test
// agree on hashes and time.
function sharedStore(): Store {
  return memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
}

// Give a seller money to pay out from. Each user has an "earned" account holding revenue the
// platform owes them; here we raise that account and offset it by taking the same amount out of
// the platform's REVENUE account, which is allowed to run negative. (A double-entry ledger only
// accepts a write whose two sides cancel out, so we always move money from somewhere to somewhere
// — this mimics what a real sale would post.) Funding one payout lets the first attempt commit so
// the second is the one the ceiling stops.
function seedEarned(
  store: Store,
  userId: string,
  amount: Amount,
): Promise<unknown> {
  return store.transaction((unit) =>
    unit.ledger.append({
      txnId: `txn_seed_${userId}`,
      legs: [
        debitLeg(SYSTEM.REVENUE, amount),
        creditLeg(earned(userId), amount),
      ],
      meta: { kind: 'seed' },
    }),
  );
}

function reasonOf(outcome: Outcome): string | undefined {
  return outcome.status === 'rejected' ? outcome.reason : undefined;
}

describe('Rolling Spend-Limit Throttling Through economy.submit', () => {
  test('requestPayout counts toward the rolling spend limit and is denied once it is exceeded', async () => {
    const store = sharedStore();
    // Only the first payout needs to commit, so fund earned for one 6.00 payout. The second is
    // stopped by the risk check before the handler's own funds check runs.
    await seedEarned(store, 'usr_seller', credit('6.00'));
    const economy = makeEconomy(1, store, { velocityLimitMinor: 1_000n });

    const first = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('6.00') }),
    );
    assert.equal(first.status, 'committed');

    // In minor units (100 per credit): 600 already counted + 600 this attempt = 1200, which is
    // over the 1000 ceiling, so the throttle denies it.
    const second = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('6.00') }),
    );
    assert.equal(second.status, 'rejected');
    assert.equal(reasonOf(second), 'RISK_DENIED');
  });

  test('a single requestPayout at exactly the limit is allowed', async () => {
    const store = sharedStore();
    await seedEarned(store, 'usr_seller', credit('10.00'));
    const economy = makeEconomy(1, store, { velocityLimitMinor: 1_000n });

    // In minor units: 0 + 1000 = 1000, which is not over the 1000 limit, because the check denies
    // only when the total is strictly greater than the limit. So a single payout that lands the
    // running total exactly on the ceiling still goes through.
    const outcome = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});
