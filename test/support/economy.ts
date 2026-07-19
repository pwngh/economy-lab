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
import type { EconomyEvent, Store } from '#src/ports.ts';
import type { Config } from '#src/config.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  silentMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
  testSecrets,
} from '#test/support/capabilities.ts';

/**
 * A fresh in-memory economy driven only by `seed`: same result on any runtime, no shared state.
 * A passed `store` must use the same seeded digest and fixed clock, or the hashes diverge.
 * `config` overrides individual fields of the test default.
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
    rates: fixedRates(),
    logger: testLogger(),
    meter: silentMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: { ...testConfig(), ...config },
    secrets: testSecrets(),
  });
}

/** An economy plus its store, for tests that submit publicly then inspect what persisted. */
export function economyWithStore(
  seed = 1,
  config?: Partial<Config>,
): { economy: Economy; store: Store } {
  const store = seededStore(seed);
  return { economy: makeEconomy(seed, store, config), store };
}

/** A seeded in-memory Store on its own: a deterministic digest and a frozen clock, no economy. */
export function seededStore(seed = 1): Store {
  return memoryStore({ digest: seededDigest(seed), clock: fixedClock(0) });
}

/** Drains the outbox and returns the events it held: claim the batch, mark it relayed, project. */
export async function eventsOf(store: Store): Promise<EconomyEvent[]> {
  const batch = await store.outbox.claimBatch(100);
  await store.outbox.markRelayed(batch.map((message) => message.id));
  return batch.map((message) => message.event);
}
