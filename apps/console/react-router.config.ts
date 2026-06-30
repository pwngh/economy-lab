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

import type { Config } from '@react-router/dev/config';

// SSR on: the engine runs on the server. Loaders read live engine state, actions mutate it, and
// the HTML reflects the in-memory (or DB-backed) ledger.
export default {
  ssr: true,
} satisfies Config;
