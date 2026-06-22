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
 * The three CREDIT-to-USD rates a deployment configures. A credit's value is fixed by the platform,
 * so all are business constants, not a live market feed:
 * - `buy` is what a user pays per credit when buying (VRChat ≈120 credits/USD = $0.00833);
 * - `par` is what one credit is worth for backing — its cash-out floor (VRChat ≈200/USD = $0.005),
 *   used to check the platform holds enough real USD to back users' spendable credits;
 * - `payout` is the rate a creator's earned credits convert to USD at when cashing out (= `par`).
 *
 * Each rate is stored as two integers, `rate` and `scale`, where the real multiplier is
 * `rate / 10^scale` (e.g. rate 5, scale 3 → $0.005 per credit) — integers avoid floating-point
 * error. The gap between `buy` and `par` is the platform's purchase-spread revenue — VRChat's ~40%
 * "purchase fee" (the buy-vs-cash-out spread, not a separate deduction). See docs/vrchat-grounding.md.
 */
export interface RatesConfig {
  buyRate: bigint;
  buyScale: number;
  parRate: bigint;
  parScale: number;
  payoutRate: bigint;
  payoutScale: number;
}

// A `Rate` for converting a currency to itself: multiply by one, leave the amount unchanged.
function identityRate(from: Currency, to: Currency): Rate {
  return { rate: 1n, scale: 0, rateId: `${from}->${to}:1` };
}

/**
 * The production source of CREDIT-to-USD exchange rates, for real deployments to use in place of
 * the 1:1 placeholder used in development. The rates are fixed business constants a deployment
 * configures, not a live market feed.
 *
 * It returns three rates: `buy` (what a user pays per credit), `par` (the credit's backing/cash-out
 * value), and `payout` (the rate a creator's earned credits convert to USD at). Each carries a
 * `rateId` string naming that exact rate, so a transaction can record which rate it used.
 *
 * Converting a currency to itself returns a 1:1 rate. Only CREDIT and USD exist, so any other
 * currency pair is a bug in how this was wired up and throws.
 *
 * @example
 *   // VRChat: buy ≈120 credits/USD ($0.00833), backed/cashed at ≈200/USD ($0.005) — a ~40% spread:
 *   let rates = configuredRates({
 *     buyRate: 8333n, buyScale: 6,
 *     parRate: 5n, parScale: 3,
 *     payoutRate: 5n, payoutScale: 3,
 *   });
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
      // `async`, so this surfaces as a rejected promise (the port returns `Promise<Rate>`), not a
      // synchronous throw a caller's `await` would miss.
      throw new Error(
        `configuredRates has no ${from}->${to} rate (only CREDIT->USD and same-currency are configured).`,
      );
    },
  };
}
