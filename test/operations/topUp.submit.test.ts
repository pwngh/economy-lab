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

// These tests drive the full public `economy.submit` path, where the permission check
// (`authorize`) lives; the sibling topUp.test.ts calls the handler directly and so never reaches
// it. topUp is now privileged (it mints spendable credits against real cash held in trust), so a
// `kind:'user'` actor must be turned away before any money moves, while a trusted system actor —
// the real buy-credits service — must still go through.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// A store wired with the same seeded digest + fixed clock the economy uses, returned alongside an
// economy built over it so a test can both submit operations and read balances.
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

    // Stopped before it ran: no credits were issued.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.00'),
    );
  });

  test('still commits a topUp run by a trusted system actor', async () => {
    const { economy, store } = economyWithStore();

    // The topUp builder defaults to a system actor; the legitimate buy-credits path must still go
    // through and both move credits to the buyer and bring the matching cash into trust.
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
      // par rate is $0.005/credit, so 10.00 credits back to $0.05 of real cash held in trust
      // (the rest of the buyer's $0.10 gross is the platform's purchase-fee revenue).
      usd('0.05'),
    );
  });
});
