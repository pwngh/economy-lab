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

// CSP drift guard, run in CI after `build`. Every inline <script> we ship is allow-listed in the CSP
// by its SHA-256 hash (no 'unsafe-inline' for scripts). This walks the built HTML, re-derives each
// inline script's hash, and fails if any is missing from the governing _headers rule — so a changed
// theme script can never silently ship blocked by its own CSP.
//
// With no argument it checks this app's build against public/_headers. Given the composed site
// directory (`node scripts/check-csp.mjs ../../dist-site`) it checks the whole artifact against
// dist-site/_headers, each page matched to its rule: /console/* against the generated console
// rule, everything else against `/*`.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SITE_DIR = process.argv[2];
const BUILD_DIR = SITE_DIR ?? 'build/client';
const HEADERS_FILE = SITE_DIR ? join(SITE_DIR, '_headers') : 'public/_headers';

// The sha256-... tokens of each rule's script-src, keyed by the rule's path pattern.
function hashRules(headersText) {
  const rules = new Map();
  let pattern = null;
  for (const line of headersText.split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('#')) {
      pattern = line.trim();
      continue;
    }
    if (pattern && line.includes('Content-Security-Policy:')) {
      const scriptSrc = (line.split('script-src')[1] ?? '').split(';')[0];
      rules.set(pattern, new Set([...scriptSrc.matchAll(/'sha256-[^']+'/g)].map((m) => m[0])));
    }
  }
  return rules;
}

const rules = hashRules(readFileSync(HEADERS_FILE, 'utf8'));
const rootAllowed = rules.get('/*') ?? new Set();
const consoleAllowed = rules.get('/console/*') ?? rootAllowed;

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
  const underConsole = relative(BUILD_DIR, file).split(sep)[0] === 'console';
  const allowed = underConsole ? consoleAllowed : rootAllowed;
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
  console.error(`CSP check failed — inline script hashes missing from ${HEADERS_FILE} script-src:`);
  for (const [hash, file] of missing) console.error(`  ${hash}  (first seen in ${file})`);
  console.error(
    '\nDocs pages: add them to public/_headers. Console pages: re-run scripts/compose-site.mjs.',
  );
  process.exit(1);
}

console.log(
  `CSP check passed — every inline script hash is allow-listed (${rootAllowed.size} docs, ${consoleAllowed.size} console).`,
);
