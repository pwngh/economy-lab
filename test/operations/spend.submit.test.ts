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
  spend as buildSpend,
  credit,
} from '#test/support/builders.ts';
import { spendable, earned } from '#src/accounts.ts';

import type { Economy } from '#src/contract.ts';

// Drives the spend handler's input guards through the full `economy.submit` path; spend.test.ts
// calls the handler directly. Both guards protect one invariant: a spend can never mint payable
// earned credit out of nothing.

function isMalformed(error: unknown): boolean {
  return (error as { code?: string }).code === 'OP.MALFORMED';
}

async function fund(economy: Economy, userId: string): Promise<void> {
  const outcome = await economy.submit(
    buildTopUp({ userId, amount: credit('10.00') }),
  );
  assert.equal(outcome.status, 'committed');
}

describe('Spend Input Guards Through economy.submit', () => {
  test('rejects a spend where a recipient is the buyer (self-dealing) with OP.MALFORMED', async () => {
    const economy = makeEconomy();
    await fund(economy, 'usr_buyer');

    await assert.rejects(
      economy.submit(
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: 'usr_buyer', shareBps: 10_000 }],
        }),
      ),
      isMalformed,
    );

    assert.deepEqual(
      await economy.read.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
    assert.deepEqual(
      await economy.read.balance(earned('usr_buyer')),
      credit('0.00'),
    );
  });

  test('rejects a spend whose per-recipient shares are out of bounds even when they sum to 10000', async () => {
    const economy = makeEconomy();
    await fund(economy, 'usr_buyer');

    await assert.rejects(
      economy.submit(
        buildSpend({
          buyerId: 'usr_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [
            { sellerId: 'usr_a', shareBps: -5_000 },
            { sellerId: 'usr_b', shareBps: 15_000 },
          ],
        }),
      ),
      isMalformed,
    );

    assert.deepEqual(
      await economy.read.balance(spendable('usr_buyer')),
      credit('10.00'),
    );
  });

  test('still commits a normal two-recipient spend with a valid split', async () => {
    const economy = makeEconomy();
    await fund(economy, 'usr_buyer');

    const outcome = await economy.submit(
      buildSpend({
        buyerId: 'usr_buyer',
        sku: 'wrld_bundle',
        price: credit('4.00'),
        recipients: [
          { sellerId: 'usr_a', shareBps: 6_000 },
          { sellerId: 'usr_b', shareBps: 4_000 },
        ],
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      await economy.read.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
    assert.equal(
      (await economy.read.balance(earned('usr_a'))).minor > 0n,
      true,
    );
    assert.equal(
      (await economy.read.balance(earned('usr_b'))).minor > 0n,
      true,
    );
  });
});
