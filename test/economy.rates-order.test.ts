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

import { economyFromCapabilities } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { topUp, credit } from '#test/support/builders.ts';
import {
  defaultPricing,
  fakeProcessor,
  fixedClock,
  hasCode,
  noopMeter,
  seededDigest,
  seededSigner,
  sequentialIds,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Rate, Rates } from '#src/ports.ts';

// A hand-built source whose buy/par the test controls; payout is never asked here.
function ratesOf(buy: Rate, par: () => Rate): Rates {
  return {
    buy: () => buy,
    par,
    payout: async () => par(),
  };
}

function rate(rateId: string, minor: bigint, scale: number): Rate {
  return { rate: minor, scale, rateId };
}

function economyWith(rates: Rates): ReturnType<typeof economyFromCapabilities> {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  return economyFromCapabilities({
    store: memoryStore({ digest, clock }),
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    rates,
    logger: testLogger(),
    meter: noopMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
  });
}

describe('Rate Ordering', () => {
  test('construction refuses a source whose buy is below par', () => {
    const misordered = ratesOf(rate('r_buy', 1n, 3), () =>
      rate('r_par', 5n, 3),
    );

    assert.throws(() => economyWith(misordered), hasCode('CONFIG.INVALID'));
  });

  test('construction accepts buy equal to par and compares across scales', () => {
    // buy 10/10^3 equals par 1/10^2; a naive same-scale comparison would misread it.
    const equal = ratesOf(rate('r_buy', 10n, 3), () => rate('r_par', 1n, 2));

    assert.equal(typeof economyWith(equal).submit, 'function');
  });

});
