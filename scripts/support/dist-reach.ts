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

// Which root test files read this repository through an emit rather than through its source.
//
// `#src/*` resolves to `./src/*` and is the source itself, so a mutation there is visible to the
// test that imports it. A published specifier — the lab's own name, or a workspace member's —
// resolves through an exports map into `dist`, which is last build's copy of that source. A test
// that reaches one of those cannot witness a source change until the build has run, and a green
// run under an unbuilt mutation is evidence of nothing.
//
// The reach is usually indirect, which is why reading a test file's own import list does not
// answer it: `test/engines/leg-wire.test.ts` imports `#src/money.ts` and looks like a source
// test, and gets its stores from `#test/support/adapters.ts`, which imports the engine packages.
// So the whole static graph is walked, and the chain that found the door is what gets reported.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { readRootPackage, readWorkspace } from './workspace-graph.ts';

/** One test file, the published door it reaches, and the files between. */
export interface DistReach {
  /** Root-relative, because that is how a reader finds the file. */
  readonly file: string;
  readonly specifier: string;
  /** Root-relative, in order, excluding the test file itself. */
  readonly via: readonly string[];
}

/** Every package name in this repository whose emit a build here writes. */
export function distDoors(root: string): string[] {
  return [readRootPackage(root).name, ...readWorkspace(root).keys()].sort();
}

const isDoor = (specifier: string, doors: readonly string[]): boolean =>
  doors.some((door) => specifier === door || specifier.startsWith(`${door}/`));

/**
 * A specifier and where it was written. `import type` and `export type` are erased under
 * `verbatimModuleSyntax`, so they load nothing and are left out.
 */
interface Cite {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const FROM = /from\s*'([^']+)'/g;
const BARE = /(?:^|[\n;])\s*import\s*'([^']+)'/g;
const DYNAMIC = /import\(\s*'([^']+)'\s*\)/g;

/**
 * Whether the statement containing this offset is a type-only import or export.
 *
 * The lookback exists because a multi-line `import type { … }` puts its `from` several lines
 * below the keyword. It has to stop at the end of that statement, though: a specifier written
 * inside a template literal — the scaffolded module `test/acceptance/rigs.test.ts` writes and
 * then boots — is not part of the import above it, and reading one as the other dropped a
 * published door this repository does load.
 */
function erased(text: string, at: number): boolean {
  const start = Math.max(
    text.lastIndexOf('\nimport', at),
    text.lastIndexOf('\nexport', at),
  );
  if (start === -1) return false;
  const statement = text.slice(start + 1, at);
  if (/[;`]/.test(statement)) return false;
  return /^\s*(?:import|export)\s+type\b/.test(statement);
}

function cites(text: string): Cite[] {
  const found: Cite[] = [];
  for (const [, specifier] of text.matchAll(BARE)) {
    found.push({ specifier: specifier!, typeOnly: false });
  }
  for (const [, specifier] of text.matchAll(DYNAMIC)) {
    found.push({ specifier: specifier!, typeOnly: false });
  }
  for (const match of text.matchAll(FROM)) {
    found.push({
      specifier: match[1]!,
      typeOnly: erased(text, match.index),
    });
  }
  return found;
}

/**
 * Where a specifier lands inside this repository, or null when it lands outside it. The prefixes
 * come from the root manifest's own `imports` map, so a new subpath needs no edit here.
 */
function localFile(
  root: string,
  imports: Readonly<Record<string, string>>,
  from: string,
  specifier: string,
): string | null {
  let path: string | null = null;
  if (specifier.startsWith('.')) {
    path = resolve(dirname(from), specifier);
  } else {
    for (const [pattern, target] of Object.entries(imports)) {
      const prefix = pattern.replace(/\*$/, '');
      if (!pattern.endsWith('*') || !specifier.startsWith(prefix)) continue;
      path = join(
        root,
        target.replace(/\*$/, ''),
        specifier.slice(prefix.length),
      );
      break;
    }
  }
  if (path === null) return null;
  for (const candidate of [path, `${path}.ts`, join(path, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The scope every package this repository publishes is named under. */
const HOUSE = '@pwngh/';

/**
 * Every published specifier one source file loads, deduplicated and sorted.
 *
 * The one rule, for every reader of this question in the tree. It was stated three times before
 * `Q366`: two of the copies matched `from '…'` alone and so were blind to `await import('…')`,
 * which loads an emit exactly as hard as a static import does, and to `import '…'` for effect.
 * They also counted `import type`, which loads nothing at all under `verbatimModuleSyntax`.
 */
export function publishedSpecifiers(text: string): string[] {
  const found = new Set<string>();
  for (const cite of cites(text)) {
    if (cite.typeOnly || !cite.specifier.startsWith(HOUSE)) continue;
    found.add(cite.specifier);
  }
  return [...found].sort();
}

/**
 * The shortest chain from each given file to a published door, for the files that reach one.
 * A file that reaches none is left out, which is what makes it a source test.
 */
export function reachesDist(
  root: string,
  files: readonly string[],
): DistReach[] {
  const doors = distDoors(root);
  const imports = (
    readRootPackage(root).json as { imports?: Record<string, string> }
  ).imports;
  if (imports === undefined || Object.keys(imports).length === 0) {
    throw new Error(
      'dist-reach: the root manifest declares no imports map, so no local specifier can be resolved',
    );
  }
  const text = new Map<string, string>();
  const read = (path: string): string => {
    const cached = text.get(path);
    if (cached !== undefined) return cached;
    const source = readFileSync(path, 'utf8');
    text.set(path, source);
    return source;
  };

  const found: DistReach[] = [];
  for (const entry of files) {
    const start = resolve(root, entry);
    if (!existsSync(start)) continue;
    // Breadth first, so the chain reported is the shortest one that reaches the door.
    const queue: Array<{ path: string; via: string[] }> = [
      { path: start, via: [] },
    ];
    const seen = new Set([start]);
    let hit: DistReach | null = null;
    while (queue.length > 0 && hit === null) {
      const { path, via } = queue.shift()!;
      for (const cite of cites(read(path))) {
        if (cite.typeOnly) continue;
        if (isDoor(cite.specifier, doors)) {
          hit = {
            file: relative(root, start),
            specifier: cite.specifier,
            via: [...via],
          };
          break;
        }
        const next = localFile(root, imports, path, cite.specifier);
        if (next === null || seen.has(next)) continue;
        seen.add(next);
        queue.push({ path: next, via: [...via, relative(root, next)] });
      }
    }
    if (hit !== null) found.push(hit);
  }
  return found;
}

/** One line a reader can follow from the test file to the emit it actually loads. */
export const describeReach = (reach: DistReach): string =>
  [reach.file, ...reach.via, reach.specifier].join(' -> ');
