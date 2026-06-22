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

import type { Economy, Outcome } from '#src/contract.ts';

// These tests drive the full public `economy.submit` path so the spend handler's two input
// guards are exercised end to end, the same way entitlements.submit.test.ts exercises the
// authorization layer. The sibling spend.test.ts calls the handler directly; this file proves
// the guards reject a bad split before any money moves and let a normal split commit.
//
// Both guards protect the same invariant — that a spend can never mint cash-outable EARNED
// credit out of nothing:
//   1. Self-dealing: a buyer naming themselves as a recipient would turn their own non-cashable
//      spendable/promo balance into withdrawable EARNED credit funded by platform REVENUE.
//   2. Per-recipient bounds: shares like [-5000, 15000] still sum to 10000 but assign one
//      recipient a negative cut and another more than the whole net; each share must be
//      strictly positive and at most 10000 bps on its own.
// A malformed split is thrown as a fault (OP.MALFORMED), surfacing through submit as a rejected
// promise, not as a returned business rejection.

function isMalformed(error: unknown): boolean {
  return (error as { code?: string }).code === 'OP.MALFORMED';
}

// Seed a buyer's spendable balance through the public economy, asserting the top-up committed,
// so a following spend has real money to draw on.
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
          // The buyer names themselves as the sole recipient: this would mint cash-outable
          // EARNED credit for them out of their own non-cashable balance.
          recipients: [{ sellerId: 'usr_buyer', shareBps: 10_000 }],
        }),
      ),
      isMalformed,
    );

    // Thrown before posting: the buyer's spendable balance is untouched and they earned nothing.
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
          // -5000 + 15000 == 10000, so the sum check alone would pass; a negative share and a
          // >100% share must still be rejected by the per-recipient bounds check.
          recipients: [
            { sellerId: 'usr_a', shareBps: -5_000 },
            { sellerId: 'usr_b', shareBps: 15_000 },
          ],
        }),
      ),
      isMalformed,
    );

    // Nothing posted: the buyer was not charged.
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
    // The buyer paid the full price: spendable drops from 10.00 to 6.00.
    assert.deepEqual(
      await economy.read.balance(spendable('usr_buyer')),
      credit('6.00'),
    );
    // Both distinct sellers accrued earned credit, so the valid split really paid out.
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
