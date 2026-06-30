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

import { docs } from '~/content.ts';
import { SECTION_LABEL } from '~/nav.ts';

/**
 * Resource-route loader emitting the client search index as JSON, prerendered to a static file. Built
 * from the same content collection the pages render from, so it can never list a page that does not
 * exist. The client `search.js` fetches this once on first use. Today it carries title/summary/slug
 * (full-text isn't useful while bodies are scaffolds); when content lands this can grow to index body
 * text, or be swapped for a build-time full-text indexer.
 */
export function loader() {
  const index = docs.map((d) => ({
    slug: d.slug,
    title: d.title,
    summary: d.summary,
    section: d.slug.startsWith('economy/reference/operations/')
      ? 'Operations'
      : (SECTION_LABEL[d.section] ?? 'Economy'),
  }));

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
