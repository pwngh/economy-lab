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

// Collects every internal navigation href in the content tree and resolves it
// against what the site actually serves: page slugs walked from the mdx files,
// static paths parsed from the live route tables, generated /api files on
// disk, and in-page anchors derived the way rehype-slug derives them. External
// links are deliberately out of scope — a gate that hits the network is a
// flake — and the `#Lnn` source chips and <ApiLink>s have their own gates.
// Bare Node only, so a test or script can drive it without the bundler.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import matter from 'gray-matter';

export const CONTENT_DIR = fileURLToPath(new URL('./content', import.meta.url));
export const DOCS_ROUTES = fileURLToPath(new URL('./routes.ts', import.meta.url));
export const CONSOLE_APP = fileURLToPath(new URL('../../console/app', import.meta.url));
export const CONSOLE_ROUTES = join(CONSOLE_APP, 'routes.ts');
export const API_OUT = fileURLToPath(new URL('../../../docs', import.meta.url));

export type LinkKind = 'page' | 'api' | 'console' | 'self-anchor' | 'external' | 'unknown';

export type ContentLink = {
  /** Content-relative mdx path, forward slashes. */
  page: string;
  /** 1-based line number of the destination in the file. */
  line: number;
  href: string;
  kind: LinkKind;
};

export type Inventory = {
  /** Content-relative mdx paths walked, sorted. */
  pages: string[];
  /** Every `](…)` destination in the raw text, code included. */
  rawMatches: number;
  /** Destinations inside fenced or inline code — markdown shown, not navigation. */
  inCode: number;
  /** http(s) destinations, excluded from resolution. */
  external: ContentLink[];
  /** The examined set: everything else. */
  internal: ContentLink[];
};

function walkMdx(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => f.split('\\').join('/'))
    .sort();
}

const DESTINATION = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function kindOf(href: string): LinkKind {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return 'external';
  if (href.startsWith('#')) return 'self-anchor';
  if (href === '/api' || href.startsWith('/api/')) return 'api';
  if (href === '/console' || href.startsWith('/console/')) return 'console';
  if (href.startsWith('/')) return 'page';
  return 'unknown';
}

/**
 * Walks the content tree and categorizes every markdown destination, tracking
 * the raw total so a parsing bug cannot silently shrink the examined set.
 */
