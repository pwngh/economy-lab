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
  grantEntitlement as buildGrantEntitlement,
  revokeEntitlement as buildRevokeEntitlement,
  principal,
} from '#test/support/builders.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { fixedClock, seededDigest } from '#test/support/capabilities.ts';

import type { Economy } from '#src/contract.ts';
import type { Store } from '#src/ports.ts';

// Drives the full public `economy.submit` path, where the permission check (`authorize`) lives. The
// sibling entitlements.test.ts calls handlers directly and never reaches that check, so this file
// covers it.
//
// These are regression tests for an authorization bypass. `authorize` has two parts. The first is a
// privileged-only list of operations that only system or operator callers may run. The second is an
// ownership rule for everyone else that blocks only taking money out of an account you don't own.
// revokeEntitlement was missing from the privileged list. Because it moves no money, there is no
// account being drained for the ownership rule to catch, so a `kind:'user'` actor could revoke any
// other user's entitlement. It is now system/operator-only. Each test builds the economy over a store
// it also holds a handle to, so it can confirm the victim's ownership is untouched after the rejected
// attempt.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// Builds a store wired with the same seeded digest and fixed clock as the economy. Returns the store
// alongside an economy built over it, so a test can both submit operations and read entitlement
// ownership.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

// Grants `usr_victim` a sku as a trusted system actor, so there is a real entitlement for an attacker
// to try to revoke.
async function grantToVictim(economy: Economy, sku: string): Promise<void> {
  const outcome = await economy.submit(
    buildGrantEntitlement({ userId: 'usr_victim', sku }),
  );
  assert.equal(outcome.status, 'committed');
}

describe('Entitlement Authorization Through economy.submit', () => {
  test("rejects a user revoking another user's entitlement with AUTH.UNAUTHORIZED", async () => {
    const { economy, store } = economyWithStore();
    await grantToVictim(economy, 'wrld_pass');

    await assert.rejects(
      economy.submit(
        buildRevokeEntitlement({
          userId: 'usr_victim',
          sku: 'wrld_pass',
          actor: principal('usr_attacker'),
        }),
      ),
      isUnauthorized,
    );

    // The revoke was rejected before it ran, so the victim still owns the sku.
    assert.equal(
      await store.entitlements.owns('usr_victim', 'wrld_pass'),
      true,
    );
  });

  test('rejects a user revoking even their OWN entitlement (revoke is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await grantToVictim(economy, 'wrld_pass');

    // Revoke is system/operator-only regardless of whose account it names. A user acting on their own
    // sku is still unauthorized, blocked by the same rule that protects a foreign account.
    await assert.rejects(
      economy.submit(
        buildRevokeEntitlement({
          userId: 'usr_victim',
          sku: 'wrld_pass',
          actor: principal('usr_victim'),
        }),
      ),
      isUnauthorized,
    );
    assert.equal(
      await store.entitlements.owns('usr_victim', 'wrld_pass'),
      true,
    );
  });
});
