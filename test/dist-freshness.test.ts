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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type BuildUnit,
  assertFresh,
  buildUnits,
  checkBuilds,
  checkUnits,
  tsconfigOf,
} from '#scripts/check-dist-fresh.ts';
import { publishedSpecifiers } from '#scripts/support/dist-reach.ts';
import { readWorkspace } from '#scripts/support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const workspace = readWorkspace(ROOT);

const EMITTED = ['.js', '.d.ts'];

/**
 * The build outputs under a directory, walked here rather than imported so the count this gate
 * rests on and the count the checker reports come from two separate readings of the disk.
 */
function outputsUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...outputsUnder(path));
    else if (EMITTED.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

const built: string[] = [];

/**
 * A directory holding one built package: sources, the emit named in `outputs`, and timestamps a
 * finished build would leave — sources two minutes old, outputs one. A source with no output
 * named here has not been built.
 */
function fixture(files: {
  readonly sources: readonly string[];
  readonly outputs: readonly string[];
}): { dir: string; unit: BuildUnit } {
  const dir = mkdtempSync(join(tmpdir(), 'economy-freshness-'));
  built.push(dir);
  const write = (path: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), 'export {};\n');
  };
  const now = Date.now() / 1000;
  for (const source of files.sources) {
    write(`src/${source}`);
    utimesSync(join(dir, 'src', source), now - 120, now - 120);
  }
  for (const output of files.outputs) {
    write(`dist/${output}`);
    utimesSync(join(dir, 'dist', output), now - 60, now - 60);
  }
  return {
    dir,
    unit: {
      name: '@fixture/built',
      dir,
      roots: [{ sources: 'src', outputs: 'dist', closureOnly: false }],
      command: 'npm run build -w @fixture/built',
    },
  };
}

