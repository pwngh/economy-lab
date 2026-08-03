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

/**
 * The adapter conformance suites, gathered as the package's '/testing' entry. A host writing its
 * own Store, Cache, RateLimiter, Dispatcher, or Processor runs its adapter through the same suite
 * the built-ins pass, so it cannot silently diverge from the ledger invariants. Each suite is
 * written for `node --test`. The memory adapter is the oracle the others are matched against.
 *
 * @module testing
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the Store
 *   port and the conformance suite that holds every implementation to identical behavior.
 */

export { runStoreConformance } from './store.js';
export type { StoreConformanceOptions } from './store.js';
// The declaration a store passes is typed by the roster, so an implementation outside this repo
// can name its capabilities and be refused on the ones it does not carry.
export type { StoreCapability } from '@pwngh/economy-lab/ports';
export { runCacheConformance } from './cache.js';
export { runRateLimiterConformance } from './rate-limit.js';
export type { RateLimiterHarness } from './rate-limit.js';
export { runDispatcherConformance } from './dispatcher.js';
export type { DispatcherHarness } from './dispatcher.js';
export { runProcessorConformance } from './processor.js';
export type { ProcessorHarness } from './processor.js';
