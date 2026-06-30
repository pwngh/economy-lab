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
  topUp as buildTopUp,
  principal,
  credit,
  usd,
} from '#test/support/builders.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// Drives the full `economy.submit` path, where the `authorize` check lives. The sibling
// topUp.test.ts calls the handler directly and never reaches that check. topUp is privileged because
// it mints spendable credits against real cash held in trust. A `kind:'user'` actor must be rejected
// before any money moves, while a trusted system actor (the buy-credits service) must still go
// through.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// Builds a store and an economy over it that share the same seeded digest and fixed clock. Returns
// both so a test can submit operations through the economy and read balances back from the store.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

describe('topUp authorization through economy.submit', () => {
  test('rejects a topUp by a kind:user actor with AUTH.UNAUTHORIZED', async () => {
    const { economy, store } = economyWithStore();

    await assert.rejects(
      economy.submit(
        buildTopUp({
          userId: 'usr_buyer',
          amount: credit('10.00'),
          actor: principal('usr_buyer'),
        }),
      ),
      isUnauthorized,
    );

    // The reject stopped the operation before it ran, so no credits were issued.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.00'),
    );
  });

  test('still commits a topUp run by a trusted system actor', async () => {
    const { economy, store } = economyWithStore();

    // The topUp builder defaults to a system actor, so the buy-credits path must go through. It moves
    // credits to the buyer and brings the matching cash into trust.
    const outcome = await economy.submit(
      buildTopUp({ userId: 'usr_buyer', amount: credit('10.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      // The par rate is $0.005 per credit, so 10.00 credits are backed by $0.05 of real cash held in
      // trust. The rest of the buyer's $0.10 gross is the platform's purchase-fee revenue.
      usd('0.05'),
    );
  });
});
