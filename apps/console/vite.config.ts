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
  // Served under /console beside the docs site; react-router.config.ts carries the matching
  // basename.
  base: '/console/',
  plugins: [reactRouter()],
  resolve: {
    alias: [
      // The engine's optional DB/cache/queue modules, stubbed: the tab sandbox never selects
      // them, and their node-only drivers must not reach the browser bundle. Listed before the
      // `#` catch-all so these exact specifiers win.
      {
        find: /^#src\/(engines\/postgres|engines\/mysql|adapters\/redis|adapters\/sqs)\.ts$/,
        replacement: `${appDir}unavailable.ts`,
      },
      // Bare driver packages src/index.ts dynamic-imports directly; unstubbed, ioredis ships
      // as an unreachable chunk.
      {
        find: /^(ioredis|@aws-sdk\/client-sqs)$/,
        replacement: `${appDir}unavailable.ts`,
      },
      // Rejects the digest's guarded probe so it falls back to Web Crypto; Vite's own shim would
      // import cleanly and fail only at the first hash.
      { find: /^node:crypto$/, replacement: `${appDir}no-node-crypto.ts` },
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${appDir}$1` },
    ],
  },
  ssr: {
    // A regex keeps every file under the repo `src/` tree in the transform path (the SPA build
    // still server-renders the shell).
    noExternal: [/economy-lab[\\/]src[\\/]/],
  },
  server: {
    // The fixed port the docs dev server proxies /console to (scripts/dev-site.mjs).
    port: 4174,
    strictPort: true,
    fs: {
      // Allow reading the engine source that lives above this app (the repo root).
      allow: ['..', '../..'],
    },
  },
});
