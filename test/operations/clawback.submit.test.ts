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
  clawback as buildClawback,
  topUp as buildTopUp,
  principal,
  credit,
} from '#test/support/builders.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { spendable } from '#src/accounts.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// These tests drive the full public `economy.submit` path, where the permission check (`authorize`)
// runs. The sibling clawback.test.ts calls the handler directly and never reaches that check.
//
// They lock a fix for an authorization bypass of the same shape as the revokeEntitlement one.
// Clawback is a bank chargeback or fraud recovery. It was missing from the privileged-only list. The
// ownership rule only blocks debiting an account you own, and a clawback's target does not count as
// the actor's own account, so the rule let the operation through. A `kind:'user'` actor could
// therefore reclaim credits from any user's spendable balance. It could also poison a later refund of
// an order it does not own, because a clawback claims the shared `reversed:${orderId}` key. Clawback
// is now system/operator-only, which these tests pin. Each test holds the store it builds the economy
// over, so it can confirm the victim's balance is untouched after a rejected attempt.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// Builds a store and an economy over it, both wired with the same seeded digest and fixed clock.
// Returns the store alongside the economy so a test can submit operations and read balances.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

// Gives usr_victim a spendable balance through a trusted system actor, the way a real top-up runs.
// This gives an attacker something to try to claw back.
async function fundVictim(economy: Economy): Promise<void> {
  const outcome = await economy.submit(
    buildTopUp({ userId: 'usr_victim', amount: credit('20.00') }),
  );
  assert.equal(outcome.status, 'committed');
}

describe('Clawback authorization through economy.submit', () => {
  test("rejects a user clawing back another user's credits with AUTH.UNAUTHORIZED", async () => {
    const { economy, store } = economyWithStore();
    await fundVictim(economy);

    await assert.rejects(
      economy.submit(
        buildClawback({
          userId: 'usr_victim',
          amount: credit('5.00'),
          actor: principal('usr_attacker'),
        }),
      ),
      isUnauthorized,
    );

    // The clawback was stopped before it ran, so the victim's balance is untouched.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_victim')),
      credit('20.00'),
    );
  });

  test('rejects a user clawing back even their own account (clawback is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await fundVictim(economy);

    // Clawback is system/operator-only regardless of whose account it names, so a user acting on
    // their own balance is still unauthorized.
    await assert.rejects(
      economy.submit(
        buildClawback({
          userId: 'usr_victim',
          amount: credit('5.00'),
          actor: principal('usr_victim'),
        }),
      ),
      isUnauthorized,
    );
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_victim')),
      credit('20.00'),
    );
  });

  test('still allows a privileged operator actor to claw back (the fix does not over-restrict)', async () => {
    const { economy, store } = economyWithStore();
    await fundVictim(economy);

    // The builder defaults to an operator actor. The legitimate fraud-recovery path must still go
    // through.
    const outcome = await economy.submit(
      buildClawback({ userId: 'usr_victim', amount: credit('5.00') }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_victim')),
      credit('15.00'),
    );
  });
});
