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

// Hand a fresh-store factory to the shared Store conformance suite. This backend adds no
// behavior beyond what that suite checks, so one call covers it.

import { runStoreConformance } from '#test/conformance/store.ts';
import { memoryStore } from '#src/adapters/memory.ts';

runStoreConformance('memory', () => memoryStore());
