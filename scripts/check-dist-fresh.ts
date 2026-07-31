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

// Dates every build output in the repository against the source it was built from, and refuses
// when one is behind. Given an app directory, it also resolves the published specifiers that app
// imports and refuses when one of them falls outside the outputs it dated — the app runs on the
// emit, so an emit nobody dated is an app testing the previous build.
//
//   node scripts/check-dist-fresh.ts
//   node scripts/check-dist-fresh.ts apps/console
//
// The reader and the command are one file: the argv shell around this was a separate module whose
// whole content was a `main` nothing else called.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { publishedSpecifiers } from './support/dist-reach.ts';
import {
  type Member,
  readRootPackage,
  readWorkspace,
} from './support/workspace-graph.ts';

/** A source directory and the directory the build writes its emit to, both unit-relative. */
export interface BuildRoot {
  readonly sources: string;
  readonly outputs: string;
  /**
   * Whether the compiler emits only the files this root's importers reach. A source with no
   * output is an unbuilt file everywhere else and ordinary here.
   */
  readonly closureOnly: boolean;
}

/** One thing that gets built: source trees, their emit, and the command that rebuilds them. */
export interface BuildUnit {
  readonly name: string;
  readonly dir: string;
  readonly roots: readonly BuildRoot[];
  /** Verbatim, so a refusal can be pasted into a shell. */
  readonly command: string;
}

export type StaleReason = 'older' | 'missing' | 'orphan';

export interface Stale {
  readonly unit: string;
  /** Root-relative, because that is how a reader finds the file. */
  readonly output: string;
  readonly source: string;
  readonly reason: StaleReason;
  readonly command: string;
  /** How far the output lags its source. Zero when there is no output to date. */
  readonly lagMs: number;
}

export interface RootFreshness {
  readonly sources: string;
  readonly outputs: string;
  readonly sourceCount: number;
  /** Build outputs found on disk, walked without reference to the sources. */
  readonly outputCount: number;
  readonly compared: number;
  readonly orphaned: number;
}

export interface UnitFreshness {
  readonly name: string;
  readonly command: string;
  readonly roots: readonly RootFreshness[];
  readonly compared: number;
}

export interface Freshness {
  readonly units: readonly UnitFreshness[];
  /** Absolute, so a caller can ask whether the file it is about to load is one of them. */
  readonly comparedOutputs: ReadonlySet<string>;
  readonly stale: readonly Stale[];
}

interface TsConfig {
  readonly compilerOptions?: {
    readonly rootDir?: string;
    readonly outDir?: string;
  };
  readonly include?: readonly string[];
}

// What tsc writes for one source file. Source maps are off in every build config here; a
// `.js.map` would end in neither and go uncounted rather than be read as an orphan.
const EMITTED = ['.js', '.d.ts'] as const;

const isEmitted = (path: string): boolean =>
  EMITTED.some((extension) => path.endsWith(extension));

const isCompilable = (path: string): boolean =>
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

