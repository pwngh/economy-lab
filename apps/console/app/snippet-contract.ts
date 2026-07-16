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

import type { ConsoleEngine } from '~/economy';
import type { Economy } from '#src/economy.ts';

// The compiler owns the docs handoff contract: the engine must expose the real Economy the docs
// snippets submit through, so dropping or narrowing the handle breaks at this app's typecheck,
// not in a reader's browser.
type Satisfies<T extends Economy> = T;
export type EngineExposesEconomy = Satisfies<ConsoleEngine['economy']>;
