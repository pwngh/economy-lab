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

// `dist-site/` is the artifact that gets deployed, and until this step nothing in the table read
// it. `docs:csp` and `docs:static` read `apps/docs/build`; the composed site is a different
// artifact — a different root, a second app under /console/, the generated reference under /api/,
// and an `_headers` file the composer appends a generated rule to. It was checked by two inline
// steps in `pages.yml`, which is a workflow nobody runs on a push, and by nothing else.
//
// So this step composes the deployable and answers for it, and it is a row in the table like
// every other gate. Composing here rather than only reading what someone else composed is what
// makes it reachable from `ci.yml`: the acceptance tier has already built both apps by the time
// this runs, so the compose costs a second rather than the minute the three builds cost.
//
// The other half of the same defect: the composer takes whatever app builds are on disk. It said
// nothing while rebuilding the deployable out of an older `apps/*/build`, which is the emit
// problem `scripts/check-dist-fresh.ts` already solves one directory over. So the inputs are
// dated against their own sources before anything is composed.
//
// What this does not cover, stated here rather than only in a report: the generated reference
// under /api/ is dated by the `fresh:docs` step, not here, and nothing in this step opens a page
// in a browser. It answers "the deployable was composed from current builds and its CSP governs
// every script it ships", and that is all it answers.
//
//   node scripts/check/site.ts

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const OUT = 'dist-site';

/** How long the composer and the CSP gate each get. Neither opens a socket; both walk a tree. */
const SPAWN_TIMEOUT_MS = 180_000;

/** One composed input: where its build lands, what it is built from, and what rebuilds it. */
interface Input {
  readonly name: string;
  /** The marker `site/src/compose.mjs` itself requires, so both refuse on the same file. */
  readonly marker: string;
  readonly built: string;
  /**
   * The paths a build reads, named rather than swept. A sweep of the app directory dates the
   * bundle against its own test files and its own tooling, which is a red gate on an edit that
   * cannot change a byte of the build — and a gate people learn to ignore proves nothing at all.
   *
   * The limit that names itself: a build input outside these paths is not dated here. Every path
   * must exist, so a renamed one is red rather than quietly unread.
   */
  readonly sources: readonly string[];
  readonly command: string;
}

const INPUTS: readonly Input[] = [
  {
    name: 'docs',
    marker: 'apps/docs/build/client/index.html',
    built: 'apps/docs/build/client',
    sources: [
      'apps/docs/app',
      'apps/docs/public',
      'apps/docs/runner',
      'apps/docs/react-router.config.ts',
      'apps/docs/vite.config.ts',
      'apps/docs/vite.runner.config.ts',
      'apps/docs/package.json',
    ],
    command: 'npm run build --prefix apps/docs',
  },
  {
    name: 'console',
    marker: 'apps/console/build/client/index.html',
    built: 'apps/console/build/client',
    sources: [
      'apps/console/app',
      'apps/console/public',
      'apps/console/react-router.config.ts',
      'apps/console/vite.config.ts',
      'apps/console/package.json',
    ],
    command: 'npm run build --prefix apps/console',
  },
  {
    name: 'api reference',
    marker: 'docs/index.html',
    built: 'docs',
    // Dated by the `fresh:docs` step against the lab's own sources, which is where the typedoc
    // config is read. Repeating that walk here would be a second reading of one rule.
    sources: [],
    command: 'npm run docs:api',
  },
];

/** The newest mtime under a path, and how many files that was read from. */
function newest(paths: readonly string[]): [number, number] {
  let at = 0;
  let seen = 0;
  const walk = (path: string): void => {
    const full = join(ROOT, path);
    if (!existsSync(full)) {
      refuse(`${path} is named as a build input and is not on disk`);
    }
    if (!statSync(full).isDirectory()) {
      seen += 1;
      at = Math.max(at, statSync(full).mtimeMs);
      return;
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      walk(`${path}/${entry.name}`);
    }
  };
  for (const path of paths) walk(path);
  return [at, seen];
}

