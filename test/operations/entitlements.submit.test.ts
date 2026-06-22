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

// These tests drive the full public `economy.submit` path, the layer where the permission check
// (`authorize`) lives. The sibling entitlements.test.ts calls the handlers directly and so never
// reaches that check; this file is what covers it.
//
// They are regression tests for an authorization bypass. The permission check has two parts: a
// list of operations only a system/operator caller may run at all, and an ownership rule for
// everyone else that only blocks taking money OUT of an account you don't own. revokeEntitlement
// was missing from that privileged-only list, and since it moves no money there is no account
// being drained for the ownership rule to catch — so a `kind:'user'` actor could revoke ANY other
// user's entitlement. It is now system/operator-only, which is what these tests pin. Each test
// builds the economy over a store it also holds a handle to, so it can confirm the victim's
// ownership is untouched after the rejected attempt — proof the request was stopped before it
// could change anything.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// A store wired with the same seeded digest + fixed clock the economy uses, returned alongside an
// economy built over it so a test can both submit operations and read entitlement ownership.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

// Grant `usr_victim` a sku (as a trusted system actor) so there is a real entitlement for an
// attacker to try to revoke out from under them.
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

    // The request was thrown out before it ran, so the victim still owns the sku.
    assert.equal(
      await store.entitlements.owns('usr_victim', 'wrld_pass'),
      true,
    );
  });

  test('rejects a user revoking even their OWN entitlement (revoke is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await grantToVictim(economy, 'wrld_pass');

    // Revoke is system/operator-only regardless of whose account it names, so a user acting on
    // their own sku is still unauthorized — the same rule that protects a foreign account.
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
