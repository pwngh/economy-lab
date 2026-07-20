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
// react-router build ships it as static assets: a tiny loader.js the pages reference, the engine
// chunk it dynamic-imports on the first Run click, the workbench chunk the Edit button loads, and
// sandbox.html — the one eval-permitting document, which executes edited code. The engine is the
// console's own, so this config re-maps the console app's aliases (see apps/console/vite.config.ts).
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const consoleApp = fileURLToPath(new URL('../console/app/', import.meta.url));
const runnerDir = fileURLToPath(new URL('./runner/', import.meta.url));
// The shared browser-shim package (driver stubs + node:crypto rejection), aliased instead of
// reaching into the console app's private dir.
const engineBrowser = fileURLToPath(new URL('../support/engine-browser/', import.meta.url));

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
  // Root is the runner dir so sandbox.html lands at public/runner/sandbox.html; base makes every
  // emitted reference resolve under the /runner/ path the site serves these assets from.
  root: runnerDir,
  base: '/runner/',
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
      // The published names, as the snippets import them; same sources the #src rules resolve.
      { find: /^@pwngh\/economy-lab\/store-kit$/, replacement: `${repoRoot}src/store-kit.ts` },
      { find: /^@pwngh\/economy-lab\/adapters$/, replacement: `${repoRoot}src/adapters/index.ts` },
      { find: /^@pwngh\/economy-lab$/, replacement: `${repoRoot}src/index.ts` },
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${consoleApp}$1` },
    ],
  },
  worker: {
    format: 'es' as const,
    rollupOptions: {
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        // Same stable name the main build gives the transpiler, for the tier budget.
        manualChunks: { sucrase: ['sucrase'] },
      },
    },
  },
  build: {
    outDir: '../public/runner',
    emptyOutDir: true,
    rollupOptions: {
      input: { loader: `${runnerDir}loader.ts`, sandbox: `${runnerDir}sandbox.html` },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        // A stable name for the transpiler chunk, so check-static can budget the edit tier.
        manualChunks: { sucrase: ['sucrase'] },
      },
    },
  },
});
