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
 * Loaded as plain Node before the app bundle, so imports must be relative with explicit extensions
 * and cannot touch import.meta.glob — content.fs.ts is the bare-Node reader that enumerates slugs.
 */
export default {
  // ssr:true plus prerender writes flat HTML to build/client/ — the whole deployable — and lets
  // content pages omit <Scripts/>.
  ssr: true,
  // Enumerate every URL up front; a path not listed is never rendered. Deduped because
  // scope-and-non-goals is both a static route and a content file.
  // '/404' renders the splat route; copy-404.mjs publishes it as the platform 404.html.
  async prerender({ getStaticPaths }) {
    const paths = [...getStaticPaths(), ...getAllDocSlugs().map((s) => `/${s}`), '/404'];
    return [...new Set(paths)];
  },
} satisfies Config;
