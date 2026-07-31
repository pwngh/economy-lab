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

/**
 * Reads the lab's public surface the way a consumer's compiler does.
 *
 * `export` in a source file proves nothing about reachability: a symbol is public when the
 * TypeScript checker returns it for the `types` entry of a subpath in the `exports` map. Two
 * exported functions in this tree were unreachable that way for a whole release. So the roster
 * is asked of the checker, never of a grep.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

/** Whether a symbol can be used in an expression, or only in a type position. */
export type SymbolKind = 'value' | 'type';

/** One subpath's exported names, sorted, each mapped to the position it may be used in. */
export type SubpathRoster = Readonly<Record<string, SymbolKind>>;

/** Every module subpath of the `exports` map, mapped to its roster. */
export type Roster = Readonly<Record<string, SubpathRoster>>;

export interface Subpath {
  /** The key as the `exports` map spells it, `.` included. */
  readonly subpath: string;
  /** The declared `types` target, relative to the package root. */
  readonly types: string;
  /** The declared `default` target, relative to the package root. */
  readonly runtime: string;
  /** The source file the two targets are emitted from, relative to the package root. */
  readonly source: string;
}

interface ExportsCondition {
  readonly types?: string;
  readonly default?: string;
}

/**
 * The one target `exports` names that Node reads as metadata rather than resolving as a module,
 * so it carries no roster and is exempt from every check below.
 */
export const NON_MODULE_EXPORT = './package.json';

const readExports = (root: string): Record<string, unknown> => {
  const json = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const map = json.exports;
  if (map === null || typeof map !== 'object') {
    throw new Error('the lab declares no exports map');
  }
  return map as Record<string, unknown>;
};

/** `./dist/src/ports.d.ts` is emitted from `src/ports.ts`. */
const sourceOf = (types: string): string =>
  types.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '.ts');

/**
 * Every subpath a consumer can import, with the source behind it.
 *
 * A condition without a `types` entry throws rather than being skipped: an unresolvable subpath
 * would otherwise drop out of the roster silently, which is the drift this whole gate exists for.
 */
export function moduleSubpaths(root: string): Subpath[] {
  const found: Subpath[] = [];
  for (const [subpath, target] of Object.entries(readExports(root))) {
    if (typeof target === 'string') continue;
    const condition = target as ExportsCondition;
    if (!condition.types || !condition.default) {
      throw new Error(`${subpath} declares no types or default target`);
    }
    found.push({
      subpath,
      types: condition.types,
      runtime: condition.default,
      source: sourceOf(condition.types),
    });
  }
  return found;
}

/** The keys of the `exports` map, in declaration order. */
export function exportKeys(root: string): string[] {
  return Object.keys(readExports(root));
}

interface Opened {
  readonly ts: typeof import('typescript');
  readonly program: import('typescript').Program;
  readonly subpaths: readonly Subpath[];
}

/**
 * One program over every subpath entry, cached per root.
 *
 * Building it costs seconds, and both readers below want the same one.
 */
const opened = new Map<string, Opened>();

/** How a consumer's compiler is configured when it reads this tree, in one place. */
const compilerOptions = (
  ts: typeof import('typescript'),
): import('typescript').CompilerOptions => ({
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  types: [],
});

const loadTypescript = (root: string) =>
  createRequire(join(root, 'package.json'))(
    'typescript',
  ) as typeof import('typescript');

function openProgram(root: string): Opened {
  const cached = opened.get(root);
  if (cached) return cached;

  const ts = loadTypescript(root);
  const subpaths = moduleSubpaths(root);
  const program = ts.createProgram(
    subpaths.map((entry) => join(root, entry.source)),
    compilerOptions(ts),
  );
  const fresh = { ts, program, subpaths };
  opened.set(root, fresh);
  return fresh;
}

/**
 * The names one module exports, as the checker resolves them.
 *
 * The whole-tree readers above answer for the lab's own subpaths. This answers for a single
 * entry file anywhere in the repository, which is what a check on a workspace package's surface
 * needs — a migration target has to be asked the same question the lab is asked.
 */
export function exportedNames(root: string, entry: string): string[] {
  const ts = loadTypescript(root);
  const program = ts.createProgram([entry], compilerOptions(ts));
  const file = program.getSourceFile(entry);
  if (!file) throw new Error(`${entry} did not load`);
  const module = program.getTypeChecker().getSymbolAtLocation(file);
  if (!module) throw new Error(`${entry} is not a module`);
  return program
    .getTypeChecker()
    .getExportsOfModule(module)
    .map((symbol) => symbol.getName())
    .sort();
}

/**
 * Whether the entry file forwards the name with a `type` modifier.
 *
 * Asking the resolved symbol alone answers the wrong question: `export type { paginate }` still
 * resolves to a function, so a break that costs every caller their call site reads as no change
 * at all. The modifier is on the export site, so that is where it has to be read.
 */
function forwardedAsTypeOnly(
  ts: typeof import('typescript'),
  symbol: import('typescript').Symbol,
): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.isExportSpecifier(declaration)) {
      return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
    }
    if (ts.isImportSpecifier(declaration)) {
      return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
    }
    return false;
  });
}

/**
 * The roster of every module subpath, as the checker sees it.
 *
 * The program is built over the sources rather than `dist`, so the answer does not depend on a
 * build having been run. The two were measured against each other across every subpath and
 * agreed on every symbol, kind included.
 */
