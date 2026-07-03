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

// The documentation content index, built once at compile time. import.meta.glob({ eager: true })
// walks app/content/ and imports every .mdx up front, so this module resolves to a fully-loaded,
// validated collection with no runtime fetch. Each entry carries its compiled MDX `Component` — a
// function, which cannot survive a loader's JSON serialization — so route components import this
// module directly rather than receiving it from a loader.
import { z } from 'zod';

import type { ComponentType } from 'react';

/**
 * The frontmatter every documentation page declares. Parsing doubles as validation: a missing or
 * malformed field throws here and fails the build, rather than shipping a page with a blank title.
 * `status` is a display badge ('draft'/'planned' render a marker); `draft` is the publish gate
 * (drafts are dropped outside dev). They are deliberately distinct — a page can be visibly
 * in-progress yet still published so its slug keeps resolving for inbound @see links.
 */
export const docSchema = z.object({
  title: z.string(),
  summary: z.string(),
  order: z.number().default(0),
  status: z.enum(['stable', 'draft', 'planned']).default('stable'),
  // Source files/symbols in economy-lab this page documents; rendered as a "Source" block so every
  // claim is one click from the code that backs it.
  sourceRefs: z.array(z.string()).default([]),
  // Slugs of related pages, rendered as "See also".
  related: z.array(z.string()).default([]),
  // An optional plain-language "what this is", written for a complete newcomer (the ten-year-old
  // test). Rendered as a normal paragraph below the summary and above the on-page Contents. Most
  // pages omit it; it earns its place only where a newcomer is likely to land first.
  plain: z.string().optional(),
  // Page citations: an ordered list of notes, rendered in a small "Notes" section at the foot of the
  // page and numbered by position. A mark links down to one — `<Cite n={1}/>` anywhere in body prose,
  // or `plainCite` for the plain paragraph. Used wherever a claim rests on outside authority (a
  // general principle, a cited source) rather than on something economy-lab itself proves.
  notes: z.array(z.object({ text: z.string(), href: z.string().optional() })).default([]),
  // The 1-based index into `notes` of the citation that applies to the plain paragraph, rendered as a
  // small "[n]" after it. Omitted when the plain paragraph needs no citation.
  plainCite: z.number().int().positive().optional(),
  draft: z.boolean().default(false),
});

// The compiled MDX default export accepts an optional `components` map (how custom components like
// <Callout> are injected at render — see DocPage). Typed loosely because MDX merges whatever it's given.
type MdxComponent = ComponentType<{ components?: Record<string, unknown> }>;
/**
 * One heading in a page's table of contents, as exported by rehype-extract-toc
 * (depth 2 = `##`, 3 = `###`).
 */
export type TocEntry = {
  value: string;
  depth: number;
  id?: string;
  children?: TocEntry[];
};
// `tableOfContents` is injected as a named export of each MDX module by rehype-extract-toc/mdx.
type MdxModule = {
  default: MdxComponent;
  frontmatter: Record<string, unknown>;
  tableOfContents?: TocEntry[];
};

const modules = import.meta.glob<MdxModule>('./content/**/*.mdx', {
  eager: true,
});

const DEV = import.meta.env.DEV;

// The slug is the path under app/content/ minus the .mdx extension, so the URL is pinned to the file
// on disk and the two can never drift. The whole site is section-rooted under economy/:
// e.g. './content/economy/reference/operations/spend.mdx' -> the slug
// 'economy/reference/operations/spend', served at /economy/reference/operations/spend/.
const slugOf = (path: string) => path.replace(/^\.\/content\//, '').replace(/\.mdx$/, '');

// The sub-section a page belongs to, below the economy/ root: 'concepts' | 'reference' | 'ports',
// or '' for a page that sits directly under economy/ (scope-and-non-goals).
const sectionOf = (slug: string) => {
  const rel = slug.startsWith('economy/') ? slug.slice('economy/'.length) : slug;
  return rel.includes('/') ? (rel.split('/')[0] ?? '') : '';
};

/**
 * A documentation page after validation: the schema's fields plus the slug, its sub-section, and
 * the compiled MDX component.
 */
export type DocPage = z.infer<typeof docSchema> & {
  slug: string;
  // Sub-section below economy/ ('concepts' | 'reference' | 'ports'), or '' for a root-level page.
  section: string;
  // The page's `##`/`###` heading tree, for the on-page table of contents (empty when none).
  toc: TocEntry[];
  Component: MdxComponent;
};

/**
 * Every page, validated, drafts dropped outside dev, ordered by the author-supplied `order` with the
 * title breaking ties so the sidebar and prev/next sequence are stable across builds. Computed once
 * at module load, so route components read a ready-made list.
 */
export const docs: DocPage[] = Object.entries(modules)
  .map(([path, mod]) => {
    const slug = slugOf(path);
    return {
      ...docSchema.parse(mod.frontmatter),
      slug,
      section: sectionOf(slug),
      toc: mod.tableOfContents ?? [],
      Component: mod.default,
    };
  })
  .filter((d) => DEV || !d.draft)
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

/**
 * Find the one page whose slug matches, or `undefined` when nothing does — the caller decides
 * whether a miss means a not-found view.
 */
export const docBySlug = (slug: string) => docs.find((d) => d.slug === slug);
/** Every page in a top-level section ('concepts' | 'reference' | 'ports'), in sidebar order. */
export const docsInSection = (section: string) => docs.filter((d) => d.section === section);
