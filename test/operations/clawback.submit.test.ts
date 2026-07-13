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

// These tests drive the full `economy.submit` path, where the permission check (`authorize`) runs;
// the sibling clawback.test.ts calls the handler directly and never reaches it. They pin clawback
// as system/operator-only — the ownership rule alone would let a user claw back any balance.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// The economy and the store share one seeded digest and fixed clock so their hashes agree.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

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

    assert.deepEqual(
      await store.ledger.balance(spendable('usr_victim')),
      credit('20.00'),
    );
  });

  test('rejects a user clawing back even their own account (clawback is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await fundVictim(economy);

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

    // The builder defaults to an operator actor.
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