const refusal = (unit: BuildUnit, dir: string): string => {
  try {
    assertFresh(checkUnits([unit], dir), 'the fixture');
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

const listed = (
  stale: readonly { output: string; source: string; reason: string }[],
): string[] =>
  stale.map((each) => `${each.reason} ${each.output} <- ${each.source}`).sort();

test('the roster is the lab plus every workspace member that builds', () => {
  const units = buildUnits(ROOT);
  const building = [...workspace.values()].filter(
    (member) => member.json.scripts?.build !== undefined,
  );
  assert.deepEqual(
    units.map((unit) => unit.name).sort(),
    ['@pwngh/economy-lab', ...building.map((member) => member.name)].sort(),
  );
  assert.equal(units.length, 19, `read ${units.length} build units`);
  assert.equal(building.length, workspace.size);
  for (const unit of units) {
    assert.ok(
      unit.command.length > 0,
      `${unit.name} names no command that rebuilds it`,
    );
    assert.ok(unit.roots.length > 0, `${unit.name} declares no source root`);
  }
});

// Two independent walks of the same directories. The count is the thing this whole gate rests
// on, so it is compared against one taken without the checker.
test('every build output on disk is one the checker read', () => {
  const report = checkBuilds(ROOT);
  const units = new Map(buildUnits(ROOT).map((unit) => [unit.name, unit]));
  let outputs = 0;
  let compared = 0;
  for (const unit of report.units) {
    for (const root of unit.roots) {
      const here = outputsUnder(join(units.get(unit.name)!.dir, root.outputs));
      assert.equal(
        root.outputCount,
        here.length,
        `${unit.name}: ${root.outputs} holds ${here.length} build outputs and the checker saw ${root.outputCount}`,
      );
      assert.ok(
        root.sourceCount > 0,
        `${unit.name}: nothing to compile under ${root.sources}`,
      );
      assert.ok(
        root.compared > 0,
        `${unit.name}: dated no build output under ${root.outputs}`,
      );
      assert.equal(
        root.compared + root.orphaned,
        root.outputCount,
        `${unit.name}: ${root.outputs} holds outputs that were neither dated nor named as left over`,
      );
      outputs += here.length;
      compared += root.compared;
    }
  }
  const orphans = report.stale.filter((each) => each.reason === 'orphan');
  assert.equal(report.comparedOutputs.size, compared);
  assert.equal(compared + orphans.length, outputs);
});

/**
 * Installed from outside this repository, so no build here produces it. `economy-edge` is dated
 * against its own source by `test/adapters/edge-dist.test.ts`, which skips when the installed
 * copy is a published tarball carrying no `src/`.
 */
const OUTSIDE = new Map([
  [
    '@pwngh/economy-edge',
    'an installed dependency; test/adapters/edge-dist.test.ts dates it',
  ],
  [
    '@pwngh/taskq',
    'the sibling task queue, an optional peer this suite loads through await import() and skips by name when it is absent',
  ],
]);

const packageOf = (specifier: string): string =>
  specifier.split('/').slice(0, 2).join('/');

/**
 * Every published specifier the root suite loads, and the files that load it. The rule for what
 * "loads" means is `publishedSpecifiers`, stated once for every reader of that question in the
 * tree — this one was a second copy of it, blind to `await import(…)`, until `Q366`.
 */
function loaded(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(join(ROOT, 'test'), {
    recursive: true,
    encoding: 'utf8',
  })) {
    if (!file.endsWith('.ts')) continue;
    for (const specifier of publishedSpecifiers(
      readFileSync(join(ROOT, 'test', file), 'utf8'),
    )) {
      found.set(specifier, [...(found.get(specifier) ?? []), file]);
    }
  }
  return found;
}

/**
 * What one reading of the specifiers above found. Split apart on purpose: a specifier that does
 * not resolve, one that resolves to a file no build unit here produced, and one whose emit the
 * freshness checker could not date are three different facts, and a count is none of them.
 */
interface Population {
  /** Specifiers examined, sorted — the roster the counts below are taken over. */
  readonly examined: readonly string[];
  readonly exempted: readonly string[];
  /** `specifier — what resolution said`, for a specifier that resolves to nothing at all. */
  readonly unresolvable: readonly string[];
  /** A specifier that resolved outside every build unit in this repository. */
  readonly stray: readonly string[];
  /** A specifier inside a unit whose output the checker did not date. */
  readonly undated: readonly string[];
  /** The build units the examined specifiers land in. */
  readonly consumed: Set<string>;
}

/**
 * The population, built with the given resolver so a resolution failure can be driven from a
 * test rather than waited for. `Q382`: an emit that cannot be read used to arrive here as a
 * smaller count, which reads exactly like an import somebody deleted.
 */
function population(
  resolve: (specifier: string) => string,
  report = checkBuilds(ROOT),
): Population {
  const units = new Map(buildUnits(ROOT).map((unit) => [unit.name, unit]));
  const examined: string[] = [];
  const exempted: string[] = [];
  const unresolvable: string[] = [];
  const stray: string[] = [];
  const undated: string[] = [];
  const consumed = new Set<string>();

  for (const [specifier, files] of loaded()) {
    let at: string | null = null;
    try {
      at = resolve(specifier);
    } catch (missing) {
      // Named, not dropped. A specifier that stopped resolving and a specifier nothing imports
      // any more both make a roster one shorter, and only one of them is a defect here.
      unresolvable.push(
        `${specifier} — ${(missing as Error).message.split('\n')[0]}, imported by ${files.join(', ')}`,
      );
      continue;
    }
    if (OUTSIDE.has(packageOf(specifier))) {
      exempted.push(specifier);
      if (at.includes('/node_modules/')) continue;
      stray.push(
        `${specifier} is exempted as ${OUTSIDE.get(packageOf(specifier))!}, and it loads ${at} inside this tree after all`,
      );
      continue;
    }
    examined.push(specifier);
    // Longest directory first: every package sits inside the lab, so the lab matches them all.
    const unit = [...units.values()]
      .sort((a, b) => b.dir.length - a.dir.length)
      .find((each) => !relative(each.dir, at!).startsWith('..'));
    if (unit === undefined) {
      stray.push(
        `${specifier} loads ${at}, which no build unit here produced — imported by ${files.join(', ')}`,
      );
      continue;
    }
    consumed.add(unit.name);
    if (!report.comparedOutputs.has(at)) {
      undated.push(
        `${specifier} loads ${at}, inside ${unit.name}, and the freshness checker did not date it — its emit is unreadable, which is not the same as an import going away`,
      );
    }
  }
  return {
    examined: examined.sort(),
    exempted: exempted.sort(),
    unresolvable,
    stray,
    undated,
    consumed,
  };
}

/**
 * Every published specifier this suite loads, exactly. A count alone made two very different
 * events read the same — an emit that could not be read, and a file that stopped importing
 * something — and cost real diagnosis time twice on 2026-07-31. The roster names which.
 */
const LOADED = [
  '@pwngh/economy-conformance',
  '@pwngh/economy-conformance/internal',
  '@pwngh/economy-core',
  '@pwngh/economy-lab/adapters',
  '@pwngh/economy-lab/sql-kit',
  '@pwngh/economy-lab/store-kit',
  '@pwngh/economy-money',
  '@pwngh/economy-mysql',
  '@pwngh/economy-mysql/mariadb',
  '@pwngh/economy-postgres',
  '@pwngh/economy-postgres/driver',
  '@pwngh/economy-redis',
  '@pwngh/economy-sqs',
  '@pwngh/economy-webhook',
  '@pwngh/economy/mysql',
  '@pwngh/economy/postgres',
];

// This suite is a dist consumer too: 30-odd of its files reach the four backend packages and
// the lab's own emit through their exports maps. Those files describe whatever was last built,
// so the freshness of exactly those units is asserted here — and no others, because everything
// else in this suite reads `#src/*` and cannot go stale.
//
// The umbrella is on the roster for a reason worth stating, because it is not imported by any file
// under test/: `test/acceptance/rigs.test.ts` writes `@pwngh/economy/postgres` and
// `@pwngh/economy/mysql` into a scaffolded project's module and then boots it, so a stale
// packages/economy emit fails that suite at one remove. The reader below matches those specifiers
// in that module source, which is the honest answer rather than a false positive.
test('every published specifier this suite loads was built from the source beside it', () => {
  const report = checkBuilds(ROOT);
  const require = createRequire(join(ROOT, 'package.json'));
  const read = population((specifier) => require.resolve(specifier), report);

  // Each named before the counts, because each is a different thing to go and do, and because a
  // count that moved for one of these reasons reads as an import somebody deleted.
  assert.deepEqual(read.unresolvable, []);
  assert.deepEqual(read.undated, []);
  assert.deepEqual(read.stray, []);

  assert.deepEqual(
    read.examined,
    LOADED,
    'the specifiers this suite loads changed',
  );
  assert.equal(read.exempted.length, 4);
  assert.deepEqual(
    [...read.consumed].sort(),
    [
      '@pwngh/economy',
      '@pwngh/economy-conformance',
      '@pwngh/economy-core',
      '@pwngh/economy-lab',
      '@pwngh/economy-money',
      '@pwngh/economy-mysql',
      '@pwngh/economy-postgres',
      '@pwngh/economy-redis',
      '@pwngh/economy-sqs',
      '@pwngh/economy-webhook',
    ],
    'the units this suite loads changed',
  );
  assert.deepEqual(
    report.stale
      .filter((each) => read.consumed.has(each.unit))
      .map((each) => `${each.output} (${each.reason}) — fix: ${each.command}`),
    [],
  );
});

// The failure this pin used to wear the costume of. An emit that cannot be read leaves its
// specifier unresolvable, which took a specifier quietly out of the population and printed a
// smaller number — the same number a deleted import prints.
test('a specifier that does not resolve is named, not left out of the count', () => {
  const require = createRequire(join(ROOT, 'package.json'));
  const gone = '@pwngh/economy-postgres';
  const read = population((specifier) => {
    if (specifier === gone) {
      throw new Error(`Cannot find package '${gone}' imported from here`);
    }
    return require.resolve(specifier);
  });
  assert.equal(read.unresolvable.length, 1);
  assert.match(
    read.unresolvable[0]!,
    /^@pwngh\/economy-postgres — Cannot find/,
  );
  assert.match(read.unresolvable[0]!, /imported by .+\.ts/);
  // And the roster it left is short by exactly it, rather than by an unknown amount.
  assert.deepEqual(
    read.examined,
    LOADED.filter((specifier) => specifier !== gone),
  );
});

// The lab compiles only what it publishes, so there is no root whose sources may go unemitted.
// The exemption that used to sit here covered test/support, copied into the lab's compile for the
// conformance suite to import; that suite is @pwngh/economy-conformance now and builds itself.
test('no build root is exempt from emitting, because none is copied in for a closure', () => {
  const lab = buildUnits(ROOT)[0]!;
  assert.deepEqual(
    lab.roots.filter((root) => root.closureOnly).map((root) => root.sources),
    [],
  );
  assert.ok(lab.roots.length > 0, 'the lab declares no build roots at all');
});

test('an output older than its source is refused, by path and with the command', () => {
  const { dir, unit } = fixture({
    sources: ['index.ts'],
    outputs: ['index.js', 'index.d.ts'],
  });
  assert.deepEqual(checkUnits([unit], dir).stale, []);

  const now = Date.now() / 1000;
  utimesSync(join(dir, 'src/index.ts'), now, now);
  const stale = checkUnits([unit], dir).stale;
  assert.deepEqual(listed(stale), [
    'older dist/index.d.ts <- src/index.ts',
    'older dist/index.js <- src/index.ts',
  ]);
  assert.ok(stale[0]!.lagMs >= 60_000, `lag was ${stale[0]!.lagMs}ms`);
  const message = refusal(unit, dir);
  assert.match(
    message,
    /dist\/index\.js is \d+[a-z]+ older than src\/index\.ts/,
  );
  assert.match(message, /fix: npm run build -w @fixture\/built/);
});

test('a source that was never built is refused as a missing output', () => {
  const { dir, unit } = fixture({
    sources: ['index.ts', 'later.ts'],
    outputs: ['index.js', 'index.d.ts'],
  });
  assert.deepEqual(listed(checkUnits([unit], dir).stale), [
    'missing dist/later.d.ts <- src/later.ts',
    'missing dist/later.js <- src/later.ts',
  ]);
  assert.match(
    refusal(unit, dir),
    /dist\/later\.js was never built from src\/later\.ts/,
  );
});

test('an output whose source is gone is refused as left over', () => {
  const { dir, unit } = fixture({
    sources: ['index.ts'],
    outputs: ['index.js', 'index.d.ts', 'deleted.js'],
  });
  assert.deepEqual(listed(checkUnits([unit], dir).stale), [
    'orphan dist/deleted.js <- src/deleted',
  ]);
  assert.match(
    refusal(unit, dir),
    /dist\/deleted\.js is left over: there is no source at src\/deleted/,
  );
});

// The refusal this gate exists for. A check that reads nothing reports what a fresh build
// reports, which is the failure it was written to end.
test('a unit with nothing built is refused for having read no files', () => {
  const { dir, unit } = fixture({ sources: ['index.ts'], outputs: [] });
  const message = refusal(unit, dir);
  assert.match(message, /nothing built under dist/);
  assert.match(message, /fix: npm run build -w @fixture\/built/);
  assert.match(message, /reads no files reports the same success/);
});

test('a unit with nothing to compile is refused before it is dated', () => {
  const { dir, unit } = fixture({ sources: [], outputs: ['stray.js'] });
  assert.match(refusal(unit, dir), /nothing to compile under src/);
});

// An output the walk counts and the dating cannot read leaves the two sides disagreeing, and
// every count here rests on them agreeing.
test('an output that cannot be dated is refused, not quietly dropped', () => {
  const { dir, unit } = fixture({
    sources: ['index.ts', 'broken.ts'],
    outputs: ['index.js', 'index.d.ts', 'broken.d.ts'],
  });
  symlinkSync(join(dir, 'dist/gone.js'), join(dir, 'dist/broken.js'));
  const measured = checkUnits([unit], dir).units[0]!.roots[0]!;
  assert.deepEqual(
    [measured.outputCount, measured.compared, measured.orphaned],
    [4, 3, 0],
  );
  assert.match(
    refusal(unit, dir),
    /4 build outputs under dist, but 3 dated and 0 named as left over/,
  );
});

test('a build script it cannot read is refused rather than guessed at', () => {
  assert.equal(
    tsconfigOf('rm -rf dist && tsc -p tsconfig.build.json'),
    'tsconfig.build.json',
  );
  assert.equal(tsconfigOf('tsc -p .'), 'tsconfig.json');
  assert.equal(tsconfigOf('rollup -c'), null);
  assert.equal(tsconfigOf('tsc -p'), null);

  const dir = mkdtempSync(join(tmpdir(), 'economy-freshness-'));
  built.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'lab', scripts: { build: 'node build.mjs' } }),
  );
  writeFileSync(
    join(dir, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: { rootDir: '.build-tmp', outDir: 'dist' },
      include: ['.build-tmp/src/**/*.ts'],
    }),
  );
  mkdirSync(join(dir, 'packages/rolled'), { recursive: true });
  writeFileSync(
    join(dir, 'packages/rolled/package.json'),
    JSON.stringify({
      name: '@fixture/rolled',
      scripts: { build: 'rollup -c' },
    }),
  );
  assert.throws(
    () => buildUnits(dir),
    /cannot read where @fixture\/rolled puts its emit/,
  );
});

test('all seven fixtures were written outside the repository, and are gone', () => {
  assert.equal(built.length, 7);
  for (const dir of built) {
    assert.ok(dir.startsWith(tmpdir()), `${dir} is not a throwaway directory`);
    rmSync(dir, { recursive: true, force: true });
    assert.ok(!existsSync(dir), `${dir} outlived the test that made it`);
  }
});
