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

import { index, route } from '@react-router/dev/routes';

import type { RouteConfig } from '@react-router/dev/routes';

/**
 * The route table — the single source of truth for every URL the docs site answers to. Explicit
 * (not file-convention) so the prerenderer and sitemap read one list. The whole documentation set is
 * section-rooted under /economy/ (mirroring creators.vrchat.com): / is a thin landing, /economy/ is
 * the section hub, and every page nests beneath it. The more specific reference/operations routes
 * are listed before reference/:slug for readability; React Router ranks by specificity regardless.
 * Resource routes (.ts, loader-only) and the splat fallback stay at the site root.
 */
export default [
  index('routes/home.tsx'),

  route('economy', 'routes/economy-index.tsx'),

  route('economy/concepts', 'routes/concepts-index.tsx'),
  route('economy/concepts/:slug', 'routes/concept.tsx'),

  route('economy/reference', 'routes/reference-index.tsx'),
  route('economy/reference/operations', 'routes/operations-index.tsx'),
  route('economy/reference/operations/:slug', 'routes/operation.tsx'),
  route('economy/reference/:slug', 'routes/reference-page.tsx'),

  route('economy/ports', 'routes/ports-index.tsx'),
  route('economy/ports/:slug', 'routes/port.tsx'),

  route('economy/scope-and-non-goals', 'routes/scope.tsx'),

  route('sitemap.xml', 'routes/sitemap.xml.ts'),
  route('robots.txt', 'routes/robots.txt.ts'),
  route('search-index.json', 'routes/search-index.json.ts'),

  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
