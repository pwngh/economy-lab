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
// The shared browser-shim package (driver stubs + node:crypto rejection), aliased instead of
// reaching into the console app's private dir.
const engineBrowser = fileURLToPath(new URL('../../packages/engine-browser/', import.meta.url));

// One license header per generated chunk instead of the per-module copies the bundler would
// otherwise inline dozens of times. legalComments:'none' strips them all; a post-order renderChunk
// (after minification and vite's own injections) puts exactly one back at the very top.
const BANNER = '/* @pwngh/economy-lab. Copyright (c) Preston Neal. MIT (see LICENSE.md). */\n';
const licenseBanner = {
  name: 'license-banner',
  renderChunk: {
    order: 'post' as const,
    handler(code: string) {
      return { code: BANNER + code, map: null };
    },
  },
};

export default defineConfig({
  // This build's output lives inside the app's own public/; copying public/ into it would recurse.
  publicDir: false,
  esbuild: { legalComments: 'none' },
  plugins: [licenseBanner],
  resolve: {
    alias: [
      {
        find: /^#src\/(engines\/postgres|engines\/mysql|adapters\/redis|adapters\/sqs)\.ts$/,
        replacement: `${engineBrowser}unavailable.ts`,
      },
      // Bare driver packages src/index.ts dynamic-imports directly; unstubbed, ioredis ships
      // as an unreachable chunk.
      {
        find: /^(ioredis|@aws-sdk\/client-sqs)$/,
        replacement: `${engineBrowser}unavailable.ts`,
      },
      { find: /^node:crypto$/, replacement: `${engineBrowser}no-node-crypto.ts` },
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
