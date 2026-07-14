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

import { defineConfig } from 'vitest/config';

// Test config, kept separate from vite.config.ts so the React Router plugin is not loaded. The
// aliases mirror vite.config.ts (the why lives there).
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const appDir = fileURLToPath(new URL('./app/', import.meta.url));

export default defineConfig({
  resolve: {
    // One React only: without dedupe the testing-library path can load a second copy.
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${appDir}$1` },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // Keep react-router and testing-library in the vite pipeline so they share the test files'
    // React instance; loaded natively they bind a second copy and hooks explode.
    server: { deps: { inline: [/react-router/, /@testing-library/] } },
  },
});
