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
import { SITE } from '~/seo.ts';

/**
 * Resource-route loader emitting sitemap.xml. The URL list is built from the same content collection
 * the pages render from, so the sitemap cannot list a route that does not exist nor omit one that
 * does. Hand-assembled as a string (small, fixed shape) for byte-predictable output.
 */
export function loader() {
  const staticPaths = [
    '/',
    '/economy/',
    '/economy/concepts/',
    '/economy/reference/',
    '/economy/reference/operations/',
    '/economy/ports/',
  ];
  const locs = [...staticPaths, ...docs.map((d) => `/${d.slug}/`)];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs.map((l) => `<url><loc>${SITE}${l}</loc></url>`),
    '</urlset>',
  ].join('');

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
