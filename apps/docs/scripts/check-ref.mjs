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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectChips } from '../app/anchors.ts';

const REPO_ROOT = join(import.meta.dirname, '../../..');

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

// The chip roster comes from app/anchors.ts, which the gate also uses, so the two cannot disagree
// about which files the docs link into. Its own scan missed every `packages/…` chip and every
// double-quoted one, and a file this gate does not list is one whose links can rot unnoticed.
const chips = collectChips();
const paths = new Set(chips.chips.map((chip) => chip.path));

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
