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

import { accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mdx from '@mdx-js/rollup';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig } from 'vitest/config';

/**
 * Test config, kept separate from vite.config.ts so the React Router plugin is not loaded; a minimal
 * frontmatter-only MDX transform lets modules import .mdx the same way they do at runtime.
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  plugins: [
    {
      // `?shiki` imports, stubbed: tests read frontmatter, not highlighted HTML, but a missing
      // snippet file must still fail here rather than at the docs build.
      name: 'shiki-source-stub',
      enforce: 'pre' as const,
      async resolveId(source: string, importer: string | undefined) {
        if (!source.includes('?shiki')) return undefined;
        const resolved = await this.resolve(source.split('?')[0], importer, { skipSelf: true });
        return resolved ? `${resolved.id}?shiki` : undefined;
      },
      load(id: string) {
        if (!id.includes('?shiki')) return undefined;
        accessSync(id.split('?')[0]);
        return "export default '';";
      },
    },
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
