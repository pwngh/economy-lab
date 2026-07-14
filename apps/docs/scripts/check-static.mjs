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

// Hydration drift guard, run after `build` beside check-csp. Pages hydrate only by opting into
// handle.hydrate (root.tsx), and none do today; this walks the built HTML and fails if a page
// outside the allowlist references a bundled module chunk — so a stray <Scripts/> or import can
// never silently turn a flat page interactive.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BUILD_DIR = 'build/client';

// Routes permitted to ship hydration chunks, in pathname form ('/concepts/idempotency').
// Additions are deliberate, one route at a time, each carrying its interactive feature.
const HYDRATED = new Set();

// Hand-written vanilla enhancers a page may carry. search.js ships on every page; the runner
// loader is allowed only on a page that renders a runnable block (data-snippet), so no page can
// grow a runner tag unnoticed. Anything else — above all the /assets/ chunk graph — counts as
// hydration.
const ALLOWED_SRC = new Set(['/search.js']);
const RUNNER_SRC = '/runner/loader.js';

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function routeOf(file) {
  const rel = relative(BUILD_DIR, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  return `/${rel.replace(/\/index\.html$/, '').replace(/\.html$/, '')}`;
}

// Anything that pulls a JS asset at load: external scripts and modulepreload links.
function scriptRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    if (!/rel=["']?modulepreload/.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/);
    if (href) refs.push(href[1]);
  }
  return refs;
}

const pages = walk(BUILD_DIR);
const offenders = [];
for (const file of pages) {
  const route = routeOf(file);
  if (HYDRATED.has(route)) continue;
  const html = readFileSync(file, 'utf8');
  const runnable = html.includes('data-snippet');
  const refs = scriptRefs(html).filter(
    (r) => !ALLOWED_SRC.has(r) && !(r === RUNNER_SRC && runnable),
  );
  if (refs.length > 0) offenders.push({ route, refs });
}

if (offenders.length > 0) {
  for (const o of offenders) console.error(`${o.route}: ships ${o.refs.join(', ')}`);
  console.error('flat pages must reference zero hydration chunks; hydration is allowlist-only.');
  process.exit(1);
}
// Runner ratchet, same policy as the console's bundle budget: the loader stays trivial, and the
// engine graph (loaded only on the first Run click) may only shrink between deliberate
// re-baselines. Measured 1,785 / 143,149.
const LOADER_BUDGET = 4_000;
const RUNNER_BUDGET = 150_000;
const runnerDir = join(BUILD_DIR, 'runner');
const loaderBytes = statSync(join(runnerDir, 'loader.js')).size;
const runnerBytes = readdirSync(runnerDir)
  .filter((f) => f.endsWith('.js'))
  .reduce((sum, f) => sum + statSync(join(runnerDir, f)).size, 0);
if (loaderBytes > LOADER_BUDGET || runnerBytes > RUNNER_BUDGET) {
  console.error(
    `runner over budget: loader ${loaderBytes}/${LOADER_BUDGET}, total ${runnerBytes}/${RUNNER_BUDGET}.`,
  );
  process.exit(1);
}

console.log(
  `static check: ${pages.length} pages flat, ${HYDRATED.size} allowlisted; runner ${runnerBytes} bytes (budget ${RUNNER_BUDGET}).`,
);
