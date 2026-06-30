/**
 * @pwngh/economy-lab-docs
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { fileURLToPath } from 'node:url';
import mdx from '@mdx-js/rollup';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig } from 'vitest/config';

/**
 * Test config, kept separate from vite.config.ts so the React Router plugin's full app context is not
 * loaded. A minimal MDX transform (frontmatter only — no Shiki/gfm) lets app modules import .mdx the
 * same way they do at runtime.
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  plugins: [
    {
      enforce: 'pre',
      ...mdx({ remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter] }),
    },
  ],
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts'],
  },
});
