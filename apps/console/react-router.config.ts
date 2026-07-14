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

// SPA mode: the engine runs in the visitor's tab. Client loaders read live engine state, client
// actions mutate it, and the build is static files — deployable on any file host. The app is
// served under /console beside the docs site (scripts/compose-site.mjs assembles the two).
export default {
  ssr: false,
  // Must begin with Vite's `base` ('/console/') for the dev server to route correctly.
  basename: '/console/',
} satisfies Config;
