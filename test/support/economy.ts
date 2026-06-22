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
 * Build a fresh in-memory economy for one test, wired with fake versions of everything it
 * needs from the outside world (storage, clock, id generator, hashing, and so on).
 *
 * Every fake is driven only by `seed`, so a test never touches the real clock, real randomness,
 * or the network. The same seed always produces the same result, and on any runtime (Node, Bun,
 * Deno). Each call returns a brand-new economy with its own storage, so tests share no state.
 *
 * Pass a `store` to drive the economy against a specific backend (for example one adapter from
 * the adapter matrix). The store MUST be built with the same seeded digest + fixed clock as
 * this economy, or hashes will diverge. With no `store`, a fresh in-memory one is created here,
 * so every existing `makeEconomy()` / `makeEconomy(seed)` call keeps its current behaviour.
 *
 * Pass `config` to override individual fields of the default test config — for example a small
 * `velocityLimitMinor` so a fraud-throttling test can reach the ceiling without funding a user
 * to seven figures. Unspecified fields keep their `testConfig()` defaults.
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
    // Fixed exchange rates: how much one CREDIT is worth in US dollars. Two rates are exposed: the
    // "payout" rate used when paying a seller out ($0.005), and the "par" rate — the peg used to
    // check the platform holds enough real cash to cover users' credit balances ($0.01).
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: { ...testConfig(), ...config },
  });
}
