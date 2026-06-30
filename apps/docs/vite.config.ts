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
import mdx from '@mdx-js/rollup';
import { reactRouter } from '@react-router/dev/vite';
import rehypeShiki from '@shikijs/rehype';
import rehypeExtractToc from '@stefanprobst/rehype-extract-toc';
import rehypeExtractTocExport from '@stefanprobst/rehype-extract-toc/mdx';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeExternalLinks from 'rehype-external-links';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig } from 'vite';

/**
 * Vite build config. Turns .mdx into React Router routes and highlights every code block at BUILD
 * time (Shiki, dual theme) so the shipped HTML carries colorized code and no client JS runs to do it.
 */
export default defineConfig({
  resolve: {
    // '~' -> ./app, an absolute path Vite needs (import.meta.url is a file:// URL).
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  plugins: [
    {
      // enforce:'pre' runs MDX->JSX before the React Router transform, which only understands JSX.
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
        rehypePlugins: [
          // slug must run before autolink (the link needs an id to point at).
          rehypeSlug,
          // Extract the heading tree and export it as `tableOfContents` from each MDX module, for the
          // build-time on-page table of contents (begriffs-style). Runs after slug (needs ids) and
          // before autolink (reads plain heading text).
          rehypeExtractToc,
          rehypeExtractTocExport,
          [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          // Authored external links open in a new tab and are marked so the CSS adds the ↗ icon.
          [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
          // Two themes baked in; CSS keyed on [data-theme] reveals the right one at zero runtime cost.
          [rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' } }],
        ],
      }),
    },
    reactRouter(),
  ],
});