function readTsConfig(path: string, unit: string): TsConfig {
  if (!existsSync(path)) {
    throw new Error(
      `dist-freshness: ${unit} builds from ${path}, which is not there`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TsConfig;
  } catch (cause) {
    throw new Error(`dist-freshness: ${unit}'s ${path} is not readable JSON`, {
      cause,
    });
  }
}

/**
 * The project a `tsc -p <project>` build script compiles, or null for a script of another
 * shape. Null is never a pass: the caller says so and refuses rather than guess a layout.
 */
export function tsconfigOf(script: string): string | null {
  const tokens = script.split(/\s+/).filter((token) => token !== '');
  const at = tokens.indexOf('-p');
  const project = at === -1 ? undefined : tokens[at + 1];
  if (project === undefined) return null;
  return project === '.' ? 'tsconfig.json' : project;
}

function unitRelative(dir: string, declared: string, unit: string): string {
  const path = relative(dir, join(dir, declared));
  if (path === '' || path.startsWith('..')) {
    throw new Error(
      `dist-freshness: ${unit} declares ${JSON.stringify(declared)}, which is not a directory inside it`,
    );
  }
  return path;
}

function assertDisjoint(root: BuildRoot, unit: string): void {
  const nested =
    root.sources === root.outputs ||
    root.sources.startsWith(`${root.outputs}/`) ||
    root.outputs.startsWith(`${root.sources}/`);
  if (nested) {
    throw new Error(
      `dist-freshness: ${unit} builds ${root.sources} into ${root.outputs}, one inside the other, so no output can be paired with a source`,
    );
  }
}

function packageUnit(member: Member): BuildUnit {
  const script = member.json.scripts?.build ?? '';
  const project = tsconfigOf(script);
  if (project === null) {
    throw new Error(
      `dist-freshness: cannot read where ${member.name} puts its emit — its build script is ${JSON.stringify(script)}, not a \`tsc -p <project>\``,
    );
  }
  const options = readTsConfig(
    join(member.dir, project),
    member.name,
  ).compilerOptions;
  for (const field of ['rootDir', 'outDir'] as const) {
    if (options?.[field] === undefined) {
      throw new Error(
        `dist-freshness: ${member.name}'s ${project} sets no ${field}, so its emit cannot be paired with its source`,
      );
    }
  }
  const root: BuildRoot = {
    sources: unitRelative(member.dir, options!.rootDir!, member.name),
    outputs: unitRelative(member.dir, options!.outDir!, member.name),
    closureOnly: false,
  };
  assertDisjoint(root, member.name);
  return {
    name: member.name,
    dir: member.dir,
    roots: [root],
    command: `npm run build -w ${member.name}`,
  };
}

// tsconfig.build.json compiles a rewritten copy of the tree under a staging directory, so each
// include pattern names a directory that is copied there whole and emitted whole.
const STAGED_INCLUDE = /^(?<staging>[^/]+)\/(?<root>.+)\/\*\*\/\*\.ts$/;

// Copied into the same compile for the conformance suite to import. Only the part of it that
// closure reaches is emitted, so the rest is not an unbuilt source.
const LAB_CLOSURE_SOURCES = 'test/support';

function labUnit(root: string): BuildUnit {
  const lab = readRootPackage(root);
  const config = readTsConfig(join(root, 'tsconfig.build.json'), lab.name);
  const outDir = config.compilerOptions?.outDir;
  const staging = config.compilerOptions?.rootDir;
  if (outDir === undefined || staging === undefined) {
    throw new Error(
      `dist-freshness: ${lab.name}'s tsconfig.build.json sets no rootDir or outDir`,
    );
  }
  const roots: BuildRoot[] = [];
  for (const pattern of config.include ?? []) {
    const parts = STAGED_INCLUDE.exec(pattern)?.groups;
    if (parts?.staging !== staging) {
      throw new Error(
        `dist-freshness: ${lab.name} compiles ${JSON.stringify(pattern)}, which does not name a directory under ${staging} — the source it emits from cannot be read off it`,
      );
    }
    roots.push({
      sources: parts.root,
      outputs: join(outDir, parts.root),
      closureOnly: false,
    });
  }
  if (roots.length === 0) {
    throw new Error(
      `dist-freshness: ${lab.name}'s tsconfig.build.json includes nothing`,
    );
  }
  roots.push({
    sources: LAB_CLOSURE_SOURCES,
    outputs: join(outDir, LAB_CLOSURE_SOURCES),
    closureOnly: true,
  });
  for (const each of roots) assertDisjoint(each, lab.name);
  const command = lab.json.scripts?.build;
  if (command === undefined) {
    throw new Error(`dist-freshness: ${lab.name} declares no build script`);
  }
  return { name: lab.name, dir: root, roots, command };
}

/**
 * Everything in this repository whose emit another suite loads: the lab, then every workspace
 * member that builds. A member with no build script has no emit to be stale.
 */
export function buildUnits(root: string): BuildUnit[] {
  const members = [...readWorkspace(root).values()]
    .filter((member) => member.json.scripts?.build !== undefined)
    .map(packageUnit);
  return [labUnit(root), ...members];
}

interface Tally {
  /** The path everything is reported relative to. */
  readonly repo: string;
  readonly compared: Set<string>;
  readonly stale: Stale[];
}

function checkRoot(
  unit: BuildUnit,
  root: BuildRoot,
  into: Tally,
): RootFreshness {
  const { repo, compared, stale } = into;
  const sourceDir = join(unit.dir, root.sources);
  const outputDir = join(unit.dir, root.outputs);
  const sources = walk(sourceDir).filter(isCompilable);

  // Every output the build owes this root, keyed by path so the walk below can be diffed
  // against it in both directions.
  const owed = new Map<string, string>();
  for (const source of sources) {
    const stem = join(outputDir, relative(sourceDir, source)).replace(
      /\.(m?ts|tsx)$/,
      '',
    );
    for (const extension of EMITTED) owed.set(`${stem}${extension}`, source);
  }

  const say = (path: string): string => relative(repo, path);
  let count = 0;
  for (const [output, source] of owed) {
    if (!existsSync(output)) {
      // A source the closure never reaches is not compiled at all, so there is nothing to date.
      if (root.closureOnly) continue;
      stale.push({
        unit: unit.name,
        output: say(output),
        source: say(source),
        reason: 'missing',
        command: unit.command,
        lagMs: 0,
      });
      continue;
    }
    const lag = statSync(source).mtimeMs - statSync(output).mtimeMs;
    compared.add(output);
    count += 1;
    if (lag > 0) {
      stale.push({
        unit: unit.name,
        output: say(output),
        source: say(source),
        reason: 'older',
        command: unit.command,
        lagMs: lag,
      });
    }
  }

  const present = walk(outputDir).filter(isEmitted);
  let orphaned = 0;
  for (const output of present) {
    if (owed.has(output)) continue;
    orphaned += 1;
    stale.push({
      unit: unit.name,
      // Stem only: which extension the vanished source carried is not knowable from its emit.
      source: say(join(sourceDir, relative(outputDir, output))).replace(
        /\.(js|d\.ts)$/,
        '',
      ),
      output: say(output),
      reason: 'orphan',
      command: unit.command,
      lagMs: 0,
    });
  }

  return {
    sources: root.sources,
    outputs: root.outputs,
    sourceCount: sources.length,
    outputCount: present.length,
    compared: count,
    orphaned,
  };
}

/**
 * Given units, every build output dated against the source it was built from. Measurement
 * only — {@link assertFresh} is what refuses.
 */
export function checkUnits(
  units: readonly BuildUnit[],
  repo: string,
): Freshness {
  const comparedOutputs = new Set<string>();
  const stale: Stale[] = [];
  const into: Tally = { repo, compared: comparedOutputs, stale };
  const measured = units.map((unit) => {
    const roots = unit.roots.map((each) => checkRoot(unit, each, into));
    return {
      name: unit.name,
      command: unit.command,
      roots,
      compared: roots.reduce((sum, each) => sum + each.compared, 0),
    };
  });
  return { units: measured, comparedOutputs, stale };
}

/** Every build output in the repository, dated. */
export const checkBuilds = (root: string): Freshness =>
  checkUnits(buildUnits(root), root);

const AGE = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
] as const;

