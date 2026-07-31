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

// Where a helper lives, asserted. `Q53` S6 moved nine groups out of `scripts/` and into the tree
// that owns them, and the plan's done-condition for it was "test/ reaches into scripts/ nowhere".
// That is unreachable and the reason is structural rather than unfinished work: the gate entry and
// the workspace model both stay flat in `scripts/` by ruling, and suites under `test/` read both.
// So what is gated is the roster of what remains reachable, exactly, with the reason each one is
// allowed — and the count of what moved, resolved on both sides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Everything under `scripts/` a suite may still import, and why it is not a move S6 skipped. Each
 * is repo machinery with callers on both sides of the script/test boundary, which is the one shape
 * that has nowhere better to be: `test/` cannot own the gate that runs it, and `packages/` cannot
 * own a model of `packages/`.
 */
const ALLOWED_REACH: ReadonlyMap<string, string> = new Map([
  [
    '#scripts/check.ts',
    'the single gate entry: the table cannot live inside the tree it runs',
  ],
  [
    '#scripts/check-dist-fresh.ts',
    'a gate entry that both `check.ts` and `apps/console` spawn; its reader merged into it in S6',
  ],
  [
    '#scripts/support/workspace-graph.ts',
    'the workspace model, read by three build scripts and five suites; it needs no package and no lib/',
  ],
  [
    '#scripts/support/dist-reach.ts',
    'which files read the emit: both runners classify with it and test/dist-reach.test.ts gates the classification',
  ],
]);

/**
 * Every source under a directory, at any depth. `.tsx` is named because the one tree with any is
 * `packages/ui`, and a `.ts` glob would skip it in silence.
 */
function sourcesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, found);
    else if (/\.(tsx?|mjs)$/.test(entry.name)) found.push(relative(ROOT, path));
  }
  return found;
}

const sources = sourcesUnder(join(ROOT, 'test'));

/**
 * This file, skipped by the sweep. It has to be: the roster below writes each allowed specifier
 * out as a quoted string, so a sweep that read this file would find every allowance imported by
 * the allowance itself — and no allowance could ever be caught unused. Found by the positive
 * control below, which passed against a specifier nothing imports until the skip was added.
 */
const SELF = 'test/toolchain-shape.test.ts';

const SPECIFIER = /'(#scripts\/[^']+)'/g;

const reach = new Map<string, string[]>();
for (const path of sources) {
  if (path === SELF) continue;
  for (const [, specifier] of readFileSync(join(ROOT, path), 'utf8').matchAll(
    SPECIFIER,
  )) {
    reach.set(specifier!, [...(reach.get(specifier!) ?? []), path]);
  }
}

test('test/ reaches into scripts/ only for what stays flat there', () => {
  // A sweep that read nothing satisfies every comparison under it, so the count it examined is
  // asserted before the set it found.
  assert.ok(sources.length > 150, `the sweep read ${sources.length} sources`);
  // Skipping this file proves nothing unless the walk would otherwise have reached it.
  assert.ok(sources.includes(SELF), `${SELF} was not walked`);
  assert.match(
    readFileSync(join(ROOT, SELF), 'utf8'),
    SPECIFIER,
    `${SELF} is skipped because its roster looks like imports, and it no longer does`,
  );
  assert.deepEqual(
    [...reach.keys()].sort(),
    [...ALLOWED_REACH.keys()].sort(),
    `${sources.length} sources swept; the scripts/ modules test/ imports are not the ones allowed`,
  );
  // Positive control. `deepEqual` on two empty lists passes, so each allowed specifier must
  // resolve to a real file AND be found by a real importer — the absence a broken sweep produces
  // is not the absence this gate means.
  for (const [specifier, why] of ALLOWED_REACH) {
    const importers = reach.get(specifier) ?? [];
    assert.ok(
      importers.length > 0,
      `${specifier} is allowed and nothing imports it; delete the allowance (${why})`,
    );
    assert.ok(
      existsSync(join(ROOT, specifier.replace('#scripts/', 'scripts/'))),
      `${specifier} is imported by ${importers.join(', ')} and is not on disk`,
    );
  }
});

/**
 * The nine groups S6 moved, each as the path it left and the path it arrived at. Resolved on both
 * sides every run: a move recorded here whose destination is missing is a half-move, and one whose
 * origin is back is a file that came home without the roster being told.
 */