/** Says what is wrong and ends the run. Thrown rather than exited so one catch prints it. */
function refuse(why: string): never {
  throw new Error(why);
}

function ran(argv: readonly string[], cwd: string): string {
  const [command, ...args] = argv;
  const run = spawnSync(command!, args, {
    cwd: join(ROOT, cwd),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT_MS,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.error !== undefined || run.status === null) {
    refuse(`${argv.join(' ')} never completed within ${SPAWN_TIMEOUT_MS}ms`);
  }
  if (run.status !== 0) {
    console.error(output.slice(-4000));
    refuse(`${argv.join(' ')} exited ${run.status}`);
  }
  return output;
}

function main(): void {
  // Each input on disk, and current. A missing one is the precondition scripts/check.ts reports as
  // a skip, so reaching this file at all means they are there.
  let dated = 0;
  for (const input of INPUTS) {
    if (!existsSync(join(ROOT, input.marker))) {
      refuse(`${input.name} is not built (${input.marker}) — ${input.command}`);
    }
    if (input.sources.length === 0) continue;
    const [source, sourceCount] = newest(input.sources);
    const [output, outputCount] = newest([input.built]);
    if (sourceCount === 0 || outputCount === 0) {
      refuse(
        `${input.name}: read ${sourceCount} sources and ${outputCount} outputs, so nothing was compared`,
      );
    }
    if (source > output) {
      refuse(
        `${input.name} build is ${Math.round((source - output) / 1000)}s behind its sources — ${input.command}`,
      );
    }
    dated += 1;
  }
  if (dated !== 2) {
    refuse(`dated ${dated} of the composed inputs, and two carry sources here`);
  }

  // The one definition of composing, spawned rather than reimplemented: `npm run site` runs this
  // same file after building all three inputs.
  const composed = ran(['node', 'site/src/compose.mjs'], '.');

  // GitHub Pages runs an artifact without this through Jekyll, which drops every
  // underscore-prefixed file — including the _headers the CSP gate below reads.
  if (!existsSync(join(ROOT, OUT, '.nojekyll'))) {
    refuse(
      `${OUT}/.nojekyll is missing, so Pages would drop _headers and _redirects`,
    );
  }

  // The console shell ships its own inline scripts and the docs' `/*` rule would block them, so
  // the composer appends a /console/* rule hashed from the built shell. A rule with no hashes is
  // that generation having produced nothing, which the page-by-page check below still passes.
  const headers = readFileSync(join(ROOT, OUT, '_headers'), 'utf8');
  const consoleRule = headers.slice(headers.indexOf('\n/console/*\n'));
  const hashes = [...consoleRule.matchAll(/'sha256-[^']+'/g)].length;
  if (!headers.includes('\n/console/*\n') || hashes === 0) {
    refuse(`${OUT}/_headers carries no /console/* script-src hashes`);
  }

  // Against the composed artifact, which is not the build `docs:csp` reads: this is the one that
  // ships, and its _headers has a rule in it that exists nowhere else.
  ran(
    ['npm', 'run', 'check:csp', '--prefix', 'apps/docs', '--', `../../${OUT}`],
    '.',
  );

  const pages = readdirSync(join(ROOT, OUT), { recursive: true }).filter(
    (entry) => String(entry).endsWith('.html'),
  ).length;

  process.stdout.write(
    `site: composed ${OUT}/ from ${INPUTS.length} inputs (${dated} dated), ${pages} pages, ${hashes} console script hashes, CSP ok\n`,
  );
  process.stdout.write(`${composed.trim().split('\n').slice(-1)[0]}\n`);
}

try {
  main();
} catch (failed) {
  console.error(
    `site: ${failed instanceof Error ? failed.message : String(failed)}`,
  );
  process.exitCode = 1;
}
