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

import {
  SYSTEM,
  accountsOf,
  classify,
  currency,
  earned,
  isDebitNormal,
  isWalletAccount,
  promo,
  spendable,
} from '#src/accounts.ts';
import { spend, topUp, grantPromo } from '#test/support/builders.ts';
import { credit } from '#test/support/builders.ts';

describe('Accounts', () => {
  test('tags only TRUST_CASH and USD_CLEARING as USD', () => {
    assert.equal(currency(SYSTEM.TRUST_CASH), 'USD');
    assert.equal(currency(SYSTEM.USD_CLEARING), 'USD');
    assert.equal(currency(SYSTEM.REVENUE), 'CREDIT');
    assert.equal(currency(spendable('usr_a')), 'CREDIT');
  });

  test('classifies a spendable balance as user credits that need USD backing', () => {
    // A "custodial" balance is spendable credits that the platform must back with real USD held for the user.
    assert.equal(classify(spendable('usr_a')), 'custodial');
  });

  test('excludes earned, promo, and the payout reserve from the USD-backed total', () => {
    // An "excluded" balance is something the platform owes but need not hold USD against, so it stays
    // out of the cash-backing total. An earned balance is owed to a seller. A promo balance is a
    // marketing grant. PAYOUT_RESERVE is set aside for a pending payout.
    const cases = [earned('usr_a'), promo('usr_a'), SYSTEM.PAYOUT_RESERVE];

    for (const account of cases) {
      assert.equal(classify(account), 'excluded');
    }
  });

  test('marks the house accounts that grow on debits', () => {
    // A "debit-normal" account grows on a debit. isDebitNormal tells the ledger each line's sign.
    // These house accounts grow on debits. REVENUE and a spendable balance grow on credits, so they
    // return false.
    const debitNormal = [
      SYSTEM.TRUST_CASH,
      SYSTEM.USD_CLEARING,
      SYSTEM.RECEIVABLE,
      SYSTEM.PROMO_FLOAT,
      SYSTEM.OPENING_EQUITY,
    ];

    for (const account of debitNormal) {
      assert.equal(isDebitNormal(account), true);
    }
    assert.equal(isDebitNormal(SYSTEM.REVENUE), false);
    assert.equal(isDebitNormal(spendable('usr_a')), false);
  });
});

describe('Accounts: Lock Sets & Wallet Classification', () => {
  test('locks the buyer, seller, and system offset accounts a spend touches', () => {
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    });

    // accountsOf returns every account the operation might touch, including each movement's contra
    // (offsetting entry). The whole set is locked before posting so two operations cannot change one
    // balance concurrently. A spend can draw the buyer's promo grant and spendable balance, and it
    // pays the seller, so all of those are locked.
    const locked = new Set(accountsOf(operation));

    assert.equal(locked.has(promo('usr_buyer')), true);
    assert.equal(locked.has(spendable('usr_buyer')), true);
    assert.equal(locked.has(SYSTEM.PROMO_FLOAT), true);
    assert.equal(locked.has(SYSTEM.REVENUE), true);
    assert.equal(locked.has(earned('usr_seller')), true);
  });

  test('locks the buyer credit account and the USD cash accounts for a topUp', () => {
    const locked = new Set(
      accountsOf(topUp({ userId: 'usr_buyer', amount: credit('10.00') })),
    );

    assert.equal(locked.has(spendable('usr_buyer')), true);
    assert.equal(locked.has(SYSTEM.TRUST_CASH), true);
    assert.equal(locked.has(SYSTEM.USD_CLEARING), true);
  });

  test('locks the promo account and its offset account for a grant', () => {
    // A promo grant credits the user's promo account; PROMO_FLOAT is its contra. Only those two.
    const locked = new Set(
      accountsOf(grantPromo({ userId: 'usr_buyer', amount: credit('5.00') })),
    );

    assert.deepEqual(
      [...locked].sort(),
      [promo('usr_buyer'), SYSTEM.PROMO_FLOAT].sort(),
    );
  });

  test('treats every user account as a wallet and house accounts as not', () => {
    // isWalletAccount flags an instantly-cashable destination, which matters for money-laundering
    // checks. A user's own account (`usr_…:<kind>`) is a wallet. Every `platform:` house account is not.
    assert.equal(isWalletAccount(spendable('usr_a')), true);
    assert.equal(isWalletAccount(earned('usr_a')), true);
    assert.equal(isWalletAccount(promo('usr_a')), true);

    assert.equal(isWalletAccount(SYSTEM.REVENUE), false);
    assert.equal(isWalletAccount(SYSTEM.TRUST_CASH), false);
    assert.equal(isWalletAccount(SYSTEM.PAYOUT_RESERVE), false);
  });
});
