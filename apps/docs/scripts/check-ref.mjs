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

// Deploy gate: chips link GitHub at the pinned REPO_REF (app/repo.ts) while anchors.test.ts
// verifies the working tree, so both hold only when every referenced file is byte-identical in
// the two. This checks exactly that. When it fails the ref is stale: commit, re-pin, re-anchor.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const CONTENT = join(import.meta.dirname, '../app/content');

const repoTs = readFileSync(join(import.meta.dirname, '../app/repo.ts'), 'utf8');
const ref = repoTs.match(/REPO_REF = '([0-9a-f]{40})'/)?.[1];
if (!ref) {
  console.error('check-ref: no REPO_REF commit SHA found in app/repo.ts');
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  git('cat-file', '-e', `${ref}^{commit}`);
} catch {
  console.error(`check-ref: REPO_REF ${ref} is not a commit in this clone.`);
  process.exit(1);
}

// The same reference shapes app/anchors.test.ts collects: sourceRefs chips and SourceLink targets.
const paths = new Set();
for (const file of readdirSync(CONTENT, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.mdx')) continue;
  const text = readFileSync(join(CONTENT, file), 'utf8');
  const raws = [
    ...text.matchAll(/'((?:src|test|scripts|db)\/[^']+)'/g),
    ...text.matchAll(/<SourceLink to="([^"]+)"/g),
  ].flatMap((m) => (m[1] ? [m[1]] : []));
  for (const raw of raws) {
    const path = raw.split(/[#·]/)[0]?.trim();
    if (path) paths.add(path);
  }
}

const stale = [];
for (const path of [...paths].sort()) {
  let pinned = null;
  try {
    pinned = git('rev-parse', `${ref}:${path}`);
  } catch {
    // absent at the pinned ref: definitely stale
  }
  const local = git('hash-object', path);
  if (pinned !== local) stale.push(path);
}

if (stale.length > 0) {
  console.error(
    `check-ref failed — ${stale.length} of ${paths.size} chip-referenced files differ between REPO_REF ${ref.slice(0, 7)} and the working tree:`,
  );
  for (const path of stale) console.error(`  ${path}`);
  console.error(
    '\nCommit the tree, re-pin REPO_REF in app/repo.ts, and re-anchor (app/anchors.test.ts) before deploying.',
  );
  process.exit(1);
}

console.log(
  `check-ref passed — ${paths.size} chip-referenced files match REPO_REF ${ref.slice(0, 7)}.`,
);
