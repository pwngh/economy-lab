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

// The site's information architecture, derived from the content collection. The sidebar tree, the
// breadcrumb trail, and the prev/next sequence all read from here, so there is one ordering to keep
// in step with the pages themselves. Everything is section-rooted under economy/ (mirroring
// creators.vrchat.com), so slugs and hrefs all begin /economy/.
import { docs, docsInSection } from '~/content.ts';

export type NavLeaf = { slug: string; title: string };
export type NavGroup = {
  title: string;
  href: string;
  items: NavLeaf[];
  subgroups?: { title: string; href: string; items: NavLeaf[] }[];
};

const leaf = (d: { slug: string; title: string }): NavLeaf => ({
  slug: d.slug,
  title: d.title,
});

const isOperation = (slug: string) =>
  slug.startsWith('economy/reference/operations/');

/** Human label for a sub-section, used in breadcrumbs and section landing pages. */
export const SECTION_LABEL: Record<string, string> = {
  concepts: 'Concepts',
  reference: 'Reference',
  ports: 'Ports & edges',
};

/**
 * The single ordered nav definition. The sidebar renders it directly and prev/next falls out of its
 * flattened reading order (see flatSequence), so the two literally cannot disagree — there is one
 * list, not a parallel ordering rule. Operations are listed in lifecycle order (top-up → spend →
 * refund → clawback → the payout saga → subscriptions → entitlements → promo → operator corrections),
 * which is just their frontmatter `order`; reorder there and both the sidebar and prev/next follow.
 *
 * Concepts, then Reference (its standalone pages plus an Operations subgroup), then Ports & edges (the
 * ports plus the root-level scope-and-non-goals page).
 */
export function buildNav(): NavGroup[] {
  const operations = docs.filter((d) => isOperation(d.slug)).map(leaf);
  const referencePages = docs
    .filter((d) => d.section === 'reference' && !isOperation(d.slug))
    .map(leaf);
  const ports = docsInSection('ports').map(leaf);
  const scope = docs
    .filter((d) => d.slug === 'economy/scope-and-non-goals')
    .map(leaf);

  return [
    {
      title: 'Concepts',
      href: '/economy/concepts/',
      items: docsInSection('concepts').map(leaf),
    },
    {
      title: 'Reference',
      href: '/economy/reference/',
      items: referencePages,
      subgroups: [
        {
          title: 'Operations',
          href: '/economy/reference/operations/',
          items: operations,
        },
      ],
    },
    {
      title: 'Ports & edges',
      href: '/economy/ports/',
      items: [...ports, ...scope],
    },
  ];
}

/** Every leaf page flattened into the reading order the sidebar presents, for prev/next. */
export function flatSequence(): NavLeaf[] {
  const out: NavLeaf[] = [];
  for (const g of buildNav()) {
    out.push(...g.items);
    for (const sg of g.subgroups ?? []) out.push(...sg.items);
  }
  return out;
}

/** The previous and next page around `slug` in reading order, either possibly undefined at the ends. */
export function prevNext(slug: string): { prev?: NavLeaf; next?: NavLeaf } {
  const seq = flatSequence();
  const i = seq.findIndex((l) => l.slug === slug);
  if (i === -1) return {};
  return { prev: seq[i - 1], next: seq[i + 1] };
}

export type Crumb = { label: string; href: string };

/**
 * The breadcrumb trail of ancestors for a page, e.g. economy/reference/operations/spend ->
 * [Economy, Reference, Operations]. The current page is deliberately not included — the H1 directly
 * below already names it, so every crumb here is an ancestor link.
 */
export function crumbsFor(slug: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Economy', href: '/economy/' }];
  if (slug === 'economy/scope-and-non-goals') return crumbs;

  const rel = slug.startsWith('economy/')
    ? slug.slice('economy/'.length)
    : slug;
  const section = rel.split('/')[0] ?? '';
  if (SECTION_LABEL[section]) {
    crumbs.push({
      label: SECTION_LABEL[section],
      href: `/economy/${section}/`,
    });
  }
  if (isOperation(slug)) {
    crumbs.push({
      label: 'Operations',
      href: '/economy/reference/operations/',
    });
  }
  return crumbs;
}
