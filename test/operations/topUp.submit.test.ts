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

import { economyWithStore } from '#test/support/economy.ts';
import {
  topUp as buildTopUp,
  principal,
  credit,
  usd,
} from '#test/support/builders.ts';
import { spendable, SYSTEM } from '#src/accounts.ts';
import { hasCode } from '#test/support/capabilities.ts';

// Drives the full `economy.submit` path, where the `authorize` check runs; the sibling
// topUp.test.ts calls the handler directly and never reaches it. topUp is system/operator-only:
// it mints spendable credits against real cash held in trust.

const isUnauthorized = hasCode('AUTH.UNAUTHORIZED');

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

    assert.deepEqual(
      await store.ledger.balance(spendable('usr_buyer')),
      credit('0.00'),
    );
  });

  test('still commits a topUp run by a trusted system actor', async () => {
    const { economy, store } = economyWithStore();

    // The topUp builder defaults to a system actor.
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
      // 10.00 credits at the $0.005 par rate = $0.05 held in trust.
      usd('0.05'),
    );
  });
});
