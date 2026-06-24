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

import { createEconomy, type Economy } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import type { Store } from '#src/ports.ts';
import type { Config } from '#src/config.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';

/**
 * Build a fresh in-memory economy for one test with fake adapters (storage, clock, ids, digest, etc.).
 *
 * Fakes are driven only by `seed`: no real clock, randomness, or network. Same seed → same result on
 * any runtime (Node, Bun, Deno). Each call gets its own storage, so tests share no state.
 *
 * Pass `store` to run against a specific backend (e.g. one adapter from the matrix). It must use the
 * same seeded digest + fixed clock as this economy or hashes diverge. Omitted, a fresh in-memory one
 * is created, so existing `makeEconomy()` / `makeEconomy(seed)` calls are unchanged.
 *
 * Pass `config` to override individual default-test-config fields, e.g. a small `velocityLimitMinor`
 * so a fraud-throttling test reaches the ceiling without funding a user to seven figures. Unspecified
 * fields keep their `testConfig()` defaults.
 */
export function makeEconomy(
  seed = 1,
  store?: Store,
  config?: Partial<Config>,
): Economy {
  let digest = seededDigest(seed);
  let clock = fixedClock(0);
  return createEconomy({
    store: store ?? memoryStore({ digest, clock }),
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(seed),
    // Fixed CREDIT-to-USD rates. "payout" ($0.005) is paid when cashing a seller out; "par" ($0.005) is
    // the backing peg the cash-cover check uses; "buy" ($0.01) is what a user pays per credit at top-up.
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: { ...testConfig(), ...config },
  });
}
