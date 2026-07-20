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
import { walk } from './html-walk.mjs';

const SITE_DIR = process.argv[2];
const BUILD_DIR = SITE_DIR ?? 'build/client';
const HEADERS_FILE = SITE_DIR ? join(SITE_DIR, '_headers') : 'public/_headers';

// Each rule's script-src, keyed by the rule's path pattern: the sha256-... tokens plus the raw
// policy line (the eval-confinement check below reads the latter).
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
      rules.set(pattern, {
        hashes: new Set([...scriptSrc.matchAll(/'sha256-[^']+'/g)].map((m) => m[0])),
        csp: line,
      });
    }
  }
  return rules;
}

const rules = hashRules(readFileSync(HEADERS_FILE, 'utf8'));
const rootAllowed = rules.get('/*')?.hashes ?? new Set();
const consoleAllowed = rules.get('/console/*')?.hashes ?? rootAllowed;

// 'unsafe-eval' may exist in exactly one place: the workbench sandbox's own path rules — both
// URL forms, since Pages' clean URLs serve the document at the extensionless path (the .html
// form redirects to it, and headers must decorate the 200, not the 308). Any other grant —
// above all on '/*' — is a policy regression this gate exists to stop.
const SANDBOX_RULES = new Set(['/runner/sandbox', '/runner/sandbox.html']);
for (const [pattern, rule] of rules) {
  if (rule.csp.includes("'unsafe-eval'") && !SANDBOX_RULES.has(pattern)) {
    console.error(
      `CSP check failed — 'unsafe-eval' granted at ${pattern}; only the sandbox rules may carry it.`,
    );
    process.exit(1);
  }
}

// Every inline <script> body's CSP hash. Speculation Rules are declarative JSON, not executable
// JS; the CSP allows them via the 'inline-speculation-rules' source rather than a hash, so they
// are not hash-pinned here.
function inlineHashes(html) {
  const hashes = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    const body = m[2];
    if (/type=["']?speculationrules/.test(attrs)) continue;
    if (!body) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

// The 404 serves under every path a deep link can miss, so its inline scripts must be
// allow-listed by every hash-carrying rule, not just '/*' — a hash missing from one rule would
// break the 404's bounce script only on that rule's routes.
const notFoundHashes = inlineHashes(readFileSync(join(BUILD_DIR, '404.html'), 'utf8'));
for (const [pattern, rule] of rules) {
  for (const hash of notFoundHashes) {
    if (!rule.hashes.has(hash)) {
      console.error(
        `CSP check failed — 404.html's inline hash ${hash} is missing from the ${pattern} rule; the 404 serves under every path, so every rule must carry it.`,
      );
      process.exit(1);
    }
  }
}

const missing = new Map(); // hash -> first file it appeared in
let sandboxSeen = false;
for (const file of walk(BUILD_DIR)) {
  const sitePath = `/${relative(BUILD_DIR, file).split(sep).join('/')}`;
  if (SANDBOX_RULES.has(sitePath)) sandboxSeen = true;
  // An exact path rule (the sandbox document) wins over the two prefix buckets; a built
  // *.html is served extensionless under clean URLs, so both forms are looked up.
  const exact = rules.get(sitePath) ?? rules.get(sitePath.replace(/\.html$/, ''));
  const underConsole = relative(BUILD_DIR, file).split(sep)[0] === 'console';
  const allowed = exact?.hashes ?? (underConsole ? consoleAllowed : rootAllowed);
  for (const hash of inlineHashes(readFileSync(file, 'utf8'))) {
    if (!allowed.has(hash) && !missing.has(hash)) missing.set(hash, file);
  }
}

// The sandbox must never ship without its rules: without the eval grant on the CLEAN-URL form
// (the path Pages actually serves), the workbench's edited runs die in production only.
if (sandboxSeen) {
  for (const form of SANDBOX_RULES) {
    if (!rules.get(form)?.csp.includes("'unsafe-eval'")) {
      console.error(
        `CSP check failed — the build ships the sandbox but ${HEADERS_FILE} has no eval-permitting rule at ${form}.`,
      );
      process.exit(1);
    }
  }
}

// A dedicated worker is governed by the CSP on its own script response, not its creator's — so
// the /runner/* detach rule is what lets the sandbox worker inherit the eval grant. Without it,
// edited runs die in production only (the header-less preview can't catch it).
if (sandboxSeen) {
  const headersText = readFileSync(HEADERS_FILE, 'utf8');
  const runnerDetach = /^\/runner\/\*\n(?:[^\n]*\n)*?\s*! Content-Security-Policy/m.test(
    headersText,
  );
  if (!runnerDetach) {
    console.error(
      `CSP check failed — ${HEADERS_FILE} has no '/runner/*' rule detaching Content-Security-Policy; the sandbox worker's script would carry the site-wide no-eval policy.`,
    );
    process.exit(1);
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
