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

import { readFileSync } from 'node:fs';
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
import { codeToHtml } from 'shiki';
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

interface FenceMeta {
  filename?: string;
  lines: Set<number>;
  nocopy: boolean;
  nonumber: boolean;
}

/**
 * The fence meta grammar: `filename=` labels a block and numbers its lines (`nonumber` opts out),
 * `lines=[2,5-7]` highlights, and `nocopy` marks deliberately wrong code. scripts/check-samples.mjs
 * reads the same grammar and treats `nocopy` as its skip flag — change the two together.
 */
function parseFenceMeta(raw: string): FenceMeta {
  const lines = new Set<number>();
  const spans = raw.match(/\blines=\[([^\]]*)\]/)?.[1] ?? '';
  for (const span of spans.split(',')) {
    if (!span.trim()) continue;
    const [from, to] = span.split('-').map((edge) => Number(edge.trim()));
    for (let line = from; line <= (to ?? from); line++) lines.add(line);
  }
  return {
    filename: raw.match(/\bfilename=(\S+)/)?.[1],
    lines,
    nocopy: /\bnocopy\b/.test(raw),
    nonumber: /\bnonumber\b/.test(raw),
  };
}

// The per-run transformer context Shiki provides: `meta` is scratch state for one code block,
// `options.meta.__raw` is the fence's info string after the language.
interface FenceCtx {
  meta: { fence?: FenceMeta };
  options: { meta?: { __raw?: string } };
}

const fenceMeta = {
  name: 'fence-meta',
  preprocess(this: FenceCtx) {
    this.meta.fence = parseFenceMeta(this.options.meta?.__raw ?? '');
  },
  line(this: FenceCtx, node: HastNode, line: number) {
    if (!this.meta.fence?.lines.has(line)) return;
    node.properties ??= {};
    const props = node.properties;
    props.class = [props.class, 'line-hl'].filter(Boolean).join(' ');
  },
  pre(this: FenceCtx, node: HastNode) {
    const fence = this.meta.fence;
    if (!fence) return;
    node.properties ??= {};
    const props = node.properties;
    if (fence.filename) {
      props['data-filename'] = fence.filename;
      if (!fence.nonumber) props['data-numbered'] = '';
    }
    if (fence.nocopy) props['data-nocopy'] = '';
  },
};

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
 * `?shiki` imports: the file, highlighted at build time with the same dual themes the fences get,
 * as an HTML string default export. The Runnable blocks render it, so live code reads like every
 * other block on the page; the editor still recovers the plain source from the rendered text, so
 * what you see, copy, and edit stay one artifact. Import lines get `line-dim` — real and
 * copyable, but visually behind the code that teaches.
 */
interface ResolveCtx {
  resolve(
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean },
  ): Promise<{ id: string } | null>;
}
interface WatchCtx {
  addWatchFile?(id: string): void;
}

function shikiSource() {
  return {
    name: 'shiki-source',
    enforce: 'pre' as const,
    // Resolve the file part ourselves and keep the query: some environments (vitest's
    // resolver) would otherwise strip it and load the file as an ordinary module.
    async resolveId(this: ResolveCtx, source: string, importer: string | undefined) {
      if (!source.includes('?shiki')) return undefined;
      const resolved = await this.resolve(source.split('?')[0], importer, { skipSelf: true });
      return resolved ? `${resolved.id}?shiki` : undefined;
    },
    // includes(), not endsWith(): dev and test pipelines append their own query params.
    async load(this: WatchCtx, id: string) {
      if (!id.includes('?shiki')) return undefined;
      const file = id.split('?')[0];
      this.addWatchFile?.(file); // dev: editing the snippet re-highlights it
      const source = readFileSync(file, 'utf8').trim();
      const importLines = new Set(
        source.split('\n').flatMap((line, i) => (/^import[ {]/.test(line) ? [i + 1] : [])),
      );
      const html = await codeToHtml(source, {
        lang: file.endsWith('.sh') ? 'shellscript' : 'typescript',
        themes: { light: 'github-light', dark: 'github-dark' },
        transformers: [
          {
            line(node: HastNode, line: number) {
              if (!importLines.has(line)) return;
              node.properties ??= {};
              const props = node.properties;
              props.class = [props.class, 'line-dim'].filter(Boolean).join(' ');
            },
          },
        ],
      });
      return `export default ${JSON.stringify(html)};`;
    },
  };
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
    shikiSource(),
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
          [
            rehypeShiki,
            {
              themes: { light: 'github-light', dark: 'github-dark' },
              transformers: [fenceMeta],
            },
          ],
        ],
      }),
    },
    reactRouter(),
  ],
});
