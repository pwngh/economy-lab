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

import { runStoreConformance } from '#test/conformance/store.ts';
import { memoryStore } from '#src/adapters/memory.ts';

runStoreConformance('memory', () => memoryStore());
