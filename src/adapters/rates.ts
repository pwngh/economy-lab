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
 * economy. Each rate is two integers (`rate` and `scale`), so conversion stays free of
 * floating-point error. These are business constants a deployment sets, not a live market feed.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/money-model/ The money model} for
 *   what the buy, par, and payout rates mean and how the buy-par spread funds the platform.
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/rates/ Rates} for the port these feed.
 */
export interface RatesConfig {
  buyRate: bigint;
  buyScale: number;
  parRate: bigint;
  parScale: number;
  payoutRate: bigint;
  payoutScale: number;
}

function identityRate(from: Currency, to: Currency): Rate {
  return { rate: 1n, scale: 0, rateId: `${from}->${to}:1` };
}

/**
 * Builds the production CREDIT-to-USD rate source from a deployment's configured rates, replacing the
 * 1:1 dev placeholder. Each returned rate carries a `rateId` naming the exact rate so a transaction
 * can record which one it priced against.
 *
 * Same-currency conversion returns 1:1. Only CREDIT and USD exist, so any other pair is a wiring bug
 * and throws.
 *
 * @example
 * // Example rates: buy at ~120 credits/USD ($0.00833), backed and cashed out at ~200/USD ($0.005),
 * a ~40% spread:
 *   const rates = configuredRates({
 *     buyRate: 8333n, buyScale: 6,
 *     parRate: 5n, parScale: 3,
 *     payoutRate: 5n, payoutScale: 3,
 *   });
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/rates/ Rates} for the dual-rate
 *   credit economy this rate source feeds.
 */
export function configuredRates(config: RatesConfig): Rates {
  const buy: Rate = {
    rate: config.buyRate,
    scale: config.buyScale,
    rateId: `buy:CREDIT->USD:${config.buyRate}/${config.buyScale}`,
  };
  const par: Rate = {
    rate: config.parRate,
    scale: config.parScale,
    rateId: `par:CREDIT->USD:${config.parRate}/${config.parScale}`,
  };
  const payout: Rate = {
    rate: config.payoutRate,
    scale: config.payoutScale,
    rateId: `payout:CREDIT->USD:${config.payoutRate}/${config.payoutScale}`,
  };
  return {
    buy(currency: Currency): Rate {
      return currency === 'CREDIT' ? buy : identityRate('USD', 'USD');
    },
    par(currency: Currency): Rate {
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
      throw new Error(
        `configuredRates has no ${from}->${to} rate (only CREDIT->USD and same-currency are configured).`,
      );
    },
  };
}
