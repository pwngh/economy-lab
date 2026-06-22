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

// Guards the velocity check: a fraud throttle that denies an operation once a user's recent money
// movement in a rolling window exceeds a ceiling. The check runs inside economy.submit, so tests
// call that entry point directly.
//
// Regression: requestPayout used to slip past the throttle. The old velocity rule in economy.ts
// only recognized spend/topUp/grantPromo, so a payout was neither counted nor stopped. economy.ts
// now calls the shared rule in trust.ts, which covers payout too.
//
// Setup: window is one hour, clock frozen at 0, so every attempt lands in the same window and the
// per-user total accumulates. Ceiling overridden via config to 1_000 minor units (10.00 CREDIT;
// CREDIT has 100 minor units to the whole). Two 6.00 attempts bracket it: 6.00 fits under 10.00,
// 6.00 + 6.00 = 12.00 crosses it, so the second is denied.

// Store wired with the same fixed-seed digest and frozen clock the economy uses. Sharing one store
// lets us seed balances by hand, then pass it to makeEconomy so both sides agree on hashes and time.
function sharedStore(): Store {
  return memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
}

// Give a seller money to pay out from. Each user's "earned" account holds revenue the platform owes
// them; raise it and offset by debiting the platform's REVENUE account (allowed to run negative).
// Double-entry only accepts writes whose two sides cancel, so we move money from somewhere to
// somewhere, mimicking a real sale. Funding one payout lets the first attempt commit, leaving the
// ceiling to stop the second.
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

    // In minor units: 0 + 1000 = 1000, not over the 1000 limit. The check denies only on strictly
    // greater, so a total landing exactly on the ceiling still goes through.
    const outcome = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});
