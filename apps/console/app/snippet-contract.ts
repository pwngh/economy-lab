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
// The compiler owns the docs snippet contract: the facade must satisfy SnippetCtx, so renaming
// a facade method breaks the docs snippets at this app's typecheck, not in a reader's browser.
import type { SnippetCtx } from '../../docs/app/snippets/context';

type Satisfies<T extends SnippetCtx> = T;
export type FacadeSatisfiesSnippetCtx = Satisfies<ConsoleEngine>;
