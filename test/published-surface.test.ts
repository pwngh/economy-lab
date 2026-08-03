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
 * The registry gate: what the published lab exports, held against what this tree exports.
 *
 * Every other surface check here reads a fixture generated from this tree, so it describes what
 * the tree exports and is structurally unable to notice that the tree exports LESS than the
 * registry does. Five subpaths and sixteen symbols left the published lab with every one of them
 * green, and nothing would have said so until an install was tried.
 *
 * The fixed side is therefore a capture of the published tarball, resolved through the same
 * checker the local side is. A published version never changes, so the capture never regenerates
 * and can never come to agree with this tree by construction — which is the property the
 * generated fixtures lack.
 *
 * A removal is allowed. An UNRECORDED removal is not: every subpath and every symbol the
 * registry answers and this tree does not has to be named below with where it went, and named in
 * the CHANGELOG with the same migration target. That pairing is what the gate asserts.
 *
 * It runs with no network. The registry is reached once, to check the capture is still the
 * latest release, and a run that cannot reach it SKIPS BY NAME rather than passing — the same
 * posture `publishPlan` takes when the registry will not say, where `unknown` is blocked and
 * never read as absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportedNames, readSurface } from '#test/support/lab-surface.ts';
import { readWorkspace } from '#scripts/support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The published surface: `npm pack`, then the checker over each exports-map `.d.ts`. */
const PUBLISHED = JSON.parse(
  readFileSync(join(ROOT, 'test/fixtures/lab-published-surface.json'), 'utf8'),
) as {
  package: string;
  version: string;
  capturedOn: string;
  method: string;
  subpaths: number;
  symbols: number;
  exports: Record<string, string[]>;
};

/** The exports map of the same release, captured separately and read by `test/publishing.test.ts`. */
const PUBLISHED_MAP = JSON.parse(
  readFileSync(join(ROOT, 'test/fixtures/lab-published-exports.json'), 'utf8'),
) as { version: string; exports: Record<string, unknown> };

const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const live = readSurface(ROOT);

/**
 * The published subpaths this tree no longer carries, each with the specifier that answers for
 * it now.
 *
 * The value is a promise to a consumer, so it is resolved rather than trusted: the named
 * specifier has to export every symbol its subpath shipped. That check is what found
 * `EngineOpenOptions` published on `./engines/postgres` and forwarded by no package.
 */
const MOVED_TO_A_PACKAGE = new Map([
  ['./adapters/redis', '@pwngh/economy-redis'],
  ['./adapters/sqs', '@pwngh/economy-sqs'],
  ['./engines/postgres', '@pwngh/economy-postgres'],
  ['./engines/mysql', '@pwngh/economy-mysql'],
  ['./engines/mysql-mariadb', '@pwngh/economy-mysql/mariadb'],
  ['./testing', '@pwngh/economy-conformance'],
]);

/** The published subpath renamed in place, its published key to this tree's. */
const RENAMED_SUBPATHS = new Map([['./ops', './supervisor']]);

/** The published symbols renamed in place, their published names to this tree's. */
const RENAMED_SYMBOLS = new Map([
  ['OpsRuntime', 'SupervisorRuntime'],
  ['createOpsRuntime', 'createSupervisorRuntime'],
]);

const localKeyOf = (subpath: string) =>
  RENAMED_SUBPATHS.get(subpath) ?? subpath;
const localNameOf = (name: string) => RENAMED_SYMBOLS.get(name) ?? name;

const publishedNames = new Set(Object.values(PUBLISHED.exports).flat());
const liveNames = new Set(
  Object.values(live).flatMap((named) => Object.keys(named)),
);

// ---------------------------------------------------------------------------
// The fixed side
// ---------------------------------------------------------------------------

