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

// The slice of the HTML AST (hast) this file walks. Declared locally so no @types/hast dependency is
// needed for the one small transform below.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const BRAND = 'economy-lab';

/**
 * A rehype transform that wraps every standalone "economy-lab" in body text with
 * `<span class="brand">`, so the project name is subtly set off wherever it's referenced — no
 * per-page markup. Text inside `code`/`pre` is left untouched, and it runs before Shiki so highlighted
 * blocks are never rewritten. Frontmatter-rendered text (summary, plain, notes) is branded separately
 * by DocPage's `brandize`.
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
 * Vite build config. Turns .mdx into React Router routes and highlights every code block at build
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
          // Brand the project name in body prose. After toc/slug/autolink so headings stay clean, and
          // before Shiki so code blocks are skipped (their text is still inside code/pre here).
          rehypeBrand,
          // Two themes baked in; CSS keyed on [data-theme] reveals the right one at zero runtime cost.
          [rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' } }],
        ],
      }),
    },
    reactRouter(),
  ],
});
