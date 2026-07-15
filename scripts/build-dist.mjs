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

// Builds the publishable dist/. tsc emits `#src/*` specifiers verbatim, which would send
// consumers into the shipped TypeScript sources, so this compiles a copy of the source
// with those specifiers rewritten to relative paths, copies db/ in beside the compiled
// engines, and fails if any package-import or .ts specifier survives in the output.

import {
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const TMP = join(ROOT, '.build-tmp');
const DIST = join(ROOT, 'dist');

rmSync(TMP, { recursive: true, force: true });
rmSync(DIST, { recursive: true, force: true });

// Copy the compile inputs: all of src/, the conformance suite, and the support helpers it
// imports. Extra support files are harmless; tsc emits only the import closure.
for (const dir of ['src', 'test/conformance', 'test/support']) {
  cpSync(join(ROOT, dir), join(TMP, dir), { recursive: true });
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

// `#src/x.ts` from a file in .build-tmp/A/ becomes the relative path to .build-tmp/src/x.ts.
// Same-quote replacement keeps the rewrite inert inside comments and template text.
function rewrite(path) {
  const source = readFileSync(path, 'utf8');
  const out = source.replace(/'#(src|test)\/([^']+)'/g, (_, top, rest) => {
    const target = relative(dirname(path), join(TMP, top, rest));
    return `'${target.startsWith('.') ? target : `./${target}`}'`;
  });
  if (out !== source) writeFileSync(path, out);
}

for (const path of walk(TMP)) {
  if (path.endsWith('.ts')) rewrite(path);
}

execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
  cwd: ROOT,
  stdio: 'inherit',
});

// The engines read ../../db/*-schema.sql relative to their own module URL; from
// dist/src/engines/ that lands on dist/db/.
cpSync(join(ROOT, 'db'), join(DIST, 'db'), { recursive: true });

// tsc rewrites relative .ts specifiers in the .js emit but leaves them as written in
// declaration files; point those at .js too (which declaration resolution maps to .d.ts).
for (const path of walk(DIST)) {
  if (!path.endsWith('.d.ts')) continue;
  const text = readFileSync(path, 'utf8');
  const out = text.replace(/(['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3');
  if (out !== text) writeFileSync(path, out);
}

// --- Verify before calling it a build --------------------------------------------------

const problems = [];
for (const path of walk(DIST)) {
  if (!path.endsWith('.js') && !path.endsWith('.d.ts')) continue;
  const text = readFileSync(path, 'utf8');
  if (/'#(src|test)\//.test(text)) {
    problems.push(`${relative(ROOT, path)}: unrewritten package import`);
  }
  if (/from '[^']+\.ts'|import\('[^']+\.ts'\)/.test(text)) {
    problems.push(`${relative(ROOT, path)}: specifier still ends in .ts`);
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const [subpath, target] of Object.entries(pkg.exports)) {
  for (const file of typeof target === 'string'
    ? [target]
    : Object.values(target)) {
    if (!file.includes('*') && !existsSync(join(ROOT, file))) {
      problems.push(`exports["${subpath}"]: ${file} does not exist`);
    }
  }
}

rmSync(TMP, { recursive: true, force: true });

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  throw new Error(
    `build-dist: verification failed (${problems.length} problems)`,
  );
}
console.log(
  'build-dist: dist/ compiled, db/ copied, specifiers clean, exports resolve.',
);