const MOVED: ReadonlyArray<readonly [string, string]> = [
  ['scripts/prove.ts', 'test/prove.test.ts'],
  ['scripts/fuzz.ts', 'test/fuzz.test.ts'],
  ['scripts/lab-surface.ts', 'test/fixtures/generate-lab-surface.ts'],
  ['scripts/support/dedupe.ts', 'test/support/dedupe.ts'],
  ['scripts/support/lab-surface.ts', 'test/support/lab-surface.ts'],
  ['scripts/support/package-suites.ts', 'test/support/package-suites.ts'],
  ['scripts/support/harness.ts', 'test/support/harness.ts'],
  ['scripts/support/rig.ts', 'test/support/rig.ts'],
  ['scripts/generate-economy.mjs', 'packages/economy/scripts/generate.ts'],
  ['scripts/compose-site.mjs', 'site/src/compose.mjs'],
  ['scripts/dev-site.mjs', 'site/src/dev.mjs'],
  ['scripts/docker.sh', 'rigs/docker.sh'],
  ['scripts/env-merge.sh', 'rigs/env-merge.sh'],
  ['scripts/db-clean.ts', 'rigs/db-clean.ts'],
  // The two merges: an argv shell whose whole content was a `main` nothing else called, folded
  // into the implementation it wrapped. The destination is the shell's name, not the reader's.
  ['scripts/check-dist-fresh.mjs', 'scripts/check-dist-fresh.ts'],
  ['scripts/support/dist-freshness.ts', 'scripts/check-dist-fresh.ts'],
  ['scripts/check-docs-fresh.mjs', 'scripts/check-docs-fresh.ts'],
  ['scripts/support/docs-freshness.ts', 'scripts/check-docs-fresh.ts'],
];

/**
 * Edited deliberately when a move lands. Both sides of a reconciliation fall together when a row
 * is deleted, so the size is pinned apart from the list — the `DECLARED_STEPS` reason.
 */
const DECLARED_MOVES = 18;

test('every unit S6 moved is gone from scripts/ and present where it went', () => {
  assert.equal(
    MOVED.length,
    DECLARED_MOVES,
    `the roster holds ${MOVED.length} moves and declares ${DECLARED_MOVES}`,
  );
  const wrong: string[] = [];
  for (const [from, to] of MOVED) {
    if (existsSync(join(ROOT, from))) wrong.push(`${from} is back`);
    if (!existsSync(join(ROOT, to))) wrong.push(`${to} is not there`);
  }
  assert.deepEqual(wrong, []);
  // The two merges are two rows each onto one destination, so eighteen moves land in sixteen
  // places. A roster that collapsed to a single row would still satisfy the loop above.
  assert.equal(new Set(MOVED.map(([, to]) => to)).size, 16);
});

/**
 * What each destination holds, in full. A move that landed beside a leftover reads as done from
 * the origin side alone, which is what the `from` half above cannot see.
 */
const HOMES: ReadonlyMap<string, readonly string[]> = new Map([
  ['rigs', ['db-clean.ts', 'docker.sh', 'env-merge.sh']],
  ['site/src', ['compose.mjs', 'dev.mjs']],
  ['packages/economy/scripts', ['generate.ts']],
  // What is left of the helper directory: the workspace model, the database tooling S2 takes to
  // `src/lib/db-tools.ts` with the supervisor package, two readers of the manifests that the build
  // scripts and the two test runners share, and the node:test reporter all four runners attach.
  [
    'scripts/support',
    [
      'bin-mode.ts',
      'counted.reporter.mjs',
      'db-tools.ts',
      'dist-reach.ts',
      'workspace-graph.ts',
    ],
  ],
]);

test('each destination holds exactly what moved there', () => {
  for (const [dir, expected] of HOMES) {
    assert.deepEqual(
      readdirSync(join(ROOT, dir)).sort(),
      [...expected].sort(),
      `${dir} holds something other than what S6 put there`,
    );
  }
  assert.equal(HOMES.size, 4);
});

/**
 * The lab files a package rig reads by relative path, each with the reason the copy it replaces
 * was not worth keeping. This is the only door a package has into the lab's unpublished trees:
 * `imports` targets cannot leave a package (`ERR_INVALID_PACKAGE_TARGET`), the lab's `exports`
 * refuses every subpath it does not name, and a `packages/*` member cannot be private — the
 * publish orchestrator refuses one by name. So the reach is relative, and it is rostered here.
 *
 * EVERY FILE HERE IMPORTS `node:` BUILTINS, PLUS EXACTLY THE TOOLCHAIN MODULES ITS ROW NAMES —
 * AND NEVER THE LAB, asserted below. A package's suite runs against the built lab; a lab file it
 * also loaded from source would put a second copy of the lab in the process, which is the
 * confusion `test/errors.test.ts` exists to rule out. A row may admit a root toolchain module
 * such as `typescript`, which both trees already load and which ships no lab body; a `#src/*`,
 * `#test/*` or `@pwngh/*` specifier can never be admitted, and the assertion refuses one before
 * it reads any row. The package typechecks refuse a lab-source reach independently where their
 * compiler options do not accept the lab's `.ts` specifiers, but a rule this load-bearing is
 * stated in one place and read here.
 */
