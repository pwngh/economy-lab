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
    // `classify` sorts an account into a class. "custodial" means credits the platform must
    // back with real USD held for users: a user's spendable balance.
    assert.equal(classify(spendable('usr_a')), 'custodial');
  });

  test('excludes earned, promo, and the payout reserve from the USD-backed total', () => {
    // "excluded" is the opposite of custodial: these are amounts the platform owes but does NOT
    // have to hold real USD against, so they stay out of the cash-backing total. earned = what a
    // seller is owed, promo = a marketing grant, PAYOUT_RESERVE = funds set aside for a payout.
    let cases = [earned('usr_a'), promo('usr_a'), SYSTEM.PAYOUT_RESERVE];

    for (let account of cases) {
      assert.equal(classify(account), 'excluded');
    }
  });

  test('marks the house accounts that grow on debits', () => {
    // An account is "debit-normal" when its balance grows on a debit (rather than on a credit).
    // `isDebitNormal` tells the ledger which sign to give a posted line. These house accounts
    // grow on debits; REVENUE and a user's spendable balance grow on credits, so they return false.
    let debitNormal = [
      SYSTEM.TRUST_CASH,
      SYSTEM.USD_CLEARING,
      SYSTEM.RECEIVABLE,
      SYSTEM.PROMO_FLOAT,
      SYSTEM.OPENING_EQUITY,
    ];

    for (let account of debitNormal) {
      assert.equal(isDebitNormal(account), true);
    }
    assert.equal(isDebitNormal(SYSTEM.REVENUE), false);
    assert.equal(isDebitNormal(spendable('usr_a')), false);
  });
});

describe('Accounts: Lock Sets & Wallet Classification', () => {
  test('locks the buyer, seller, and system offset accounts a spend touches', () => {
    let operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    });

    // `accountsOf` returns every account this operation might touch. The system locks that whole
    // set before posting so two operations can't change the same balance at the same time. Each
    // money movement also needs a matching offsetting entry (its "contra") to keep the books
    // balanced, so the set includes those too. A spend can draw from the buyer's promo grant and
    // their spendable balance, and pays the seller, so all of those accounts must be locked.
    let locked = new Set(accountsOf(operation));

    assert.equal(locked.has(promo('usr_buyer')), true);
    assert.equal(locked.has(spendable('usr_buyer')), true);
    assert.equal(locked.has(SYSTEM.PROMO_FLOAT), true);
    assert.equal(locked.has(SYSTEM.REVENUE), true);
    assert.equal(locked.has(earned('usr_seller')), true);
  });

  test('locks the buyer credit account and the USD cash accounts for a topUp', () => {
    let locked = new Set(
      accountsOf(topUp({ userId: 'usr_buyer', amount: credit('10.00') })),
    );

    assert.equal(locked.has(spendable('usr_buyer')), true);
    assert.equal(locked.has(SYSTEM.TRUST_CASH), true);
    assert.equal(locked.has(SYSTEM.USD_CLEARING), true);
  });

  test('locks the promo account and its offset account for a grant', () => {
    // Granting a promo credits the user's promo account; PROMO_FLOAT is the matching offsetting
    // entry (its contra), so those are the only two accounts the operation touches.
    let locked = new Set(
      accountsOf(grantPromo({ userId: 'usr_buyer', amount: credit('5.00') })),
    );

    assert.deepEqual(
      [...locked].sort(),
      [promo('usr_buyer'), SYSTEM.PROMO_FLOAT].sort(),
    );
  });

  test('treats every user account as a wallet and house accounts as not', () => {
    // `isWalletAccount` is the laundering-sensitive test for an instantly-cashable destination:
    // a user's own account (`usr_…:<kind>`) is a wallet, every `vrchat:` house account is not.
    assert.equal(isWalletAccount(spendable('usr_a')), true);
    assert.equal(isWalletAccount(earned('usr_a')), true);
    assert.equal(isWalletAccount(promo('usr_a')), true);

    assert.equal(isWalletAccount(SYSTEM.REVENUE), false);
    assert.equal(isWalletAccount(SYSTEM.TRUST_CASH), false);
    assert.equal(isWalletAccount(SYSTEM.PAYOUT_RESERVE), false);
  });
});
