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

// The velocity check — a rolling-window fraud throttle — runs inside `economy.submit`, so tests
// drive that entry point. Pins that requestPayout counts toward the shared rule in trust.ts. The
// clock is frozen at 0, so every attempt lands in the same window.

// The store and the economy share one seeded digest and fixed clock so their hashes agree.
function sharedStore(): Store {
  return memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
}

// Seeds earned against REVENUE; platform accounts may run negative, so the overdraft guard does
// not trip.
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

function detailOf(outcome: Outcome): unknown {
  return outcome.status === 'rejected' ? outcome.detail : undefined;
}

describe('Rolling Spend-Limit Throttling Through economy.submit', () => {
  test('requestPayout counts toward the rolling spend limit and is denied once it is exceeded', async () => {
    const store = sharedStore();
    // Fund only the first payout: the risk check stops the second before the handler's funds
    // check runs.
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
    assert.deepEqual(detailOf(second), {
      reason: 'RISK_DENIED',
      window: 'outflow',
      limitMinor: 1_000n,
    });
  });

  test('a single requestPayout at exactly the limit is allowed', async () => {
    const store = sharedStore();
    await seedEarned(store, 'usr_seller', credit('10.00'));
    const economy = makeEconomy(1, store, { velocityLimitMinor: 1_000n });

    // 0 + 1000 lands exactly on the ceiling; the check denies only on strictly greater.
    const outcome = await economy.submit(
      buildRequestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
    );
    assert.equal(outcome.status, 'committed');
  });
});
