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

// Every storage backend is tested the same way: pass a function that builds a fresh,
// empty store to the shared Store test suite, which then runs every required behavior
// against it. This in-memory backend has no behavior of its own beyond what that suite
// already checks, so the whole file is a single call.

import { runStoreConformance } from '#test/conformance/store.ts';
import { memoryStore } from '#src/adapters/memory.ts';

runStoreConformance('memory', () => memoryStore());
