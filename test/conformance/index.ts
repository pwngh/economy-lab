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
 * own Store, Cache, Dispatcher, or Processor runs its adapter through the same suite the built-ins
 * pass, so it cannot silently diverge from the ledger invariants. Each suite is written for
 * `node --test`; the memory adapter is the oracle the others are matched against.
 *
 * @module
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the Store
 *   port and the conformance suite that holds every implementation to identical behavior.
 */

export { runStoreConformance } from '#test/conformance/store.ts';
export { runCacheConformance } from '#test/conformance/cache.ts';
export { runDispatcherConformance } from '#test/conformance/dispatcher.ts';
export type { DispatcherHarness } from '#test/conformance/dispatcher.ts';
export { runProcessorConformance } from '#test/conformance/processor.ts';
export type { ProcessorHarness } from '#test/conformance/processor.ts';
