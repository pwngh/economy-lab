/// <reference types="node" />
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

import { flatFee } from '#src/pricing.ts';
import { credit } from '#test/support/builders.ts';
import { toAmount } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Recipient } from '#src/contract.ts';
import type { Leg } from '#src/ports.ts';

// Adds up the signed amounts of every ledger line in a sale. The split function returns
// only the credit lines, and credits are stored as negative amounts, so a balanced split
// sums to the negative of the price. Every test here uses one currency, so a plain sum is
// enough.
function signedSum(legs: ReadonlyArray<Leg>): bigint {
  let total = 0n;
  for (let leg of legs) {
    total += leg.amount.minor;
  }
  return total;
}

// Finds the line that credits the given account and returns the amount as a positive value.
// Credits are stored as negative amounts, so this flips the sign back to make the expected
// dollar value easy to compare against. Fails the test if the account was never credited, so
// a missing line is caught loudly instead of silently passing.
function creditedTo(legs: ReadonlyArray<Leg>, account: string): Amount {
  let leg = legs.find((l) => l.account === account);
  assert.ok(leg, `expected a leg crediting ${account}`);
  return toAmount(leg.amount.currency, -leg.amount.minor);
}

function codeIs(code: string) {
  return (error: unknown): boolean =>
    (error as { code?: string }).code === code;
}

// One seller who takes the entire amount left after the fee. shareBps is in basis points,
// where 10000 means 100%. This is the ordinary one-seller sale used across the tests.
let soloSeller: Recipient[] = [{ sellerId: 'usr_seller', shareBps: 10_000 }];

// --- The conservation property ----------------------------------------------------

// Cases that check the price is fully accounted for. Some prices and splits divide evenly,
// others leave a remainder that rounding can drop; the awkward ones are the real test,
// since the split has to park the leftover somewhere. Each case checks the credit lines add
// up to the negative of the price (credits are stored negative).
let CONSERVATION_CASES: ReadonlyArray<{
  name: string;
  price: Amount;
  feeBps: number;
  recipients: Recipient[];
}> = [
  {
    name: 'a single seller, fee divides evenly',
    price: credit('10.00'),
    feeBps: 3000,
    recipients: soloSeller,
  },
  {
    name: 'a two-way split, net divides evenly',
    price: credit('12.00'),
    feeBps: 3000,
    recipients: [
      { sellerId: 'usr_a', shareBps: 6_000 },
      { sellerId: 'usr_b', shareBps: 4_000 },
    ],
  },
  {
    name: 'a tiny price where the fee rounds down to fewer cents',
    price: credit('0.07'),
    feeBps: 3000,
    recipients: soloSeller,
  },
  {
    name: 'a three-way split with a rounding remainder',
    price: credit('10.01'),
    feeBps: 250,
    recipients: [
      { sellerId: 'usr_a', shareBps: 3_334 },
      { sellerId: 'usr_b', shareBps: 3_333 },
      { sellerId: 'usr_c', shareBps: 3_333 },
    ],
  },
  {
    name: 'a zero fee, the whole price splits',
    price: credit('9.99'),
    feeBps: 0,
    recipients: soloSeller,
  },
  {
    name: 'a full fee, the whole price is REVENUE',
    price: credit('5.00'),
    feeBps: 10_000,
    recipients: soloSeller,
  },
  {
    name: 'no recipients, the whole price is REVENUE',
    price: credit('4.00'),
    feeBps: 3000,
    recipients: [],
  },
  {
    name: 'a price beyond the safe-integer limit',
    price: toAmount('CREDIT', 9_007_199_254_740_993n),
    feeBps: 1234,
    recipients: [
      { sellerId: 'usr_a', shareBps: 5_000 },
      { sellerId: 'usr_b', shareBps: 5_000 },
    ],
  },
];

// --- The cases --------------------------------------------------------------------

function conservesPriceAcrossPricesAndSplits(): void {
  let policy = flatFee();

  for (let testCase of CONSERVATION_CASES) {
    let legs = policy({
      price: testCase.price,
      recipients: testCase.recipients,
      feeBps: testCase.feeBps,
    });

    assert.equal(
      signedSum(legs),
      -testCase.price.minor,
      `${testCase.name}: legs must sum to −price`,
    );
  }
}

function splitsFeeOffGrossAndShareOffNet(): void {
  // A 10.00 sale at a 30% fee: take the 3.00 fee off the full price, leaving 7.00 for the
  // one seller; the 3.00 fee goes to the platform's revenue. This price divides evenly, so
  // there is no leftover to park.
  let legs = flatFee()({
    price: credit('10.00'),
    recipients: soloSeller,
    feeBps: 3000,
  });

  assert.deepEqual(creditedTo(legs, earned('usr_seller')), credit('7.00'));
  assert.deepEqual(creditedTo(legs, SYSTEM.REVENUE), credit('3.00'));
}

function postsRoundingResidualToRevenue(): void {
  // 10.01 split three ways does not divide evenly, so each seller's share is rounded down.
  // The few cents that rounding drops are credited to the platform's revenue instead of
  // disappearing, which is what keeps the whole price accounted for.
  let price = credit('10.01');
  let recipients: Recipient[] = [
    { sellerId: 'usr_a', shareBps: 3_334 },
    { sellerId: 'usr_b', shareBps: 3_333 },
    { sellerId: 'usr_c', shareBps: 3_333 },
  ];

  let legs = flatFee()({ price, recipients, feeBps: 0 });

  let toSellers =
    creditedTo(legs, earned('usr_a')).minor +
    creditedTo(legs, earned('usr_b')).minor +
    creditedTo(legs, earned('usr_c')).minor;
  assert.ok(creditedTo(legs, SYSTEM.REVENUE).minor > 0n);
  assert.equal(toSellers + creditedTo(legs, SYSTEM.REVENUE).minor, price.minor);
}

function sendsWholePriceToRevenueWhenNoRecipients(): void {
  // With no sellers to pay, the amount left after the fee has nowhere to go, so the fee plus
  // that leftover (together the whole price) all goes to the platform's revenue as a single
  // credit line that still sums to the negative of the price.
  let legs = flatFee()({
    price: credit('4.00'),
    recipients: [],
    feeBps: 3000,
  });

  assert.equal(legs.length, 1);
  assert.deepEqual(creditedTo(legs, SYSTEM.REVENUE), credit('4.00'));
}

function rejectsSharesThatDoNotSumToTotal(): void {
  // These shares add up to 9000 basis points (90%), not the required 10000 (100%). The split
  // refuses such a list with an OP.MALFORMED error. The spend handler already checks this
  // before calling, so this is a backstop that makes a wiring mistake fail loudly.
  assert.throws(
    () =>
      flatFee()({
        price: credit('10.00'),
        recipients: [
          { sellerId: 'usr_a', shareBps: 5_000 },
          { sellerId: 'usr_b', shareBps: 4_000 },
        ],
        feeBps: 3000,
      }),
    codeIs('OP.MALFORMED'),
  );
}

describe('Pricing', () => {
  test('conserves price to the last minor unit across prices and splits', () =>
    conservesPriceAcrossPricesAndSplits());
  test('splits the fee off the gross and the share off the net', () =>
    splitsFeeOffGrossAndShareOffNet());
  test('posts the rounding residual to REVENUE so nothing is lost', () =>
    postsRoundingResidualToRevenue());
  test('sends the whole price to REVENUE when there are no recipients', () =>
    sendsWholePriceToRevenueWhenNoRecipients());
  test('rejects a split whose shareBps do not sum to 10000', () =>
    rejectsSharesThatDoNotSumToTotal());
});
