/**
 * @pwngh/economy-conformance
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

/**
 * The pieces of the suites that only their own tests read.
 *
 * A caller running conformance never needs these; the lab's `test/conformance-contract.test.ts`
 * does, because it holds the suites to their own shape — that every capability has a case, that
 * the oracle comparison really compares, that a rate limiter is left in a state it can be asked
 * about again. Keeping them off the main door means the published surface stays the five run
 * functions and their harness types.
 */
export {
  CAPABILITY_TESTS,
  agreesWithTheMemoryOracle,
  reOffersEveryUnmarkedRow,
} from './store.js';
export {
  leavesEveryStateItReaches,
  waitsOutTheReportedRetry,
} from './rate-limit.js';

// The harness types travel with the internals so a test can name what it builds.
export type { RateLimiterHarness } from './rate-limit.js';
