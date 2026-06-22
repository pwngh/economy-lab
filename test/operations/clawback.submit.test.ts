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
// lives; the sibling clawback.test.ts calls the handler directly and so never reaches it.
//
// Regression tests for an authorization bypass of the same shape as the revokeEntitlement one:
// clawback — a bank chargeback / fraud recovery — was missing from the privileged-only list, and
// because the ownership rule only blocks DEBITING an account you own (and clawback's target isn't
// counted there), a `kind:'user'` actor could reclaim credits from ANY user's spendable balance and
// poison a later refund of an order they don't own (clawback claims the shared `reversed:${orderId}`
// key). It is now system/operator-only, which is what these tests pin. Each test builds the economy
// over a store it also holds, so it can confirm the victim's balance is untouched after a rejected
// attempt — proof the request was stopped before it could move any money.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// A store wired with the same seeded digest + fixed clock the economy uses, returned alongside an
// economy built over it so a test can both submit operations and read balances.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

// Give usr_victim a real spendable balance (as a trusted system actor, the way a real top-up runs)
// so there is something for an attacker to try to claw back.
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

    // Stopped before it ran: the victim's balance is untouched.
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_victim')),
      credit('20.00'),
    );
  });

  test('rejects a user clawing back even their own account (clawback is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await fundVictim(economy);

    // Clawback is system/operator-only regardless of whose account it names, so a user acting on
    // their own balance is still unauthorized — the same rule that protects a foreign account.
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

    // The clawback builder defaults to an operator actor; the legitimate fraud-recovery path must
    // still go through.
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
