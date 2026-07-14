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

import { defineConfig } from 'vite';

// The runnable-snippet runner, built ahead of the docs build into public/runner/ (gitignored) so
// react-router build ships it as static assets: a tiny loader.js the pages reference, and the
// engine chunk it dynamic-imports on the first Run click. The engine is the console's own facade,
// so this config re-maps the console app's aliases (see apps/console/vite.config.ts).
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const consoleApp = fileURLToPath(new URL('../console/app/', import.meta.url));

export default defineConfig({
  // This build's output lives inside the app's own public/; copying public/ into it would recurse.
  publicDir: false,
  resolve: {
    alias: [
      {
        find: /^#src\/(engines\/postgres|engines\/mysql|adapters\/redis|adapters\/sqs)\.ts$/,
        replacement: `${consoleApp}unavailable.ts`,
      },
      // Bare driver packages src/index.ts dynamic-imports directly; unstubbed, ioredis ships
      // as an unreachable chunk.
      {
        find: /^(ioredis|@aws-sdk\/client-sqs)$/,
        replacement: `${consoleApp}unavailable.ts`,
      },
      { find: /^node:crypto$/, replacement: `${consoleApp}no-node-crypto.ts` },
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${consoleApp}$1` },
    ],
  },
  build: {
    outDir: 'public/runner',
    emptyOutDir: true,
    rollupOptions: {
      input: { loader: 'runner/loader.ts' },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
});
