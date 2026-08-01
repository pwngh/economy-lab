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

// Every internal navigation href in the content tree must land somewhere the
// site actually serves: a published page slug, a static route, a generated
// /api file, a console route, or an in-page anchor. External links are
// DELIBERATELY excluded — a gate that hits the network is a flake — and two
// families are covered elsewhere: `#Lnn` source chips by anchors.test.ts,
// <ApiLink>/apiRefs by api-links.test.ts. This is the `[text](/economy/…)`
// navigation layer, which no other gate reads.

import { describe, expect, test } from 'vitest';

import { join } from 'node:path';
import {
  CONSOLE_ROUTES,
  CONTENT_DIR,
  DOCS_ROUTES,
  anchorsOf,
  collectContentLinks,
  defaultContext,
  resolveLink,
  staticRoutePaths,
} from './content-links';

import type { ContentLink } from './content-links';

const inventory = collectContentLinks();
const ctx = defaultContext();

const probe = (href: string, kind: ContentLink['kind'], page = inventory.pages[0] ?? '') =>
  resolveLink({ page, line: 0, href, kind }, ctx);

describe('internal content links resolve against what the site serves', () => {
  test(`the inventory reconciles: ${inventory.pages.length} pages, every \`](…)\` accounted for`, () => {
    expect(inventory.pages.length).toBeGreaterThan(0);
    // Exact reconciliation: a parsing bug cannot silently shrink the examined
    // set without the categories no longer summing to the raw scan.
    expect(inventory.rawMatches).toBe(
      inventory.inCode + inventory.external.length + inventory.internal.length,
    );
    expect(inventory.internal.length).toBeGreaterThan(500);
    // The route parses saw every declaration in both route tables.
    const docs = staticRoutePaths(DOCS_ROUTES);
    const cons = staticRoutePaths(CONSOLE_ROUTES);
    expect(docs.parsed).toBe(docs.declared);
    expect(cons.parsed).toBe(cons.declared);
  });

  test(`external links are deliberately excluded (${inventory.external.length} of them): a gate that hits the network is a flake`, () => {
    // The exclusion takes http(s) only, so nothing internal can leak into it.
    for (const link of inventory.external) {
      expect(link.href, `${link.page}:${link.line} excluded but not external`).toMatch(
        /^https?:\/\//,
      );
    }
  });

  test('the resolver tells a real target from a fake one, on every channel', () => {
    const [firstSlug] = [...ctx.slugs].sort();
    expect(firstSlug, 'no published slugs — the roster collapsed').toBeTruthy();
    expect(probe(`/${firstSlug}/`, 'page')).toBeNull();
    expect(probe('/economy/this-page-does-not-exist/', 'page')).not.toBeNull();

    const anchored = [...anchorsOf(join(CONTENT_DIR, `${firstSlug}.mdx`))][0];
    expect(anchored, `no anchors on ${firstSlug} to probe with`).toBeTruthy();
    expect(probe(`/${firstSlug}/#${anchored}`, 'page')).toBeNull();
    expect(probe(`/${firstSlug}/#no-such-anchor-ever`, 'page')).not.toBeNull();

    expect(probe('/api/', 'api')).toBeNull();
    expect(probe('/api/modules/never-generated.html', 'api')).not.toBeNull();

    expect(probe('/console/', 'console')).toBeNull();
    expect(probe('/console/not-a-route', 'console')).not.toBeNull();
  });

  for (const page of inventory.pages) {
    const links = inventory.internal.filter((l) => l.page === page);
    test(`${page}: its ${links.length} internal links resolve`, () => {
      const failures = links.flatMap((link) => {
        const why = resolveLink(link, ctx);
        return why === null ? [] : [`${page}:${link.line} ${link.href} — ${why}`];
      });
      expect(failures).toEqual([]);
    });
  }
});
