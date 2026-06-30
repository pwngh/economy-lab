/**
 * @pwngh/economy-lab-docs
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { SITE } from '~/seo.ts';

/** Resource-route loader serving robots.txt — allow everything, point crawlers at the sitemap. */
export function loader() {
  const body = `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
