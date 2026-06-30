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

import { getAllDocSlugs } from './app/content.fs.ts';

import type { Config } from '@react-router/dev/config';

/**
 * React Router framework configuration.
 *
 * Loaded as plain Node before the app bundle, so imports here must be relative with an explicit
 * extension and must not touch Vite's import.meta.glob — hence content.fs.ts, the bare-Node reader
 * that walks app/content/ off disk to enumerate every page's slug.
 */
export default {
  // Static site: ssr:true + prerender writes flat HTML to build/client/, which is the whole
  // deployable. ssr:true (not ssr:false/SPA) is what lets content pages omit <Scripts/> and ship
  // zero client JavaScript.
  ssr: true,
  // Enumerate every URL up front; a path not listed here is never rendered. getStaticPaths covers
  // the param-free routes (indexes, scope, sitemap, robots); the doc slugs expand the dynamic
  // section routes (concepts/:slug, reference/operations/:slug, …). Deduped because the root-level
  // scope-and-non-goals page is both a static route and a content file.
  async prerender({ getStaticPaths }) {
    const paths = [
      ...getStaticPaths(),
      ...getAllDocSlugs().map((s) => `/${s}`),
    ];
    return [...new Set(paths)];
  },
} satisfies Config;
