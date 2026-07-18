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
 * The route table, explicit (not file-convention) so the prerenderer and sitemap read one list.
 * Every page nests under /economy/, with / a thin landing. Listing order is readability only —
 * React Router ranks by specificity regardless.
 */
export default [
  index('routes/home.tsx'),

  route('economy', 'routes/economy-index.tsx'),

  route('economy/concepts', 'routes/concepts-index.tsx'),
  route('economy/concepts/:slug', 'routes/concept.tsx'),

  route('economy/cookbook', 'routes/cookbook-index.tsx'),
  route('economy/cookbook/:slug', 'routes/cookbook-page.tsx'),

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