export function readSurface(root: string): Roster {
  const { ts, program, subpaths } = openProgram(root);
  const checker = program.getTypeChecker();

  const roster: Record<string, SubpathRoster> = {};
  for (const entry of subpaths) {
    const file = program.getSourceFile(join(root, entry.source));
    if (!file)
      throw new Error(`${entry.subpath}: ${entry.source} did not load`);
    const module = checker.getSymbolAtLocation(file);
    if (!module) {
      throw new Error(`${entry.subpath}: ${entry.source} is not a module`);
    }
    const named: Record<string, SymbolKind> = {};
    for (const exported of checker.getExportsOfModule(module)) {
      let resolved = exported;
      if (resolved.flags & ts.SymbolFlags.Alias) {
        resolved = checker.getAliasedSymbol(resolved);
      }
      const usable =
        resolved.flags & ts.SymbolFlags.Value &&
        !forwardedAsTypeOnly(ts, exported);
      named[exported.getName()] = usable ? 'value' : 'type';
    }
    roster[entry.subpath] = Object.fromEntries(
      Object.entries(named).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
  return roster;
}

/** The npm name the packages install the lab under. */
export const LAB_NAME = '@pwngh/economy-lab';

export interface LabSpecifier {
  /** The workspace package the import sits in, by npm name. */
  readonly package: string;
  /** The importing file, relative to the repository root. */
  readonly file: string;
  /** The specifier as written. */
  readonly specifier: string;
  /** The key that specifier asks the lab's `exports` map for. */
  readonly subpath: string;
  /** Whether the importing file sits under a directory the package's `files` array ships. */
  readonly shipped: boolean;
}

const SPECIFIER =
  /(?:from|import|require)\s*\(?\s*['"](@pwngh\/economy-lab(?:\/[^'"]+)?)['"]/g;

/**
 * Read but never classified as shipped.
 *
 * `dist` is the emit of `src`, so counting both reports every specifier twice, and a `.d.ts` looks
 * like a source file to the extension test below. `node_modules` is somebody else's tree.
 */
const NOT_A_SOURCE_TREE = new Set(['dist', 'node_modules']);

/** A `files` entry carrying a `*` or a leading `!` is a pattern; only a literal one is a path. */
const literalRoot = (entry: string): string | undefined =>
  /[*!]/.test(entry) ? undefined : entry.replace(/^\.?\//, '').split('/')[0];

/**
 * Every `@pwngh/economy-lab` specifier a package names, in its shipped trees and its rigs alike,
 * each carrying which of the two it came from.
 *
 * THE TWO HALVES ANSWER DIFFERENT QUESTIONS AND MUST NOT BE POOLED. A shipped file resolves
 * through the registry at a consumer's `npm i`, so its specifier has to exist in a lab the
 * registry actually carries — that is the install gate, and it is why `AWAITING_A_LAB_RELEASE`
 * exists. A rig resolves through the workspace symlink and is never in the tarball, so it can
 * name a subpath no published lab answers without breaking anybody; all it has to do is resolve
 * HERE. `shipped` is read off the package's own `files` array rather than assumed to mean `src`,
 * because it does not: `packages/adapters` ships `demos`, `packages/core` ships `example` and
 * `create-economy` ships `templates`, and a lab import in any of those reaches a consumer.
 */
export function labSpecifiers(root: string): LabSpecifier[] {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];

  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const path = join(dir, entry.name);
          if (NOT_A_SOURCE_TREE.has(entry.name)) return [];
          if (entry.isDirectory()) return walk(path);
          return /\.tsx?$/.test(entry.name) ? [path] : [];
        })
      : [];

  const found: LabSpecifier[] = [];
  for (const slug of readdirSync(packages, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const home = join(packages, slug.name);
    const manifest = join(home, 'package.json');
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string;
      files?: readonly string[];
    };
    const ships = new Set(
      (json.files ?? [])
        .map(literalRoot)
        .filter((entry): entry is string => entry !== undefined),
    );

    for (const file of walk(home)) {
      const [top] = relative(home, file).split('/');
      const text = readFileSync(file, 'utf8');
      for (const [, specifier] of text.matchAll(SPECIFIER)) {
        found.push({
          package: json.name,
          file: relative(root, file),
          specifier: specifier!,
          subpath: `.${specifier!.slice(LAB_NAME.length)}` as string,
          shipped: ships.has(top!),
        });
      }
    }
  }
  return found;
}

/**
 * The `src/**` files the public subpaths reach, and the ones they do not.
 *
 * A promotion out of an unreached file turns a private helper into contract, so which files are
 * outside the closure is itself part of the surface.
 */
export function sourceClosure(root: string): {
  readonly all: readonly string[];
  readonly reached: readonly string[];
  readonly unreached: readonly string[];
} {
  const { program } = openProgram(root);
  const src = join(root, 'src');

  const loaded = new Set(
    program
      .getSourceFiles()
      .map((file) => resolve(file.fileName))
      .filter((file) => file.startsWith(`${src}/`)),
  );

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });

  const all = existsSync(src) ? walk(src).sort() : [];
  const rel = (path: string) => relative(root, path);
  return {
    all: all.map(rel),
    reached: all.filter((file) => loaded.has(file)).map(rel),
    unreached: all.filter((file) => !loaded.has(file)).map(rel),
  };
}
