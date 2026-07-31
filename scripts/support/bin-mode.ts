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

// Sets the executable bit on every `bin` target the workspace declares.
//
//   node scripts/support/bin-mode.ts
//
// npm sets the bit when it installs or links a package, and a rebuild overwrites the file at
// whatever mode the compiler writes, which is 644. The link in node_modules/.bin then points at
// a file the kernel refuses to exec, so a script that goes through the linked bin dies before a
// line of it runs while one that spells out `node <path>` keeps working.
//
// The roster comes from the manifests' own `bin` maps, so a package that declares a second
// command, or a new package that declares its first, is covered without being named here.

import { chmodSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readRootPackage, readWorkspace } from './workspace-graph.ts';

import type { Member } from './workspace-graph.ts';

/** One command a manifest declares, resolved to the file it runs and the link npm writes. */
export interface DeclaredBin {
  readonly package: string;
  /** The name npm links into node_modules/.bin. */
  readonly command: string;
  readonly target: string;
  /** Where npm puts the link, whether or not it is there. */
  readonly link: string;
}

/** The three bits `chmod +x` sets. */
export const EXECUTABLE = 0o111;

export const isExecutable = (path: string): boolean =>
  (statSync(path).mode & EXECUTABLE) === EXECUTABLE;

/**
 * npm writes the link under the package's own scope-free name when `bin` is a bare string, and
 * under each key when it is a map. Both shapes are read; anything else is not a `bin`.
 */
function binsOf(root: string, member: Member): DeclaredBin[] {
  const declared = member.json.bin;
  if (declared === undefined) return [];
  const links = new Map<string, string>();
  if (typeof declared === 'string') {
    links.set(member.name.replace(/^@[^/]+\//, ''), declared);
  } else {
    for (const [command, target] of Object.entries(declared)) {
      links.set(command, target);
    }
  }
  return [...links].map(([command, target]) => ({
    package: member.name,
    command,
    target: join(member.dir, target),
    link: join(root, 'node_modules', '.bin', command),
  }));
}

/** Every command this repository declares: the root manifest's own, then each member's. */
export function declaredBins(root: string): DeclaredBin[] {
  return [readRootPackage(root), ...readWorkspace(root).values()]
    .flatMap((member) => binsOf(root, member))
    .sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * Marks each declared target that is on disk and reports every one it looked at. A target that
 * is missing is a package that has not been built yet, which this cannot fix and does not judge;
 * the gate is what refuses an unbuilt command.
 */
export function markBinsExecutable(root: string): {
  readonly marked: readonly DeclaredBin[];
  readonly unbuilt: readonly DeclaredBin[];
} {
  const marked: DeclaredBin[] = [];
  const unbuilt: DeclaredBin[] = [];
  for (const bin of declaredBins(root)) {
    if (!existsSync(bin.target)) {
      unbuilt.push(bin);
      continue;
    }
    chmodSync(bin.target, statSync(bin.target).mode | EXECUTABLE);
    marked.push(bin);
  }
  return { marked, unbuilt };
}

const HERE = fileURLToPath(new URL('../..', import.meta.url));

function main(): number {
  const { marked, unbuilt } = markBinsExecutable(HERE);
  if (marked.length === 0 && unbuilt.length === 0) {
    console.error(
      'bin-mode: no manifest in this workspace declares a bin, so nothing was marked',
    );
    return 1;
  }
  const say = (bin: DeclaredBin) =>
    `${bin.command} -> ${relative(HERE, bin.target)}`;
  process.stdout.write(
    `bin-mode: ${marked.length} declared bin target(s) executable — ${marked.map(say).join(', ')}\n`,
  );
  for (const bin of unbuilt) {
    process.stdout.write(
      `bin-mode: ${bin.package} declares ${bin.command} and has not built ${relative(HERE, bin.target)} yet\n`,
    );
  }
  return 0;
}

// Imported by the build scripts and the gate; only a direct invocation changes a mode.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
