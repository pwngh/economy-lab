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

// `.node-version` picks the Node every CI job runs on, and `engines.node` is what a consumer's
// installer enforces. They agreed by coincidence: nothing compared them, so raising one and
// leaving the other would have shipped a package whose declared floor is a version we never test.
//
// The comparison is on the floor of the range, not its text, so `>=22.18` and `>=22.18.0` agree
// and `>=22.19` does not.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Manifest {
  readonly private?: boolean;
  readonly engines?: { readonly node?: string };
}

/**
 * The two workspace members outside the roster, each with the reason it is out. `.prettierignore`
 * already rules that a standalone front-end app owns its own toolchain, and neither app is
 * published, so neither declares a floor a consumer installs against. The exemption is not a
 * hole: both are still read below, and the pin must satisfy whatever they do declare.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'apps/console',
    'private, unpublished, and declares no engines range at all',
  ],
  [
    'apps/docs',
    'private, unpublished, and runs on its own biome/vite toolchain',
  ],
]);

const read = (path: string): Manifest =>
  JSON.parse(readFileSync(path, 'utf8')) as Manifest;

/** A dotted version as three numbers, so `22.18` and `22.18.0` compare equal. */
function version(text: string): [number, number, number] {
  const parts = text.split('.').map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some(Number.isNaN)) {
    throw new Error(`"${text}" is not a dotted version`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * The floor of a range. Only `>=X` is accepted: a caret, a union or an upper bound is a different
 * promise to a consumer and gets decided deliberately, not matched by a looser parser.
 */
function floorOf(range: string, where: string): [number, number, number] {
  const match = /^>=\s*([\d.]+)$/.exec(range.trim());
  if (match === null) {
    throw new Error(`${where}: engines.node is "${range}", not a >= floor`);
  }
  return version(match[1]!);
}

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.every((part, index) => part === b[index]);

const atLeast = (a: readonly number[], b: readonly number[]): boolean => {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  }
  return true;
};

/** Root plus every packages/* manifest: the surfaces an installer reads. */
function roster(): string[] {
  const packages = join(ROOT, 'packages');
  const found = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('packages', entry.name, 'package.json'))
    .filter((path) => existsSync(join(ROOT, path)));
  return ['package.json', ...found.sort()];
}

function main(): number {
  const pinText = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();
  const pin = version(pinText);
  const problems: string[] = [];

  const manifests = roster();
  for (const path of manifests) {
    const declared = read(join(ROOT, path)).engines?.node;
    if (declared === undefined) {
      problems.push(`${path}: declares no engines.node`);
      continue;
    }
    const floor = floorOf(declared, path);
    if (!same(floor, pin)) {
      problems.push(
        `${path}: engines.node "${declared}" has floor ${floor.join('.')}, but .node-version pins ${pinText}`,
      );
    }
  }

  // Both sides of every exemption re-resolve: the member must still be there, must still be
  // private, and must still accept the version CI actually runs it on.
  for (const [where, why] of EXEMPT) {
    const path = join(where, 'package.json');
    if (!existsSync(join(ROOT, path))) {
      problems.push(`${path}: exempted (${why}) but is not a manifest`);
      continue;
    }
    const manifest = read(join(ROOT, path));
    if (manifest.private !== true) {
      problems.push(`${path}: exempted as private (${why}) but is publishable`);
    }
    const declared = manifest.engines?.node;
    if (declared !== undefined && !atLeast(pin, floorOf(declared, path))) {
      problems.push(
        `${path}: engines.node "${declared}" refuses the pinned ${pinText}`,
      );
    }
  }

  // A discovery sweep that finds nothing passes every assertion above it, so the two rosters are
  // counted, not just walked.
  const apps = readdirSync(join(ROOT, 'apps'), { withFileTypes: true }).filter(
    (entry) =>
      entry.isDirectory() &&
      existsSync(join(ROOT, 'apps', entry.name, 'package.json')),
  );
  if (manifests.length !== 19) {
    problems.push(`expected 19 published manifests, read ${manifests.length}`);
  }
  if (apps.length !== EXEMPT.size) {
    problems.push(
      `apps/ holds ${apps.length} manifests and ${EXEMPT.size} are exempted: ${apps.map((entry) => entry.name).join(', ')}`,
    );
  }

  if (problems.length > 0) {
    console.error(`node-floor: ${problems.length} disagreement(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  process.stdout.write(
    `node-floor: ${manifests.length} manifests declare the floor .node-version pins (${pinText}), ${EXEMPT.size} apps exempt\n`,
  );
  return 0;
}

process.exitCode = main();
