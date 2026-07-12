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

/**
 * The edge dist-freshness guard. This repo consumes @pwngh/economy-edge's
 * compiled `dist/` through a file: link, so an edited edge source with a
 * forgotten `npm run build` would silently serve stale semantics — the same
 * drift class the money package kills with its channels test. This fails the
 * suite whenever any edge source file is newer than its newest build output.
 * It applies only to the sibling-checkout link (a published tarball ships no
 * `src/`); the absence case skips explicitly, never silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function newestMtime(directory: string, extensions: readonly string[]): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

test('the edge dist this repo consumes is at least as new as the edge source', (t) => {
  const require = createRequire(import.meta.url);
  let packageJson: string;
  try {
    packageJson = require.resolve('@pwngh/economy-edge/package.json');
  } catch {
    return t.skip('@pwngh/economy-edge is not installed (optional peer)');
  }
  const root = dirname(realpathSync(packageJson));
  const src = join(root, 'src');
  const dist = join(root, 'dist');
  if (!existsSync(src)) {
    return t.skip('published edge package ships no src/; nothing to compare');
  }
  assert.ok(
    existsSync(dist),
    'edge has src/ but no dist/ — run `npm run build` in economy-edge',
  );
  const sourceNewest = newestMtime(src, ['.ts']);
  const builtNewest = newestMtime(dist, ['.js', '.d.ts']);
  assert.ok(
    builtNewest >= sourceNewest,
    'economy-edge src/ is newer than its dist/ — run `npm run build` in economy-edge, ' +
      'or this repo keeps testing stale compiled semantics',
  );
});
