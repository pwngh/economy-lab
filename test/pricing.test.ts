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

// Sums the signed amounts of every ledger line. The split returns only credit lines, which
// are stored as negative amounts, so a balanced split sums to -price. Every amount uses one
// currency, so a plain integer sum is correct.
function signedSum(legs: ReadonlyArray<Leg>): bigint {
  let total = 0n;
  for (let leg of legs) {
    total += leg.amount.minor;
  }
  return total;
}

// Returns the amount crediting the given account as a positive value (credits are stored
// negative, so the sign is flipped). Fails if the account was never credited.
function creditedTo(legs: ReadonlyArray<Leg>, account: string): Amount {
  let leg = legs.find((l) => l.account === account);
  assert.ok(leg, `expected a leg crediting ${account}`);
  return toAmount(leg.amount.currency, -leg.amount.minor);
}

function codeIs(code: string) {
  return (error: unknown): boolean =>
    (error as { code?: string }).code === code;
}

// One seller taking the whole net after fee. shareBps is basis points (10000 = 100%).
let soloSeller: Recipient[] = [{ sellerId: 'usr_seller', shareBps: 10_000 }];

// --- The conservation property ----------------------------------------------------

// Cases that check the price is fully accounted for. Some prices divide evenly. Others leave
// a rounding remainder that the split must park somewhere. Each case asserts the credit lines
// sum to -price.
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
  // A 10.00 sale at a 30% fee. The 3.00 fee comes off the gross and goes to revenue. The 7.00
  // net goes to the seller. The amounts divide evenly, so there is no leftover.
  let legs = flatFee()({
    price: credit('10.00'),
    recipients: soloSeller,
    feeBps: 3000,
  });

  assert.deepEqual(creditedTo(legs, earned('usr_seller')), credit('7.00'));
  assert.deepEqual(creditedTo(legs, SYSTEM.REVENUE), credit('3.00'));
}

function postsRoundingResidualToRevenue(): void {
  // 10.01 split three ways does not divide evenly, so each share rounds down. The dropped
  // cents go to REVENUE rather than vanishing, which keeps the whole price accounted for.
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
  // There are no sellers, so the fee plus the leftover net make up the whole price. That whole
  // price goes to REVENUE as a single credit line, which still sums to -price.
  let legs = flatFee()({
    price: credit('4.00'),
    recipients: [],
    feeBps: 3000,
  });

  assert.equal(legs.length, 1);
  assert.deepEqual(creditedTo(legs, SYSTEM.REVENUE), credit('4.00'));
}

function rejectsSharesThatDoNotSumToTotal(): void {
  // Shares sum to 9000 bps (90%), not the required 10000. Split rejects with OP.MALFORMED.
  // The spend handler checks this before calling; this is a backstop for wiring mistakes.
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
