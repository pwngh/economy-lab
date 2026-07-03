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
 * Builds a fresh in-memory economy for one test with fake adapters for storage, clock, ids, and digest.
 *
 * The fakes are driven only by `seed`. They use no real clock, randomness, or network. The same seed
 * produces the same result on any runtime (Node, Bun, Deno). Each call gets its own storage, so tests
 * share no state.
 *
 * Pass `store` to run against a specific backend, such as one adapter from the matrix. That store must
 * use the same seeded digest and fixed clock as this economy, or the hashes diverge. When `store` is
 * omitted, a fresh in-memory store is created, so existing `makeEconomy()` and `makeEconomy(seed)`
 * calls are unchanged.
 *
 * Pass `config` to override individual fields of the default test config. For example, a small
 * `velocityLimitMinor` lets a fraud-throttling test reach the ceiling without funding a user to seven
 * figures. Unspecified fields keep their `testConfig()` defaults.
 */
export function makeEconomy(
  seed = 1,
  store?: Store,
  config?: Partial<Config>,
): Economy {
  const digest = seededDigest(seed);
  const clock = fixedClock(0);
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

/**
 * Builds an economy plus a handle on its store, for tests that submit through the public surface
 * and then inspect what persisted. Same seed-1 doubles as `makeEconomy()`; the store shares the
 * economy's digest and clock so hashes agree.
 */
export function economyWithStore(
  seed = 1,
  config?: Partial<Config>,
): { economy: Economy; store: Store } {
  const store = memoryStore({
    digest: seededDigest(seed),
    clock: fixedClock(0),
  });
  return { economy: makeEconomy(seed, store, config), store };
}
