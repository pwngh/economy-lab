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

// Drives the spend handler's two input guards through the full public economy.submit path. This
// mirrors how entitlements.submit.test.ts exercises the authorization layer, whereas spend.test.ts
// calls the handler directly. Both guards protect one invariant: a spend can never mint cash-outable
// earned credit out of nothing.
//   1. Self-dealing. A buyer who names themselves as a recipient would turn their non-cashable
//      spendable or promo balance into cashable earned credit funded by platform revenue.
//   2. Per-recipient bounds. Shares like [-5000, 15000] sum to 10000 but assign one recipient a
//      negative cut and another more than the whole net. Each share must be strictly positive and
//      at most 10000 bps.
// A malformed split throws a fault (OP.MALFORMED). The fault surfaces through submit as a rejected
// promise rather than a returned business rejection.

function isMalformed(error: unknown): boolean {
  return (error as { code?: string }).code === 'OP.MALFORMED';
}

// Seeds a buyer's spendable balance through the public economy and asserts the top-up committed, so
// a following spend has real money to draw on.
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
          // Naming the buyer as sole recipient would mint cash-outable earned credit from their
          // own non-cashable balance.
          recipients: [{ sellerId: 'usr_buyer', shareBps: 10_000 }],
        }),
      ),
      isMalformed,
    );

    // The guard throws before any posting. The spendable balance is untouched and no earned
    // credit was created.
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
          // -5000 + 15000 == 10000, so the sum check passes. The per-recipient bounds check must
          // still reject the negative share and the share above 100%.
          recipients: [
            { sellerId: 'usr_a', shareBps: -5_000 },
            { sellerId: 'usr_b', shareBps: 15_000 },
          ],
        }),
      ),
      isMalformed,
    );

    // Nothing was posted, so the buyer was not charged.
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
    // The buyer paid full price.
    assert.deepEqual(
      await economy.read.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
    // Both sellers accrued earned credit, so the valid split paid out.
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
