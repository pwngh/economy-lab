/**
 * @pwngh/economy-lab-docs
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// CSP drift guard, run in CI after `build`. Every inline <script> we ship is allow-listed in the CSP
// by its SHA-256 hash (no 'unsafe-inline' for scripts). This walks the built HTML, re-derives each
// inline script's hash, and fails if any is missing from public/_headers — so a changed theme script
// can never silently ship blocked by its own CSP.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BUILD_DIR = 'build/client';
const HEADERS_FILE = 'public/_headers';

// Pull the sha256-... tokens out of the CSP script-src directive in _headers.
const headers = readFileSync(HEADERS_FILE, 'utf8');
const cspLine = headers.split('\n').find((l) => l.includes('Content-Security-Policy:')) ?? '';
const scriptSrc = (cspLine.split('script-src')[1] ?? '').split(';')[0];
const allowed = new Set([...scriptSrc.matchAll(/'sha256-[^']+'/g)].map((m) => m[0]));

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const missing = new Map(); // hash -> first file it appeared in
for (const file of walk(BUILD_DIR)) {
  const html = readFileSync(file, 'utf8');
  // Inline scripts only: a <script> with no src= attribute.
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    const body = m[2];
    // Speculation Rules are declarative JSON, not executable JS; the CSP allows them via the
    // 'inline-speculation-rules' source rather than a hash, so they are not hash-pinned here.
    if (/type=["']?speculationrules/.test(attrs)) continue;
    if (!body) continue;
    const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    if (!allowed.has(hash) && !missing.has(hash)) missing.set(hash, file);
  }
}

if (missing.size > 0) {
  console.error('CSP check failed — inline script hashes missing from public/_headers script-src:');
  for (const [hash, file] of missing) console.error(`  ${hash}  (first seen in ${file})`);
  console.error('\nAdd them to the script-src directive in public/_headers.');
  process.exit(1);
}

console.log(
  `CSP check passed — every inline script hash is allow-listed (${allowed.size} hashes).`,
);
