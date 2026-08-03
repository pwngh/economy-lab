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
 * The suites run against the implementation every other run is compared to.
 *
 * A conformance suite that passes nothing proves nothing, and the failure mode is quiet: a
 * refactor that stops registering cases leaves every driver green with an empty tally. Running the
 * store suite against the memory store here means the suite has to hold up under the one
 * implementation that is correct by construction, in this package, before any engine sees it.
 */

import { memoryStore } from '@pwngh/economy-lab/adapters';
import { STORE_CAPABILITIES } from '@pwngh/economy-lab/store-kit';
import { runStoreConformance } from '../src/index.js';

// Ten of the twelve, named rather than derived. `appendAll` and `lockMany` are the two the memory
// store does not offer, and declaring them anyway is what the suite refuses — so this list is a
// real claim being checked, not a copy of the answer.
runStoreConformance('memory oracle', () => memoryStore(), {
  capabilities: Object.fromEntries(
    STORE_CAPABILITIES.filter(
      (capability) => capability !== 'appendAll' && capability !== 'lockMany',
    ).map((capability) => [capability, true]),
  ),
});