export function collectContentLinks(contentDir = CONTENT_DIR): Inventory {
  const pages = walkMdx(contentDir);
  const inventory: Inventory = { pages, rawMatches: 0, inCode: 0, external: [], internal: [] };
  for (const page of pages) {
    const lines = readFileSync(join(contentDir, page), 'utf8').split('\n');
    let inFence = false;
    lines.forEach((text, i) => {
      const raw = [...text.matchAll(DESTINATION)];
      inventory.rawMatches += raw.length;
      if (/^\s*```/.test(text)) {
        inFence = !inFence;
        inventory.inCode += raw.length;
        return;
      }
      if (inFence) {
        inventory.inCode += raw.length;
        return;
      }
      const prose = text.replace(/`[^`\n]*`/g, '``');
      inventory.inCode += raw.length - [...prose.matchAll(DESTINATION)].length;
      for (const m of prose.matchAll(DESTINATION)) {
        const href = m[1] ?? '';
        const link: ContentLink = { page, line: i + 1, href, kind: kindOf(href) };
        (link.kind === 'external' ? inventory.external : inventory.internal).push(link);
      }
    });
  }
  return inventory;
}

/**
 * Static paths from a route table, parsed from the file itself so the roster
 * cannot drift from what ships. Dynamic (`:param`) and wildcard segments are
 * dropped — their valid instances come from the slug roster. `parsed` versus
 * `declared` lets a caller assert the parse saw every declaration.
 */
export function staticRoutePaths(routesFile: string): {
  paths: Set<string>;
  parsed: number;
  declared: number;
} {
  const text = readFileSync(routesFile, 'utf8');
  const declared =
    [...text.matchAll(/\broute\(\s*'/g)].length + [...text.matchAll(/\bindex\(\s*'/g)].length;
  const paths = new Set<string>();
  let parsed = 0;
  for (const m of text.matchAll(/\broute\(\s*'([^']+)'/g)) {
    parsed += 1;
    const path = m[1] ?? '';
    if (path.includes(':') || path.includes('*')) continue;
    paths.add(`/${path}`);
  }
  for (const _ of text.matchAll(/\bindex\(\s*'/g)) {
    parsed += 1;
    paths.add('/');
  }
  return { paths, parsed, declared };
}

/**
 * Page slugs the production prerender serves: every non-draft mdx file. A
 * `draft: true` page leaves the prerender, so a published page linking it
 * dangles in production even though the file exists.
 */
export function publishedSlugs(contentDir = CONTENT_DIR): Set<string> {
  const slugs = new Set<string>();
  for (const page of walkMdx(contentDir)) {
    const { data } = matter(readFileSync(join(contentDir, page), 'utf8'));
    if (data.draft === true) continue;
    slugs.add(page.replace(/\.mdx$/, ''));
  }
  return slugs;
}

/**
 * The anchors a page can serve: heading ids the way rehype-slug mints them
 * (github-slugger over the heading text, one slugger per page so repeats get
 * `-1` suffixes), plus any literal `id="…"` the body provides itself.
 */
export function anchorsOf(mdxFile: string): Set<string> {
  const text = readFileSync(mdxFile, 'utf8');
  const anchors = new Set<string>();
  const slugger = new GithubSlugger();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) anchors.add(slugger.slug(heading[1] ?? ''));
  }
  for (const m of text.matchAll(/id="([^"]+)"/g)) anchors.add(m[1] ?? '');
  return anchors;
}

/** `id="…"` attributes across an app source tree, for anchors into console pages. */
export function appAnchorIds(appDir = CONSOLE_APP): Set<string> {
  const ids = new Set<string>();
  const files = readdirSync(appDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
    /\.(tsx|ts|css|html)$/.test(f),
  );
  for (const f of files) {
    for (const m of readFileSync(join(appDir, f), 'utf8').matchAll(/id="([^"]+)"/g)) {
      ids.add(m[1] ?? '');
    }
  }
  return ids;
}

export type ResolutionContext = {
  slugs: Set<string>;
  docsRoutes: Set<string>;
  consoleRoutes: Set<string>;
  consoleIds: Set<string>;
  contentDir: string;
  apiOut: string;
  /** Injectable for tests; defaults to disk. */
  fileExists: (path: string) => boolean;
};

export function defaultContext(): ResolutionContext {
  return {
    slugs: publishedSlugs(),
    docsRoutes: staticRoutePaths(DOCS_ROUTES).paths,
    consoleRoutes: staticRoutePaths(CONSOLE_ROUTES).paths,
    consoleIds: appAnchorIds(),
    contentDir: CONTENT_DIR,
    apiOut: API_OUT,
    fileExists: (path: string) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function splitHref(href: string): { path: string; fragment: string | null } {
  const noQuery = href.split('?')[0] ?? '';
  const hash = noQuery.indexOf('#');
  if (hash === -1) return { path: noQuery, fragment: null };
  return { path: noQuery.slice(0, hash), fragment: noQuery.slice(hash + 1) };
}

function resolvePage(link: ContentLink, ctx: ResolutionContext): string | null {
  const { path, fragment } = splitHref(link.href);
  const bare = path.replace(/\/$/, '') || '/';
  const slug = bare.replace(/^\//, '');
  const isSlug = ctx.slugs.has(slug);
  if (!isSlug && !ctx.docsRoutes.has(bare)) {
    return `no page at ${path} — not a published slug, not a static route`;
  }
  if (fragment === null) return null;
  if (!isSlug) return `#${fragment} into ${path}, which has no mdx body to hold an anchor`;
  const anchors = anchorsOf(join(ctx.contentDir, `${slug}.mdx`));
  return anchors.has(fragment) ? null : `no anchor #${fragment} on ${path}`;
}

function resolveApi(link: ContentLink, ctx: ResolutionContext): string | null {
  const { path, fragment } = splitHref(link.href);
  const rel = path.replace(/^\/api\/?/, '');
  const file =
    rel === '' || rel.endsWith('/') ? join(ctx.apiOut, rel, 'index.html') : join(ctx.apiOut, rel);
  if (!ctx.fileExists(file)) return `no generated page under docs/ for ${path}`;
  if (fragment === null) return null;
  const html = readFileSync(file, 'utf8');
  return html.includes(`id="${fragment}"`) ? null : `no anchor #${fragment} in ${path}`;
}

function resolveConsole(link: ContentLink, ctx: ResolutionContext): string | null {
  const { path, fragment } = splitHref(link.href);
  const bare = path.replace(/^\/console/, '').replace(/\/$/, '') || '/';
  if (!ctx.consoleRoutes.has(bare)) {
    return `no console route at ${path} (the console deploys at /console/ on the same site)`;
  }
  if (fragment === null) return null;
  return ctx.consoleIds.has(fragment)
    ? null
    : `no id="${fragment}" anywhere in the console app for ${path}`;
}

function resolveSelfAnchor(link: ContentLink, ctx: ResolutionContext): string | null {
  const fragment = link.href.slice(1);
  const anchors = anchorsOf(join(ctx.contentDir, link.page));
  return anchors.has(fragment) ? null : `no anchor #${fragment} on this page`;
}

/**
 * Resolves one internal link; `null` means it lands. The `unknown` kind —
 * a relative or otherwise unclassifiable destination — always fails, so a
 * new link form widens the gate instead of slipping past it.
 */
export function resolveLink(link: ContentLink, ctx: ResolutionContext): string | null {
  switch (link.kind) {
    case 'page':
      return resolvePage(link, ctx);
    case 'api':
      return resolveApi(link, ctx);
    case 'console':
      return resolveConsole(link, ctx);
    case 'self-anchor':
      return resolveSelfAnchor(link, ctx);
    case 'external':
      return 'external links are not resolved here';
    default:
      return `unresolvable destination form: ${link.href}`;
  }
}
