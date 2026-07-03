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

import { getDocBodies } from '~/content.fs.ts';
import { docs } from '~/content.ts';
import { SECTION_LABEL } from '~/nav.ts';

/**
 * Resource-route loader emitting the client search index as JSON, prerendered to a static file. Built
 * from the same content collection the pages render from, so it can never list a page that does not
 * exist. The client `search.js` fetches this once on first use. Each entry carries the page's full
 * body as pre-stripped plain text (read off disk by content.fs.ts, since the compiled MDX modules
 * hold components, not source): matched against, never displayed, so a query can hit terms that
 * appear only in the body.
 */
export function loader() {
  const bodies = getDocBodies();
  const index = docs.map((d) => ({
    slug: d.slug,
    title: d.title,
    summary: d.summary,
    section: d.slug.startsWith('economy/reference/operations/')
      ? 'Operations'
      : (SECTION_LABEL[d.section] ?? 'Economy'),
    body: bodies.get(d.slug) ?? '',
  }));

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
