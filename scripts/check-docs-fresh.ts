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

// Dates the generated TypeDoc reference against the source it documents, and refuses when it is
// behind. The sibling of check-dist-fresh.ts, for the other emit a suite in this repository runs
// against: `apps/docs` loads no `dist` at all — its snippet config aliases the lab onto `src/` —
// but every <ApiLink> it carries resolves into `docs/`, so a reference generated before the last
// source edit certifies the previous build under this build's name.
//
//   node scripts/check-docs-fresh.ts
//   node scripts/check-docs-fresh.ts apps/docs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** What `typedoc.json` declares, read rather than restated so the two cannot drift. */
interface TypedocConfig {
  readonly entryPoints?: readonly string[];
  readonly out?: string;
  readonly readme?: string;
}

export interface Dated {
  /** Root-relative, because that is how a reader finds the file. */
  readonly path: string;
  readonly mtimeMs: number;
}

export interface DocsFreshness {
  readonly entryPoints: readonly string[];
  /** The trees TypeDoc reads, derived from where the entry points sit. */
  readonly sourceRoots: readonly string[];
  readonly sourceCount: number;
  readonly out: string;
  readonly pageCount: number;
  readonly modulePages: number;
  readonly newestSource: Dated | null;
  readonly oldestPage: Dated | null;
}

const isSource = (path: string): boolean =>
  /\.(m?ts|tsx)$/.test(path) && !path.endsWith('.d.ts');

function walk(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

/**
 * The directories that hold the entry points, with any nested inside another dropped. TypeDoc
 * follows imports out of each entry point, so this over-covers: a source the closure never
 * reaches still dates the output. That direction is the safe one — it asks for a regenerate that
 * changes nothing, where the other direction reports a reference built from source that has moved.
 */
function sourceRootsOf(entryPoints: readonly string[]): string[] {
  const dirs = [...new Set(entryPoints.map((entry) => dirname(entry)))];
  return dirs
    .filter((dir) => !dirs.some((other) => dir.startsWith(`${other}/`)))
    .sort();
}

function readConfig(root: string): TypedocConfig {
  const path = join(root, 'typedoc.json');
  if (!existsSync(path)) {
    throw new Error(
      `docs-freshness: there is no typedoc.json at ${path}, so what the reference is built from cannot be read`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TypedocConfig;
  } catch (cause) {
    throw new Error('docs-freshness: typedoc.json is not readable JSON', {
      cause,
    });
  }
}

/**
 * The generated reference, dated against the source it was generated from. Measurement only —
 * {@link assertDocsFresh} is what refuses.
 */
export function checkDocs(root: string): DocsFreshness {
  const config = readConfig(root);
  const entryPoints = config.entryPoints ?? [];
  const out = config.out ?? '';
  const sourceRoots = sourceRootsOf(entryPoints);

  // typedoc.json picks the entry points and readme picks the landing page: both change the output
  // without any source under the roots changing.
  const inputs = [
    join(root, 'typedoc.json'),
    ...(config.readme === undefined ? [] : [join(root, config.readme)]),
    ...sourceRoots.flatMap((dir) => walk(join(root, dir)).filter(isSource)),
  ].filter((path) => existsSync(path));

  const pages = walk(join(root, out)).filter((path) => path.endsWith('.html'));
  const modules = walk(join(root, out, 'modules')).filter((path) =>
    path.endsWith('.html'),
  );

  const dated = (paths: readonly string[]): Dated[] =>
    paths.map((path) => ({
      path: relative(root, path),
      mtimeMs: statSync(path).mtimeMs,
    }));
  const byTime = (a: Dated, b: Dated): number => a.mtimeMs - b.mtimeMs;

  return {
    entryPoints,
    sourceRoots,
    sourceCount: inputs.length,
    out,
    pageCount: pages.length,
    modulePages: modules.length,
    newestSource: dated(inputs).sort(byTime).at(-1) ?? null,
    oldestPage: dated(pages).sort(byTime).at(0) ?? null,
  };
}

const FIX = 'npm run docs:api';

/**
 * Refuses when the generated reference is behind the source it documents, and equally when the
 * check itself examined nothing. A suite that resolves into `docs/` proves nothing about a symbol
 * that moved after it was generated — it certifies the previous build under this build's name —
 * so the refusal happens before the suite starts rather than inside it.
 *
 * Three things are asserted, not one: that every declared entry point has a module page, that
 * sources and pages were both counted, and that no page predates a source. The first two are what
 * stop a renamed output directory or a dropped entry point turning this into a check that passes
 * having read nothing. It never regenerates: an emit rebuilt on its owner's behalf hides from them
 * that it was stale.
 */
export function assertDocsFresh(root: string, label: string): DocsFreshness {
  const report = checkDocs(root);
  const blind: string[] = [];
  if (report.entryPoints.length === 0) {
    blind.push('  typedoc.json declares no entry points');
  }
  if (report.sourceCount === 0) {
    blind.push(
      `  nothing to document under ${report.sourceRoots.join(', ') || '(no source roots)'}`,
    );
  }
  if (report.pageCount === 0) {
    blind.push(
      `  no generated pages under ${report.out || '(no out directory)'}`,
    );
  } else if (report.modulePages !== report.entryPoints.length) {
    blind.push(
      `  ${report.entryPoints.length} entry points declared, but ${report.out}/modules holds ${report.modulePages}`,
    );
  }
  if (blind.length > 0) {
    throw new Error(
      `docs-freshness: ${label} cannot be dated against its source.\n${blind.join('\n')}\n    fix: ${FIX}\nA check that reads no files reports the same success as a fresh build.`,
    );
  }

  const { newestSource, oldestPage } = report;
  if (
    newestSource !== null &&
    oldestPage !== null &&
    newestSource.mtimeMs > oldestPage.mtimeMs
  ) {
    const lag = Math.round((newestSource.mtimeMs - oldestPage.mtimeMs) / 1000);
    throw new Error(
      `docs-freshness: ${label} would run against a reference that is behind its source — ${report.pageCount} pages under ${report.out}, generated from ${report.sourceCount} sources.\n  ${oldestPage.path} is ${lag}s older than ${newestSource.path}\n    fix: ${FIX}`,
    );
  }
  return report;
}

const HERE = fileURLToPath(new URL('..', import.meta.url));

function main(where: string | undefined): number {
  const label = where === undefined ? 'this repository' : where;
  let report: DocsFreshness;
  try {
    report = assertDocsFresh(HERE, label);
  } catch (refusal) {
    console.error((refusal as Error).message);
    return 1;
  }
  process.stdout.write(
    `docs-freshness: ${report.pageCount} generated pages under ${report.out}, one module page for each of ${report.entryPoints.length} entry points, all at least as new as the ${report.sourceCount} sources they document\n`,
  );
  return 0;
}

// Only a direct invocation dates anything; the reader above is importable on its own.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , target] = process.argv;
  process.exitCode = main(
    target === undefined ? undefined : relative(HERE, resolve(target)),
  );
}
