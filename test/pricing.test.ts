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
import { hasCode } from '#test/support/capabilities.ts';

import { feeForPrice, flatFee, revenueForSplit } from '#src/pricing.ts';
import { credit } from '#test/support/builders.ts';
import { toAmount } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Recipient } from '#src/contract.ts';
import type { Leg } from '#src/ports.ts';

// The split returns only credit lines, stored negative, so a fully accounted split sums to -price.
function signedSum(legs: ReadonlyArray<Leg>): bigint {
  let total = 0n;
  for (const leg of legs) {
    total += leg.amount.minor;
  }
  return total;
}

// Returns the credit to the account as a positive value (credits are stored negative).
function creditedTo(legs: ReadonlyArray<Leg>, account: string): Amount {
  const leg = legs.find((l) => l.account === account);
  assert.ok(leg, `expected a leg crediting ${account}`);
  return toAmount(leg.amount.currency, -leg.amount.minor);
}

const soloSeller: Recipient[] = [{ sellerId: 'usr_seller', shareBps: 10_000 }];

const CONSERVATION_CASES: ReadonlyArray<{
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

describe('Pricing', () => {
  test('conserves price to the last minor unit across prices and splits', () => {
    const policy = flatFee();

    for (const testCase of CONSERVATION_CASES) {
      const legs = policy({
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
  });

  test('splits the fee off the gross and the share off the net', () => {
    const legs = flatFee()({
      price: credit('10.00'),
      recipients: soloSeller,
      feeBps: 3000,
    });

    assert.deepEqual(creditedTo(legs, earned('usr_seller')), credit('7.00'));
    assert.deepEqual(creditedTo(legs, SYSTEM.REVENUE), credit('3.00'));
  });

  test('posts the rounding residual to REVENUE so nothing is lost', () => {
    const price = credit('10.01');
    const recipients: Recipient[] = [
      { sellerId: 'usr_a', shareBps: 3_334 },
      { sellerId: 'usr_b', shareBps: 3_333 },
      { sellerId: 'usr_c', shareBps: 3_333 },
    ];

    const legs = flatFee()({ price, recipients, feeBps: 0 });

    const toSellers =
      creditedTo(legs, earned('usr_a')).minor +
      creditedTo(legs, earned('usr_b')).minor +
      creditedTo(legs, earned('usr_c')).minor;
    assert.ok(creditedTo(legs, SYSTEM.REVENUE).minor > 0n);
    assert.equal(
      toSellers + creditedTo(legs, SYSTEM.REVENUE).minor,
      price.minor,
    );
  });

  test('sends the whole price to REVENUE when there are no recipients', () => {
    const legs = flatFee()({
      price: credit('4.00'),
      recipients: [],
      feeBps: 3000,
    });

    assert.equal(legs.length, 1);
    assert.deepEqual(creditedTo(legs, SYSTEM.REVENUE), credit('4.00'));
  });

  test('refuses a price in a currency the whole-credit rounding cannot fit', () => {
    // 15.3% of USD:1.07 is 16.371 cents, and rounding that up to a whole unit takes USD:1.00 —
    // 93% of the price. The fee-exceeds-price cap cannot catch it either, because 100 is below
    // 107. The rounding unit is one whole credit, so a price that is not CREDIT is refused.
    const price = toAmount('USD', 107n);

    assert.throws(() => feeForPrice(price, 1_530), hasCode('OP.MALFORMED'));
    assert.throws(
      () => revenueForSplit(price, soloSeller, 1_530),
      hasCode('OP.MALFORMED'),
    );
    assert.throws(
      () => flatFee()({ price, recipients: soloSeller, feeBps: 1_530 }),
      hasCode('OP.MALFORMED'),
    );
  });

  test('charges CREDIT at the same fee the refusal was added around', () => {
    // The two rules the refusal must leave alone: the fee rounds up to the whole credit, and it
    // is capped at the price when the rounded fee would exceed it.
    assert.equal(feeForPrice(credit('1000.00'), 1_530), 15_300n);
    assert.equal(feeForPrice(credit('1000.50'), 1_530), 15_400n);
    assert.equal(feeForPrice(credit('0.50'), 1_530), 50n);
    assert.equal(
      revenueForSplit(credit('1000.00'), soloSeller, 1_530),
      15_300n,
    );
  });

  test('rejects a split whose shareBps do not sum to 10000', () => {
    // The spend handler checks shares before calling; this throw is a backstop for wiring mistakes.
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
      hasCode('OP.MALFORMED'),
    );
  });
});
