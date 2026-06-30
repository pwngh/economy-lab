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

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
// The config-time content reader: bare Node (node:fs + gray-matter) only, no Vite/import.meta.glob,
// because react-router.config.ts runs in plain Node before the bundler exists. Its one job is to
// enumerate the slugs to prerender; the runtime index that loads MDX components is app/content.ts.
import matter from 'gray-matter';

const CONTENT_DIR = join(process.cwd(), 'app/content');
// Drafts are previewable in dev and hidden in a production build; NODE_ENV is the signal.
const includeDrafts = process.env.NODE_ENV !== 'production';

// Recursively collect every .mdx under app/content/. A missing directory yields [] rather than
// throwing, so an empty content tree is not a build error.
function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.mdx')) out.push(full);
  }
  return out;
}

/**
 * Every page slug — the prerender list for the section routes. Reads frontmatter only (gray-matter),
 * derives the slug from the path under app/content/, and drops drafts outside dev. Slugs use forward
 * slashes regardless of platform path separator, since they become URL segments.
 */
export function getAllDocSlugs(): string[] {
  return walk(CONTENT_DIR)
    .filter((file) => includeDrafts || matter(readFileSync(file, 'utf8')).data.draft !== true)
    .map((file) =>
      relative(CONTENT_DIR, file)
        .replace(/\.mdx$/, '')
        .split(sep)
        .join('/'),
    );
}
