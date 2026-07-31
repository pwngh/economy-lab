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

import '#test/support/dist-guard.ts';

import { runStoreConformance } from '#test/conformance/store.ts';
import { memoryStore } from '#src/adapters/memory.ts';

// The reference adapter is a single writer, so it needs neither batched locking nor a fused
// multi-posting append. Declaring both absences holds that: teaching memory either one without
// teaching the suite to exercise it fails here.
runStoreConformance('memory', () => memoryStore(), {
  capabilities: { lockMany: false, appendAll: false },
});
