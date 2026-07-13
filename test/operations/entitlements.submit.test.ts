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

// Drives the full `economy.submit` path, where the permission check (`authorize`) runs; the sibling
// entitlements.test.ts calls handlers directly and never reaches it. Pins revokeEntitlement as
// system/operator-only — it moves no money, so the ownership rule alone would let a user revoke
// anyone's entitlement.

function isUnauthorized(error: unknown): boolean {
  return (error as { code?: string }).code === 'AUTH.UNAUTHORIZED';
}

// The economy and the store share one seeded digest and fixed clock so their hashes agree.
function economyWithStore(): { economy: Economy; store: Store } {
  const store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
  return { economy: makeEconomy(1, store), store };
}

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

    assert.equal(
      await store.entitlements.owns('usr_victim', 'wrld_pass'),
      true,
    );
  });

  test('rejects a user revoking even their OWN entitlement (revoke is privileged-only)', async () => {
    const { economy, store } = economyWithStore();
    await grantToVictim(economy, 'wrld_pass');

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