test('the fixed side is a capture of a release, not of this tree', () => {
  assert.equal(PUBLISHED.package, '@pwngh/economy-lab');
  assert.match(PUBLISHED.method, /npm pack/);
  assert.match(PUBLISHED.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
  // The totals are declared in the file and recomputed from it, so a capture truncated on the
  // way in reads as a pile of removals rather than as a smaller roster nobody notices.
  assert.equal(Object.keys(PUBLISHED.exports).length, PUBLISHED.subpaths);
  assert.equal(
    Object.values(PUBLISHED.exports).reduce((sum, on) => sum + on.length, 0),
    PUBLISHED.symbols,
  );
  assert.equal(PUBLISHED.subpaths, 14);
  assert.equal(PUBLISHED.symbols, 409);
  assert.equal(publishedNames.size, 368, `${publishedNames.size} distinct`);

  // Two independent captures of the same release. One recaptured without the other would leave
  // this gate comparing a surface against an exports map from a different version.
  assert.equal(PUBLISHED.version, PUBLISHED_MAP.version);
  assert.deepEqual(
    Object.keys(PUBLISHED.exports).sort(),
    Object.keys(PUBLISHED_MAP.exports)
      .filter((key) => key !== './package.json')
      .sort(),
  );
});

// ---------------------------------------------------------------------------
// Subpaths
// ---------------------------------------------------------------------------

test('every published subpath this tree dropped is recorded, with where it went', () => {
  const dropped = Object.keys(PUBLISHED.exports).filter(
    (subpath) => !Object.hasOwn(live, localKeyOf(subpath)),
  );
  assert.deepEqual(
    dropped.sort(),
    [...MOVED_TO_A_PACKAGE.keys()].sort(),
    'a published subpath is gone from this tree and named in no roster here',
  );
  // The other direction: a roster entry for a subpath that is still exported would sit here
  // claiming a migration nobody has to make, and would hide the day it becomes true.
  for (const subpath of MOVED_TO_A_PACKAGE.keys()) {
    assert.ok(
      Object.hasOwn(PUBLISHED.exports, subpath),
      `${subpath} is recorded as moved out and ${PUBLISHED.version} never published it`,
    );
  }
  for (const [published, local] of RENAMED_SUBPATHS) {
    assert.ok(
      Object.hasOwn(PUBLISHED.exports, published),
      `${published} is recorded as renamed and ${PUBLISHED.version} never published it`,
    );
    assert.ok(
      Object.hasOwn(live, local),
      `${published} is recorded as renamed to ${local}, which this tree does not export`,
    );
  }
  assert.equal(MOVED_TO_A_PACKAGE.size, 6);
  assert.equal(RENAMED_SUBPATHS.size, 1);
});

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

// The surviving subpaths are where a quietly dropped export hides: the subpath is still on the
// map, the totals still reconcile, and one name is missing from it.
test('every surviving subpath still answers every name it published', () => {
  let examined = 0;
  for (const [subpath, names] of Object.entries(PUBLISHED.exports)) {
    const named = live[localKeyOf(subpath)];
    if (named === undefined) continue;
    examined += 1;
    const lost = names
      .map(localNameOf)
      .filter((name) => !Object.hasOwn(named, name));
    assert.deepEqual(
      lost,
      [],
      `${subpath} published ${lost.join(', ')} and ${localKeyOf(subpath)} no longer answers`,
    );
  }
  assert.equal(examined, 8, `read ${examined} surviving subpaths`);
});

test('every published symbol this tree dropped is recorded, as a move or a rename', () => {
  const gone = [...publishedNames].filter((name) => !liveNames.has(name));

  const moved = [
    ...new Set(
      [...MOVED_TO_A_PACKAGE.keys()].flatMap(
        (subpath) => PUBLISHED.exports[subpath]!,
      ),
    ),
  ];
  assert.deepEqual(
    gone.sort(),
    [...moved, ...RENAMED_SYMBOLS.keys()].sort(),
    'a published symbol answers nowhere in this tree and is named in no roster here',
  );
  // A rename recorded for a name the release never shipped renames nothing.
  for (const [published, local] of RENAMED_SYMBOLS) {
    assert.ok(
      publishedNames.has(published),
      `${published} is recorded as renamed and ${PUBLISHED.version} never published it`,
    );
    assert.ok(
      liveNames.has(local),
      `${published} is recorded as renamed to ${local}, which this tree does not export`,
    );
  }
  assert.equal(moved.length, 22, `${moved.length} symbols left with a subpath`);
  assert.equal(RENAMED_SYMBOLS.size, 2);
});

// ---------------------------------------------------------------------------
// The migration targets
// ---------------------------------------------------------------------------

/**
 * The names one workspace specifier exports, read from the source its `types` entry is emitted
 * from. Sources rather than `dist`, so the answer does not depend on a build having been run —
 * the same reading `readSurface` takes of the lab itself.
 */
function exportsOf(specifier: string): string[] {
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
  const member = readWorkspace(ROOT).get(name);
  assert.ok(member, `${specifier} names ${name}, which is not a package here`);
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const types = (
    JSON.parse(readFileSync(join(member.dir, 'package.json'), 'utf8')) as {
      exports: Record<string, { types?: string }>;
    }
  ).exports[subpath]?.types;
  assert.ok(types, `${name} declares no types target for ${subpath}`);
  const source = join(
    member.dir,
    types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'),
  );
  assert.ok(
    existsSync(source),
    `${specifier}: ${types} is emitted from ${source}, which is not there`,
  );
  return exportedNames(ROOT, source);
}

test('every specifier a moved subpath names exports the symbols it took', () => {
  let examined = 0;
  for (const [subpath, specifier] of MOVED_TO_A_PACKAGE) {
    const answered = exportsOf(specifier);
    for (const name of PUBLISHED.exports[subpath]!) {
      examined += 1;
      assert.ok(
        answered.includes(name),
        `${subpath} published ${name} and ${specifier} does not export it`,
      );
    }
  }
  assert.equal(examined, 24, `resolved ${examined} moved symbols`);
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test('the CHANGELOG names every dropped subpath, symbol and migration target', () => {
  let examined = 0;
  for (const [subpath, specifier] of MOVED_TO_A_PACKAGE) {
    examined += 1;
    assert.ok(
      CHANGELOG.includes(`\`${subpath}\``),
      `${subpath} is gone from the exports map and the CHANGELOG does not name it`,
    );
    assert.ok(
      CHANGELOG.includes(`\`${specifier}\``),
      `${subpath} moved to ${specifier} and the CHANGELOG does not name it`,
    );
    for (const name of PUBLISHED.exports[subpath]!) {
      examined += 1;
      assert.ok(
        CHANGELOG.includes(`\`${name}\``),
        `${name} left with ${subpath} and the CHANGELOG does not name it`,
      );
    }
  }
  for (const [published, local] of [...RENAMED_SUBPATHS, ...RENAMED_SYMBOLS]) {
    examined += 2;
    assert.ok(
      CHANGELOG.includes(`\`${published}\``),
      `${published} was renamed and the CHANGELOG does not name it`,
    );
    assert.ok(
      CHANGELOG.includes(`\`${local}\``),
      `${published} is now ${local} and the CHANGELOG does not name it`,
    );
  }
  assert.equal(examined, 36, `read ${examined} claims`);
});

// ---------------------------------------------------------------------------
// The capture's freshness
// ---------------------------------------------------------------------------

// The only network in this file, and the only thing it decides. Everything above runs against
// the capture with no registry at all; this asks whether the capture is still the release a
// consumer installs. A run that cannot reach the registry says so by name and skips: a network
// check that quietly passes offline certifies nothing, which is the failure this whole file is
// a correction for.
test('the capture is the latest release the registry answers', async (t) => {
  let latest: string;
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${PUBLISHED.package}/latest`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`answered ${response.status}`);
    latest = ((await response.json()) as { version: string }).version;
  } catch (reason) {
    t.skip(
      `the npm registry would not say what ${PUBLISHED.package}@latest is (${(reason as Error).message}); every comparison above ran offline against the ${PUBLISHED.version} capture, and only the capture's freshness is unchecked`,
    );
    return;
  }
  assert.equal(
    latest,
    PUBLISHED.version,
    `the capture is ${PUBLISHED.version} and the registry now answers ${latest}; recapture test/fixtures/lab-published-surface.json and test/fixtures/lab-published-exports.json against it`,
  );
});
