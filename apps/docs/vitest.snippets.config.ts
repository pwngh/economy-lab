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

// The snippet runtime harness: the aliases the runner build uses (published names onto source,
// #src onto the repo), minus the browser stubs — node has the real crypto.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const consoleApp = fileURLToPath(new URL('../console/app/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pwngh\/economy-lab\/store-kit$/, replacement: `${repoRoot}src/store-kit.ts` },
      { find: /^@pwngh\/economy-lab$/, replacement: `${repoRoot}src/index.ts` },
      { find: /^#(.*)$/, replacement: `${repoRoot}$1` },
      { find: /^~\/(.*)$/, replacement: `${consoleApp}$1` },
    ],
  },
  test: { include: ['runner/snippets.test.ts', 'runner/http.test.ts'] },
});