function age(ms: number): string {
  for (const [suffix, size] of AGE) {
    if (ms >= size) return `${Math.floor(ms / size)}${suffix}`;
  }
  return `${Math.max(ms, 0)}ms`;
}

const LISTED = 8;

function describe(stale: Stale): string {
  const line =
    stale.reason === 'older'
      ? `${stale.output} is ${age(stale.lagMs)} older than ${stale.source}`
      : stale.reason === 'missing'
        ? `${stale.output} was never built from ${stale.source}`
        : `${stale.output} is left over: there is no source at ${stale.source}`;
  return `  ${line}\n    fix: ${stale.command}`;
}

/**
 * Refuses when any build output is behind the source it was built from, and equally when the
 * check itself examined nothing. A suite that loads `dist` proves nothing about a source it was
 * not compiled from, so the refusal happens before the suite starts rather than inside it.
 *
 * Three things are asserted, not one: that no output is stale, that every declared root
 * examined outputs, and that every output on disk was either dated or named as left over. The
 * last is what stops a renamed directory or a changed emit extension turning this into a check
 * that passes having read zero files.
 */
export function assertFresh(report: Freshness, label: string): Freshness {
  const blind: string[] = [];
  for (const unit of report.units) {
    for (const each of unit.roots) {
      const say = (line: string): void => {
        blind.push(`  ${unit.name}: ${line}\n    fix: ${unit.command}`);
      };
      if (each.sourceCount === 0) {
        say(`nothing to compile under ${each.sources}`);
      } else if (each.compared === 0) {
        say(`nothing built under ${each.outputs}`);
      } else if (each.compared + each.orphaned !== each.outputCount) {
        say(
          `${each.outputCount} build outputs under ${each.outputs}, but ${each.compared} dated and ${each.orphaned} named as left over`,
        );
      }
    }
  }
  if (blind.length > 0) {
    throw new Error(
      `dist-freshness: ${label} cannot be dated against its source.\n${blind.join('\n')}\nA check that reads no files reports the same success as a fresh build.`,
    );
  }
  if (report.stale.length > 0) {
    const shown = report.stale.slice(0, LISTED).map(describe).join('\n');
    const rest =
      report.stale.length > LISTED
        ? `\n  and ${report.stale.length - LISTED} more`
        : '';
    throw new Error(
      `dist-freshness: ${label} would run against a build that is behind its source — ${report.stale.length} of ${report.comparedOutputs.size} outputs, across ${report.units.length} units.\n${shown}${rest}`,
    );
  }
  return report;
}

