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

import type { Currency } from '#src/money.ts';
import type { Rate, Rates, Options } from '#src/ports.ts';

/**
 * Holds the three CREDIT-to-USD rates a deployment configures for its {@link Rates} dual-rate credit
 * economy. Credit value is platform-fixed, so all three are business constants, not a live market
 * feed. The `buy` rate is the acquisition rate: what a user pays per credit when buying (for example,
 * about 120 credits per USD, or $0.00833). The `par` rate is the redemption and backing rate: a
 * credit's cash-out floor (for example, about 200 credits per USD, or $0.005), used to check that the
 * platform holds enough real USD to back users' spendable credits. The `payout` rate is the creator
 * settlement rate: what a creator's earned credits convert to when cashing out, and it equals `par`.
 *
 * Each rate is two integers, `rate` and `scale`. The multiplier is `rate / 10^scale` (for example,
 * rate 5 and scale 3 give $0.005 per credit). Integers avoid floating-point error. The gap between
 * `buy` and `par` is the platform spread (for example, about 40 percent). That spread is the margin
 * between buying and cashing out, not a separate deduction.
 */
export interface RatesConfig {
  buyRate: bigint;
  buyScale: number;
  parRate: bigint;
  parScale: number;
  payoutRate: bigint;
  payoutScale: number;
}

// Builds a `Rate` for converting a currency to itself. It multiplies by one and leaves the amount unchanged.
function identityRate(from: Currency, to: Currency): Rate {
  return { rate: 1n, scale: 0, rateId: `${from}->${to}:1` };
}

/**
 * Builds the production CREDIT-to-USD rate source from a deployment's configured rates, replacing the
 * 1:1 dev placeholder. The rates are fixed business constants a deployment configures, not a live
 * market feed.
 *
 * Returns the three rates of the dual-rate credit economy: `buy` (the acquisition rate), `par` (the
 * redemption and backing rate), and `payout` (the creator settlement rate, which equals `par`). Each
 * rate carries a `rateId` naming the exact rate so a transaction can record which one it used.
 *
 * Same-currency conversion returns 1:1. Only CREDIT and USD exist, so any other pair is a wiring bug
 * and throws.
 *
 * @example
 *   // Example rates: buy at ~120 credits/USD ($0.00833), backed and cashed out at ~200/USD ($0.005), a ~40% spread:
 *   let rates = configuredRates({
 *     buyRate: 8333n, buyScale: 6,
 *     parRate: 5n, parScale: 3,
 *     payoutRate: 5n, payoutScale: 3,
 *   });
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/rates/ Rates} for the dual-rate credit economy this rate source feeds.
 */
export function configuredRates(config: RatesConfig): Rates {
  let buy: Rate = {
    rate: config.buyRate,
    scale: config.buyScale,
    rateId: `buy:CREDIT->USD:${config.buyRate}/${config.buyScale}`,
  };
  let par: Rate = {
    rate: config.parRate,
    scale: config.parScale,
    rateId: `par:CREDIT->USD:${config.parRate}/${config.parScale}`,
  };
  let payout: Rate = {
    rate: config.payoutRate,
    scale: config.payoutScale,
    rateId: `payout:CREDIT->USD:${config.payoutRate}/${config.payoutScale}`,
  };
  return {
    buy(currency: Currency): Rate {
      // Only the CREDIT buy rate is configured; USD is the base unit, so its buy is 1:1.
      return currency === 'CREDIT' ? buy : identityRate('USD', 'USD');
    },
    par(currency: Currency): Rate {
      // Only the CREDIT peg is configured; USD is the base unit, so its par is 1:1.
      return currency === 'CREDIT' ? par : identityRate('USD', 'USD');
    },
    async payout(
      from: Currency,
      to: Currency,
      _at: number,
      _options?: Options,
    ): Promise<Rate> {
      if (from === to) {
        return identityRate(from, to);
      }
      if (from === 'CREDIT' && to === 'USD') {
        return payout;
      }
      // `async`, so this rejects the promise (port returns `Promise<Rate>`) rather than throwing
      // synchronously, which a caller's `await` would miss.
      throw new Error(
        `configuredRates has no ${from}->${to} rate (only CREDIT->USD and same-currency are configured).`,
      );
    },
  };
}
