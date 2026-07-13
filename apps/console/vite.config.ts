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

import { fileURLToPath } from 'node:url';

import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

// Repo root, two levels up. The `#`-scoped aliases (root package.json "imports": `#src/*`,
// `#test/*`, `#scripts/*`) are scoped to the nearest package.json — apps/console's, not the root —
// so Vite (below) and this app's tsconfig "paths" must each re-map `#<path>` -> `<repoRoot>/<path>`.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// This app's source root. The `~/*` -> `./app/*` alias is in tsconfig "paths" (type-checker only);
// Vite needs its own resolver entry below, or `~/x` imports fail at build/SSR time.
const appDir = fileURLToPath(new URL('./app/', import.meta.url));

// The engine at ../../src is `.ts` source with explicit `.ts` specifiers (the repo's no-build
// convention), so SSR must transform it rather than treat it as an external Node module.
export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: [
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${appDir}$1` },
    ],
  },
  ssr: {
    // A regex keeps every file under the repo `src/` tree in the transform path.
    noExternal: [/economy-lab[\\/]src[\\/]/],
    // The optional DB/cache/queue drivers are dynamically imported by the engine's store selection
    // only when DATABASE_URL is set; keep them external so an unused driver is never bundled or
    // required.
    external: ['pg', 'mysql2', 'ioredis', '@aws-sdk/client-sqs'],
  },
  server: {
    fs: {
      // Allow reading the engine source that lives above this app (the repo root).
      allow: ['..', '../..'],
    },
  },
});