/** The whole repository, dated and refused in one call. */
export const assertBuildsFresh = (root: string, label: string): Freshness =>
  assertFresh(checkBuilds(root), label);

/**
 * Set to `1` by a runner that has already dated the emit for everything it is about to spawn,
 * and read by `test/support/dist-guard.ts`, which every root test file that reads the emit
 * imports. It says the dating has happened in this process tree, not that it may be skipped: a
 * shell that sets it by hand is asserting something it has not checked.
 */
export const BUILDS_DATED = 'ECONOMY_BUILDS_DATED';

const HERE = fileURLToPath(new URL('..', import.meta.url));

const SOURCE = /\.(ts|tsx)$/;
/** Any relative specifier, which is a file reaching into its own package. */
const REACHES_IN = /(?:from|import\()\s*'\./;

/** Every published specifier a tree imports, which is the set it loads out of the emit. */
function doors(dir: string, subs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const sub of subs) {
    const from = join(dir, sub);
    if (!existsSync(from)) continue;
    for (const file of readdirSync(from, {
      recursive: true,
      encoding: 'utf8',
    })) {
      if (!SOURCE.test(file)) continue;
      for (const specifier of publishedSpecifiers(
        readFileSync(join(from, file), 'utf8'),
      )) {
        found.add(specifier);
      }
    }
  }
  return [...found].sort();
}

/**
 * What one published specifier drags in behind it: the doors the source it lands on names.
 *
 * A subpath whose door file re-exports published specifiers and reaches nowhere into its own
 * package is described completely by that one file — which is what the umbrella's generated
 * doors are, and reading its manifest instead would pull in the whole workspace for a door that
 * re-exports one package. Any other door reaches into its package, so the whole tree is read.
 */
