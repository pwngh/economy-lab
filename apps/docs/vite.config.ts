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
import remarkSmartypants from 'remark-smartypants';
import { defineConfig } from 'vite';

// The slice of the HTML AST (hast) this file walks. Declared locally so the one transform below needs
// no @types/hast dependency.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const BRAND = 'economy-lab';

/**
 * Wraps every standalone "economy-lab" in body prose with `<span class="brand">`, skipping text
 * inside `code`/`pre`. Frontmatter text (summary, plain, notes) is branded separately by DocPage's
 * `brandize`.
 */
function rehypeBrand() {
  const span = (): HastNode => ({
    type: 'element',
    tagName: 'span',
    properties: { className: ['brand'] },
    children: [{ type: 'text', value: BRAND }],
  });
  const walk = (node: HastNode) => {
    const kids = node.children;
    if (!kids) return;
    const inCode = node.tagName === 'code' || node.tagName === 'pre';
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.type === 'text' && !inCode && child.value?.includes(BRAND)) {
        const replacement: HastNode[] = [];
        child.value.split(BRAND).forEach((part, p) => {
          if (p > 0) replacement.push(span());
          if (part) replacement.push({ type: 'text', value: part });
        });
        kids.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      } else {
        walk(child);
      }
    }
  };
  return (tree: unknown) => walk(tree as HastNode);
}

/**
 * Turns .mdx into React Router routes and highlights every code block at build time (Shiki, dual
 * theme) so the pages ship no client JS to do it.
 */
export default defineConfig({
  resolve: {
    // '~' -> ./app, an absolute path Vite needs (import.meta.url is a file:// URL).
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  // One-origin dev: the docs own :4173 and proxy /console to the console app's own dev server
  // (scripts/dev-site.mjs starts both), so cross-links and the journal handoff behave in dev
  // exactly as on the composed site.
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/console': { target: 'http://localhost:4174', ws: true },
    },
  },
  plugins: [
    {
      // enforce:'pre' runs MDX before the React Router transform.
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [
          remarkFrontmatter,
          remarkMdxFrontmatter,
          remarkGfm,
          // Straight quotes and '...' in body text become curly quotes and ellipses at build time;
          // code spans and fences are untouched.
          remarkSmartypants,
        ],
        rehypePlugins: [
          // slug must run before autolink (the link needs an id to point at).
          rehypeSlug,
          // Extracts the heading tree as each module's `tableOfContents` export. Runs after slug
          // (needs ids), before autolink (reads plain heading text).
          rehypeExtractToc,
          rehypeExtractTocExport,
          [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          // Authored external links open in a new tab and are marked so the CSS adds the ↗ icon.
          [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
          // Brands the project name in body prose; after toc/slug/autolink so headings stay clean,
          // before Shiki so code blocks are skipped.
          rehypeBrand,
          // Two themes baked in; CSS keyed on [data-theme] reveals the right one.
          [rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' } }],
        ],
      }),
    },
    reactRouter(),
  ],
});