const PACKAGE_REACH: ReadonlyMap<
  string,
  { readonly why: string; readonly alsoImports: readonly string[] }
> = new Map([
  [
    'test/support/framing.ts',
    {
      why: 'the socket framing reader: two doors state the same framing rule and each answers for it at its own door, so the probe underneath them is one thing',
      alsoImports: [],
    },
  ],
  [
    'test/support/second-copy.ts',
    {
      why: 'the duplicated-install builder: the lab suite and the core suite each prove a brand survives a second copy of their module, and the technique underneath them is one thing parameterised over the package name and the source path',
      alsoImports: ['typescript'],
    },
  ],
  [
    'test/support/throwaway-database.ts',
    {
      why: "the create-use-drop throwaway database: the lab's rigs and the mysql rig each need a database of their own to run schema-destroying DDL against, and the technique underneath them is one thing parameterised over the pool factory — which it has to be, because the two callers open pools from that package's dist and from its source",
      alsoImports: [],
    },
  ],
]);

test('a package reaches into the lab only for what both trees read', () => {
  const packages = join(ROOT, 'packages');
  const rigs = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => sourcesUnder(join(packages, entry.name)))
    .filter((path) => !path.includes(`${sep}dist${sep}`));
  assert.ok(rigs.length > 150, `the sweep read ${rigs.length} package sources`);

  const reached = new Map<string, string[]>();
  for (const path of rigs) {
    const from = dirname(join(ROOT, path));
    for (const [, specifier] of readFileSync(join(ROOT, path), 'utf8').matchAll(
      /from '(\.[^']+)'/g,
    )) {
      const target = relative(ROOT, resolve(from, specifier!)).replace(
        /\.js$/,
        '.ts',
      );
      if (target.startsWith('packages/')) continue;
      reached.set(target, [...(reached.get(target) ?? []), path]);
    }
  }
  assert.deepEqual(
    [...reached.keys()].sort(),
    [...PACKAGE_REACH.keys()].sort(),
    `${rigs.length} package sources swept; the lab files they reach are not the ones rostered`,
  );

  // Positive control, and the rule. An allowance nothing imports is dead, and a rostered file
  // that grew an import of the lab's source is the second copy this roster exists to prevent.
  for (const [path, { why, alsoImports }] of PACKAGE_REACH) {
    assert.ok(
      (reached.get(path) ?? []).length > 0,
      `${path} is rostered and no package reads it; delete the allowance (${why})`,
    );
    // The allowance itself can never name the lab: the second-copy rule has no exemption.
    for (const admitted of alsoImports) {
      assert.doesNotMatch(
        admitted,
        /^[#.]|^@pwngh/,
        `${path} tries to admit ${admitted}; only a bare toolchain module can be admitted here`,
      );
    }
    const text = readFileSync(join(ROOT, path), 'utf8');
    const foreign = [...text.matchAll(/from '([^']+)'/g)]
      .map(([, specifier]) => specifier!)
      .filter((specifier) => !specifier.startsWith('node:'));
    assert.deepEqual(
      foreign,
      alsoImports,
      `${path} is read by a package rig and imports ${foreign.join(', ')}; beyond node: builtins it may import exactly ${JSON.stringify(alsoImports)} — a lab import here is a second copy of the lab in that rig`,
    );
  }
});

test('site/ carries no manifest, so it cannot become publishable', () => {
  // A manifest here would be a package boundary, and `#src/*` and `#test/*` resolve against the
  // nearest one — the measurement that killed S5's `bench/` member. Nothing is bought for it:
  // both composers import node builtins only, and no gate in this tree reads the root
  // `workspaces` array, so membership would move no count and only regenerate the lockfile.
  assert.ok(
    !existsSync(join(ROOT, 'site', 'package.json')),
    'site/package.json is a package boundary; the two composers resolve against the root',
  );
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    workspaces?: readonly string[];
  };
  assert.deepEqual(
    root.workspaces,
    ['packages/*'],
    'a workspace glob other than packages/* changes what npm publish walks',
  );
});
