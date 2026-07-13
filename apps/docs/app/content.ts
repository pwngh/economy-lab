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

// The content index, built once at compile time. import.meta.glob eagerly imports every .mdx, so
// this module resolves fully loaded. Each entry carries its compiled MDX `Component` — a function,
// which cannot survive a loader's JSON serialization — so route components import this module
// directly.
import { z } from 'zod';

import type { ComponentType } from 'react';

/**
 * The frontmatter every page declares. Parsing doubles as validation, so a malformed field fails
 * the build. `status` is the display badge, `draft` the publish gate — distinct so an in-progress
 * page can stay published and its slug keeps resolving for inbound @see links.
 */
export const docSchema = z.object({
  title: z.string(),
  summary: z.string(),
  order: z.number().default(0),
  status: z.enum(['stable', 'draft', 'planned']).default('stable'),
  // Source files/symbols this page documents, rendered as the "Source" chips.
  sourceRefs: z.array(z.string()).default([]),
  // Slugs of related pages, rendered as "See also".
  related: z.array(z.string()).default([]),
  // An optional plain-language "what this is" for a complete newcomer (the ten-year-old test),
  // rendered below the summary.
  plain: z.string().optional(),
  // Page citations, rendered numbered in a "Notes" section at the foot. `<Cite n={1}/>` in body
  // prose or `plainCite` for the plain paragraph links down to one.
  notes: z.array(z.object({ text: z.string(), href: z.string().optional() })).default([]),
  // The 1-based index into `notes` of the plain paragraph's citation.
  plainCite: z.number().int().positive().optional(),
  draft: z.boolean().default(false),
});

// The compiled MDX export takes an optional `components` map (see DocPage); typed loosely because
// MDX merges whatever it's given.
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

// The slug is the path under app/content/ minus .mdx, so the URL is pinned to the file on disk.
const slugOf = (path: string) => path.replace(/^\.\/content\//, '').replace(/\.mdx$/, '');

// The sub-section below economy/ ('concepts' | 'reference' | 'ports'), or '' for a root-level page.
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
 * Every page, validated, drafts dropped outside dev, ordered by `order` with the title as tiebreaker.
 * Computed once at module load.
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

export const docBySlug = (slug: string) => docs.find((d) => d.slug === slug);
/** Every page in a top-level section ('concepts' | 'reference' | 'ports'), in sidebar order. */
export const docsInSection = (section: string) => docs.filter((d) => d.section === section);
