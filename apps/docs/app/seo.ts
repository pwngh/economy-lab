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

import type { MetaDescriptor } from 'react-router';

/**
 * The canonical origin — scheme and host, no trailing slash. This is the DOCS_BASE_URL the
 * economy-lab source links to via `@see {DOCS_BASE_URL}/<slug>`; every absolute URL the site
 * advertises is built by prefixing it. Provisional until the real domain is wired; change it here
 * and the canonical links, sitemap, and robots all follow.
 */
export const SITE = 'https://economy-lab-docs.pages.dev';
/** Human-readable brand name, emitted as og:site_name and reused in title suffixes. */
const SITE_NAME = 'economy-lab docs';

/** The arguments {@link pageMeta} needs. `path` is the route's absolute path from the site root (e.g. "/economy/concepts/integrity/"); it is concatenated onto {@link SITE} to form the page's one true URL. */
export interface PageMetaOptions {
  title: string;
  description?: string;
  path: string;
  ogType?: 'website' | 'article';
}

/**
 * Build the `<head>` descriptors for one route in one place — title, canonical link, and Open
 * Graph/Twitter tags — so every page describes itself the same way. React Router writes these into
 * the prerendered HTML, so a crawler that runs no JavaScript still sees them.
 */
export function pageMeta({
  title,
  description,
  path,
  ogType = 'website',
}: PageMetaOptions): MetaDescriptor[] {
  const url = `${SITE}${path}`;
  const tags: MetaDescriptor[] = [
    { title },
    { tagName: 'link', rel: 'canonical', href: url },
    { property: 'og:title', content: title },
    { property: 'og:type', content: ogType },
    { property: 'og:url', content: url },
    { property: 'og:site_name', content: SITE_NAME },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: title },
  ];
  if (description) {
    tags.push(
      { name: 'description', content: description },
      { property: 'og:description', content: description },
      { name: 'twitter:description', content: description },
    );
  }
  return tags;
}
