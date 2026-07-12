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

// The config-time content reader: bare Node only, because react-router.config.ts runs before the
// bundler exists. It enumerates slugs to prerender; the runtime index is app/content.ts.

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import matter from 'gray-matter';

const CONTENT_DIR = join(process.cwd(), 'app/content');
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
 * Every page slug — the prerender list. Drops drafts outside dev; slugs use forward slashes
 * regardless of platform, since they become URL segments.
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

/**
 * Reduces one page's MDX body to lowercase plain text for the search index: tags, JSX, link targets,
 * and markdown punctuation go; prose and code text stay, so a search can hit a name that only appears
 * in a code block.
 */
function plainText(body: string): string {
  return body
    .replace(/```[^\n]*/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|{}']/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Every page's body as searchable plain text, keyed by slug; joined onto the collection at prerender,
 * so none of it reaches a client bundle.
 */
export function getDocBodies(): Map<string, string> {
  return new Map(
    walk(CONTENT_DIR).map((file) => [
      relative(CONTENT_DIR, file)
        .replace(/\.mdx$/, '')
        .split(sep)
        .join('/'),
      plainText(matter(readFileSync(file, 'utf8')).content),
    ]),
  );
}
