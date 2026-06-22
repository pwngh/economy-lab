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

import { configuredRates } from '#src/adapters/rates.ts';

// Three CREDIT-to-USD rates, each stored as an integer `rate` and a `scale` whose real value is
// rate / 10^scale. The buy rate (what a user pays per credit) is 1 / 10^2 = $0.01. The par rate
// (the credit's backing / cash-out value) is 5 / 10^3 = $0.005, and the payout rate equals par.
// `buy` is set above `par` so a credit costs more to buy than it backs/pays out — the gap is the
// platform's purchase-spread cut.
const RATES = {
  buyRate: 1n,
  buyScale: 2,
  parRate: 5n,
  parScale: 3,
  payoutRate: 5n,
  payoutScale: 3,
};

describe('configuredRates', () => {
  test('buy(CREDIT) returns the configured buy rate with an id encoding that rate', () => {
    const buy = configuredRates(RATES).buy('CREDIT');
    assert.equal(buy.rate, 1n);
    assert.equal(buy.scale, 2);
    assert.equal(buy.rateId, 'buy:CREDIT->USD:1/2');
  });

  test('buy(USD) is 1:1 — USD is the base unit, not converted', () => {
    const buy = configuredRates(RATES).buy('USD');
    assert.equal(buy.rate, 1n);
    assert.equal(buy.scale, 0);
  });

  test('par(CREDIT) returns the configured fixed rate with an id encoding that rate', () => {
    const par = configuredRates(RATES).par('CREDIT');
    assert.equal(par.rate, 5n);
    assert.equal(par.scale, 3);
    assert.equal(par.rateId, 'par:CREDIT->USD:5/3');
  });

  test('par(USD) is 1:1 — USD is the base unit, not converted', () => {
    const par = configuredRates(RATES).par('USD');
    assert.equal(par.rate, 1n);
    assert.equal(par.scale, 0);
  });

  test('payout(CREDIT, USD) returns the configured payout rate', async () => {
    const rate = await configuredRates(RATES).payout('CREDIT', 'USD', 0);
    assert.equal(rate.rate, 5n);
    assert.equal(rate.scale, 3);
    assert.equal(rate.rateId, 'payout:CREDIT->USD:5/3');
  });

  test('payout of a currency to itself is 1:1', async () => {
    const rate = await configuredRates(RATES).payout('USD', 'USD', 0);
    assert.equal(rate.rate, 1n);
    assert.equal(rate.scale, 0);
  });

  test('payout for an unconfigured pair throws rather than guessing', async () => {
    await assert.rejects(() =>
      configuredRates(RATES).payout('USD', 'CREDIT', 0),
    );
  });
});