function behind(member: Member, specifier: string): string[] {
  const sub = specifier.slice(member.name.length).replace(/^\//, '');
  if (sub !== '') {
    const file = join(member.dir, 'src', `${sub}.ts`);
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (!REACHES_IN.test(text)) return publishedSpecifiers(text);
    }
  }
  return doors(member.dir, ['src']);
}

/**
 * The build units one workspace member's own tests can load. Its tests read its `src` through
 * the loader, so a change there is visible to them; every `@pwngh/` specifier in that tree
 * resolves through an exports map into an emit instead, and so does every specifier those emits
 * carry. Those are the builds a green run would be describing.
 *
 * Narrow on purpose. Dating the whole repository would refuse a lane iterating on one package
 * because a package it never loads is behind, which is a refusal nobody can work under.
 */
export function unitsRead(root: string, dir: string): BuildUnit[] {
  const units = new Map(buildUnits(root).map((unit) => [unit.name, unit]));
  const workspace = readWorkspace(root);
  const lab = readRootPackage(root);
  const known = [lab.name, ...workspace.keys()];
  const owner = (specifier: string): string | undefined =>
    known.find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    );

  const at = resolve(dir);
  const member = [...workspace.values()].find(
    (each) => resolve(each.dir) === at,
  );
  if (member === undefined) {
    throw new Error(
      `dist-freshness: ${at} is not a package in this workspace, so there is no emit to date for it`,
    );
  }

  // Its own emit is in, because a package's tests may load it and a sibling that imports the
  // package by name certainly does.
  const wanted = new Set<string>([member.name]);
  const queue = doors(member.dir, ['src', 'test']);
  const walked = new Set<string>();
  while (queue.length > 0) {
    const specifier = queue.shift()!;
    if (walked.has(specifier)) continue;
    walked.add(specifier);
    const holder = owner(specifier);
    if (holder === undefined) continue;
    wanted.add(holder);
    queue.push(
      ...behind(holder === lab.name ? lab : workspace.get(holder)!, specifier),
    );
  }

  const reads = [...wanted]
    .map((name) => units.get(name))
    .filter((unit): unit is BuildUnit => unit !== undefined);
  // A member that reads no emit at all would be dated by examining nothing, and a check that
  // reads no files reports the same success as a fresh build.
  if (reads.length === 0) {
    throw new Error(
      `dist-freshness: ${member.name} was found to read no build at all, which no package in this workspace does`,
    );
  }
  return reads;
}

function main(where: string | undefined): number {
  const label = where === undefined ? 'this repository' : where;
  let report: Freshness;
  try {
    report = assertBuildsFresh(HERE, label);
  } catch (refusal) {
    console.error((refusal as Error).message);
    return 1;
  }
  const dated = `${report.comparedOutputs.size} build outputs across ${report.units.length} units are at least as new as their sources`;
  if (where === undefined) {
    process.stdout.write(`dist-freshness: ${dated}\n`);
    return 0;
  }

  const dir = join(HERE, where);
  const specifiers = doors(dir, ['app', 'test']);
  const loose = specifiers.filter(
    (specifier) =>
      !report.comparedOutputs.has(
        createRequire(join(dir, 'package.json')).resolve(specifier),
      ),
  );
  if (specifiers.length === 0 || loose.length > 0) {
    console.error(
      `dist-freshness: ${label} imports ${specifiers.length} published specifiers and ${loose.length} of them fall outside the ${report.comparedOutputs.size} outputs dated against their sources.\n${loose
        .map((specifier) => `  ${specifier}`)
        .join('\n')}`,
    );
    return 1;
  }
  process.stdout.write(
    `dist-freshness: ${dated}, and every one of ${label}'s ${specifiers.length} imported doors is among them\n`,
  );
  return 0;
}

// Imported by the gate test for its readers; only a direct invocation dates anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , target] = process.argv;
  process.exitCode = main(
    target === undefined ? undefined : relative(HERE, resolve(target)),
  );
}
