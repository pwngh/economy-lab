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
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

interface Pkg {
  readonly slug: string;
  readonly dir: string;
  /** The npm name, which is what the build loop's plan prints. */
  readonly name: string;
  readonly tests: readonly string[];
  /** The project its own `check` script compiles, or null when it declares none. */
  readonly check: string | null;
}

interface Seen {
  /** Every file the compiler loaded, as `--listFiles` reported it. */
  readonly files: ReadonlySet<string>;
  readonly status: number;
  readonly output: string;
}

/** Every TypeScript file under a directory, at any depth. */
function typescriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The project a `check` script compiles, out of the script itself. */
function checkProjectIn(dir: string): string | null {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = json.scripts?.check;
  if (script === undefined) return null;
  return /tsc\s+-p\s+(\S+)/.exec(script)?.[1] ?? null;
}

const manifestName = (dir: string): string =>
  (
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    }
  ).name;

/** Every package directory that keeps a tsconfig, whether or not it keeps tests. */
const allPackages: Pkg[] = readdirSync(PACKAGES, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() && existsSync(join(PACKAGES, d.name, 'tsconfig.json')),
  )
  .map((d) => ({
    slug: d.name,
    dir: join(PACKAGES, d.name),
    name: manifestName(join(PACKAGES, d.name)),
    tests: typescriptFiles(join(PACKAGES, d.name, 'test')),
    check: checkProjectIn(join(PACKAGES, d.name)),
  }));

const packages: Pkg[] = allPackages.filter((p) => p.tests.length > 0);

// Asking the compiler what it loaded is the only honest check. Reading `include` would pass a
// config whose patterns resolve to nothing, which is the bug this gate exists to catch.
async function listFiles(dir: string, project = '.'): Promise<Seen> {
  const args = [TSC, '-p', project, '--noEmit', '--listFiles'];
  // A compiler that stopped exiting would leave this awaiting a child nobody will reap. It is not
  // a synchronous call, so it does not block the loop, but the ceiling names the package rather
  // than leaving the whole file to the runner's.
  const opts = { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 };
  let status = 0;
  let output: string;
  try {
    output = (await run(process.execPath, args, opts)).stdout;
  } catch (err) {
    const failed = err as { code?: number; stdout?: string };
    status = failed.code ?? 1;
    output = failed.stdout ?? '';
  }
  const lines = output.split('\n').map((line) => line.trim());
  return {
    files: new Set(lines.filter((line) => line.startsWith('/'))),
    status,
    output,
  };
}

// One compile per package, started together and shared by every test below.
const seen = new Map(
  allPackages.map((p) => [p.slug, listFiles(p.dir)] as const),
);

/** The second project a package's own `check` script names, compiled beside the first. */
const checkSeen = new Map(
  allPackages
    .filter((p) => p.check !== null)
    .map((p) => [p.slug, listFiles(p.dir, p.check!)] as const),
);

/**
 * A tsconfig nested inside a package, at any depth below its own. Discovered rather than listed,
 * because a program nobody knows about is exactly what leaves a file uncompiled.
 */
function nestedProjects(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'tsconfig.json' && at !== dir) found.push(at);
    }
  };
  walk(dir);
  return found.sort();
}

const nested = allPackages.flatMap((p) =>
  nestedProjects(p.dir).map((dir) => ({ pkg: p, dir })),
);

const nestedSeen = new Map(
  nested.map((one) => [one.dir, listFiles(one.dir)] as const),
);

// The root program, which is what covers the bench. Started here so it runs beside the rest.
const rootProgram = listFiles(ROOT);

const show = (path: string) => relative(ROOT, path);

/**
 * The bench's two shared roots. A file belongs to the bench when it imports one of them, which is
 * a property of the source and not of the filename: `profile-statements.ts` carries no `bench` in
 * its name, and `bench-queue.ts` reaches only the rig.
 */
const BENCH_ROOTS = ['test/support/harness.ts', 'test/support/rig.ts'] as const;

/**
 * The bench entry points. Each runs standalone against whichever engines it can reach. `scale.ts`
 * is one of them since `Q53` S6: it exits with `process.exit`, `npm run scale` is its only caller,
 * and no `check.ts` row runs it — a probe that reports a curve, not a gate that decides green.
 */
const BENCH_ENTRIES = [
  'scripts/bench-multinode.ts',
  'scripts/bench-queue.ts',
  'scripts/bench-scale.ts',
  'scripts/bench-wire.ts',
  'scripts/bench.ts',
  'scripts/profile-statements.ts',
  'scripts/scale.ts',
] as const;

/**
 * Everything else that reaches a bench root, and why it is not one of the nine. All three live
 * under `test/`, which is where the two roots now live too: `test/` is not a package boundary, so
 * `#src/*` and `#test/*` keep resolving from there and the bench keeps importing them.
 */
const BENCH_READERS = new Map([
  ['test/bench-harness.test.ts', "the harness's own unit suite"],
  [
    'test/env-surface.test.ts',
    'reads BENCH_KEYS, so the env gate sees the names the bench reads',
  ],
  ['test/sharding.test.ts', 'resolves its backend list through the harness'],
]);

const importsRoot = (file: string, root: string): boolean =>
  readFileSync(file, 'utf8').includes(`'#${root}'`);

/**
 * Every unit this gate certifies as typechecked: the sixteen package directories that keep tests,
 * plus the bench. Edited deliberately when a unit is added, because a unit that leaves takes its
 * own discovery with it and every count then falls by one together.
 */
const DECLARED_UNITS = 17;

// A discovery sweep that finds nothing passes every assertion under it. The count is exact and
// reconciled against the whole directory, so a package that stops keeping tests has to be named
// here rather than silently leaving the sweep.
const NO_TEST_DIR = new Map([
  ['create-economy', 'its suite is a root file: test/create-economy.test.ts'],
  [
    'economy',
    'the umbrella is generated door stubs and keeps no suite of its own',
  ],
]);

test('the sweep finds every package that keeps tests', () => {
  const all = readdirSync(PACKAGES, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  );
  assert.equal(
    packages.length,
    16,
    `found ${packages.length} packages with tests: ${packages.map((p) => p.slug).join(', ')}`,
  );
  assert.equal(
    packages.length + NO_TEST_DIR.size,
    all.length,
    `${all.length} package directories, ${packages.length} swept, ${NO_TEST_DIR.size} exempted`,
  );
  // An exemption that stops being true is the drift this gate exists for, so each one fails on
  // both sides: the package must still exist, and must still keep no test directory.
  for (const [slug, why] of NO_TEST_DIR) {
    assert.ok(
      all.some((d) => d.name === slug),
      `${slug} is exempted but is not a package (${why})`,
    );
    assert.ok(
      !existsSync(join(PACKAGES, slug, 'test')),
      `${slug} now keeps tests; delete its exemption (${why})`,
    );
  }
  assert.equal(
    packages.length + 1,
    DECLARED_UNITS,
    `${packages.length} package units plus the bench is not ${DECLARED_UNITS}`,
  );
});

/**
 * A package's own TypeScript: what it ships and what it builds with, minus its emit and its
 * installed dependencies. `templates/` counts — the scaffolder writes those files into a real
 * project, so a template that does not compile is a broken scaffold.
 */
function packageSources(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * The swept files no program loaded. Kept apart from the sweep so it can be shown finding one:
 * every assertion below reports an absence, and a difference that reads nothing reports the same
 * absence.
 */
const unloaded = (
  swept: readonly string[],
  loaded: ReadonlySet<string>,
): string[] => swept.filter((file) => !loaded.has(file));

/**
 * Programs nested inside a package, and the reason nothing in this repository compiles them.
 * Both halves re-earn below: the directory must still keep its own tsconfig, and it must still
 * declare the check that compiles it where it lands.
 */
const NESTED_PROGRAMS = new Map([
  [
    'create-economy/templates/starter',
    'the scaffolder writes it into a new project, and test/create-economy.walk.test.ts runs that project`s own npm run check',
  ],
  [
    'create-economy/templates/marketplace',
    'the same, for the second template the walk scaffolds',
  ],
]);

test('the coverage difference finds a file no program loaded', () => {
  const loaded = new Set(['/pkg/src/index.ts']);
  assert.deepEqual(unloaded(['/pkg/src/index.ts'], loaded), []);
  assert.deepEqual(
    unloaded(['/pkg/src/index.ts', '/pkg/scripts/one.ts'], loaded),
    ['/pkg/scripts/one.ts'],
  );
});

test('every program nested inside a package is admitted, and compiles where it lands', () => {
  const found = nested
    .map((one) => relative(PACKAGES, one.dir).split(sep).join('/'))
    .sort();
  assert.deepEqual(
    found,
    [...NESTED_PROGRAMS.keys()].sort(),
    'a program nested inside a package joined or left the roster',
  );
  for (const [at, why] of NESTED_PROGRAMS) {
    const dir = join(PACKAGES, at);
    assert.ok(
      existsSync(join(dir, 'tsconfig.json')),
      `${at} is admitted and keeps no tsconfig.json of its own (${why})`,
    );
    const scripts = (
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts;
    assert.match(
      scripts?.check ?? '',
      /tsc\s+--noEmit/,
      `${at} no longer compiles itself where it lands, so nothing does (${why})`,
    );
  }
});

test('every TypeScript file under packages/ is loaded by some program', async () => {
  const directories = readdirSync(PACKAGES, { withFileTypes: true }).filter(
    (d) => d.isDirectory(),
  );
  assert.equal(
    allPackages.length,
    directories.length,
    `${directories.length} package directories and ${allPackages.length} keep a tsconfig.json`,
  );

  let swept = 0;
  const missed: string[] = [];
  for (const pkg of allPackages) {
    const loaded = new Set((await seen.get(pkg.slug)!).files);
    const second = checkSeen.get(pkg.slug);
    if (second !== undefined)
      for (const file of (await second).files) loaded.add(file);
    for (const one of nested.filter((each) => each.pkg.slug === pkg.slug)) {
      for (const file of (await nestedSeen.get(one.dir)!).files)
        loaded.add(file);
    }
    const sources = packageSources(pkg.dir);
    // A sweep that reads nothing satisfies the difference below it.
    assert.ok(sources.length > 0, `${pkg.slug}: the sweep read no TypeScript`);
    swept += sources.length;
    missed.push(...unloaded(sources, loaded).map(show));
  }
  assert.deepEqual(
    missed.sort(),
    [],
    `${swept} files swept across ${allPackages.length} packages; no program in this repository loads these`,
  );
});

test('a package declares a check script exactly when its own tsconfig.json leaves a file out', async () => {
  const short: { slug: string; files: string[] }[] = [];
  for (const pkg of allPackages) {
    const own = new Set((await seen.get(pkg.slug)!).files);
    const elsewhere = new Set<string>();
    for (const one of nested.filter((each) => each.pkg.slug === pkg.slug)) {
      for (const file of (await nestedSeen.get(one.dir)!).files) {
        elsewhere.add(file);
      }
    }
    const left = unloaded(packageSources(pkg.dir), own).filter(
      (file) => !elsewhere.has(file),
    );
    if (left.length > 0) short.push({ slug: pkg.slug, files: left.map(show) });
  }
  // Both sides are resolved: what a compiler said it read, against what each package.json says.
  // A file that leaves `tsc -p .` and no second project to catch it fails on the left; a check
  // script kept after its files moved back under tsconfig.json fails on the right.
  assert.deepEqual(
    short.map((one) => one.slug).sort(),
    allPackages
      .filter((pkg) => pkg.check !== null)
      .map((pkg) => pkg.slug)
      .sort(),
    `these packages hold files their own tsconfig.json never reads: ${short
      .map((one) => `${one.slug} (${one.files.join(' ')})`)
      .join('; ')}`,
  );
  for (const one of short) {
    const pkg = allPackages.find((each) => each.slug === one.slug)!;
    const files = new Set((await checkSeen.get(pkg.slug)!).files);
    assert.deepEqual(
      one.files.filter((file) => !files.has(join(ROOT, file))),
      [],
      `${pkg.slug}: its check script compiles ${pkg.check}, which does not read them either`,
    );
  }
});

test('the package build loop plans a check for exactly the packages that declare one', async () => {
  const { stdout } = await run(
    process.execPath,
    ['scripts/build-packages.mjs', '--plan'],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
  const planned = stdout.split('\n').flatMap((line) => {
    const row = /^plan (\S+) build=(yes|no) check=(yes|no)$/.exec(line);
    return row === null
      ? []
      : [{ name: row[1]!, build: row[2] === 'yes', check: row[3] === 'yes' }];
  });
  assert.equal(
    planned.length,
    allPackages.length,
    `the build loop plans ${planned.length} packages and ${allPackages.length} are on disk`,
  );
  assert.deepEqual(
    planned
      .filter((one) => one.check)
      .map((one) => one.name)
      .sort(),
    allPackages
      .filter((pkg) => pkg.check !== null)
      .map((pkg) => pkg.name)
      .sort(),
    'the build loop checks a different set of packages than the set declaring a check script',
  );
  assert.deepEqual(
    planned.filter((one) => !one.build).map((one) => one.name),
    [],
    'the build loop plans no build for these',
  );
  assert.match(
    stdout,
    new RegExp(
      `^build-packages: ${allPackages.length} packages in dependency order, ${allPackages.length} with a build script, ${planned.filter((one) => one.check).length} with a check script$`,
      'm',
    ),
  );
});

test('the bench is one countable unit, and nothing else reaches its harness', () => {
  const swept = [
    ...typescriptFiles(join(ROOT, 'scripts')),
    ...typescriptFiles(join(ROOT, 'test')),
  ];
  // A sweep that reads nothing satisfies every comparison below it, so the count it examined is
  // asserted before the set it found.
  assert.ok(swept.length > 40, `the sweep read ${swept.length} files`);
  const found = swept
    .filter((file) => BENCH_ROOTS.some((root) => importsRoot(file, root)))
    .map(show)
    .sort();
  assert.deepEqual(
    found,
    [...BENCH_ENTRIES, ...BENCH_READERS.keys()].sort(),
    `${swept.length} files swept; the ones importing a bench root are not the ones declared`,
  );
  // Both sides of the roster fall together when a file is deleted, so the size is pinned apart
  // from the lists. A ninth bench file fails the reconciliation above; a missing one fails here.
  assert.equal(
    BENCH_ENTRIES.length + BENCH_ROOTS.length,
    9,
    `the bench declares ${BENCH_ENTRIES.length} entry points over ${BENCH_ROOTS.length} roots`,
  );
  for (const root of BENCH_ROOTS) {
    assert.ok(
      existsSync(join(ROOT, root)),
      `${root} is declared a bench root and is not there`,
    );
    assert.ok(
      BENCH_ENTRIES.some((entry) => importsRoot(join(ROOT, entry), root)),
      `no bench entry point imports ${root}, so it is not a bench root`,
    );
  }
  for (const [file, why] of BENCH_READERS) {
    assert.ok(
      existsSync(join(ROOT, file)),
      `${file} is admitted as a non-bench reader and is not there (${why})`,
    );
  }
});

/**
 * Entry points a scheduled workflow executes. Typechecking is the half a compiler can see; four
 * entries sat counted-but-never-run from their adjudications until `Q108`, and a broken query or
 * dead engine path in an unexecuted file survives indefinitely. The nightly runs these through
 * their npm scripts at the fast profile — the soak's own thorough rounds stay the numbers run;
 * these rounds answer "does the instrument still run", which reachability does not price.
 */
const CADENCED = [
  'scripts/bench-multinode.ts',
  'scripts/bench-scale.ts',
  'scripts/bench-wire.ts',
  'scripts/bench.ts',
  'scripts/profile-statements.ts',
] as const;

/**
 * Entry points only a human runs, each with the reason a cadence buys nothing. An entry in
 * neither roster fails the partition below.
 */
const MANUAL_ONLY = new Map([
  [
    'scripts/bench-queue.ts',
    'the attended sequential-session runner; its stamped bench-results/ dirs and canary ' +
      'baseline compare are for hours-long runs on one machine',
  ],
  [
    'scripts/scale.ts',
    'a multi-minute per-subject growth probe, run attended (`npm run scale`, `make scale`)',
  ],
]);

test('every bench entry point has a caller, and the cadence rosters are exact', () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const workflowDir = join(ROOT, '.github', 'workflows');
  const workflows = readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => readFileSync(join(workflowDir, name), 'utf8'));
  assert.equal(workflows.length, 4, `read ${workflows.length} workflows`);

  // The one spelling humans and workflows share. A workflow or compose line naming the raw path
  // also counts as a caller, because compose's bench service does exactly that.
  const scriptsFor = (entry: string): string[] =>
    Object.entries(manifest.scripts)
      .filter(([, command]) => command.includes(entry))
      .map(([name]) => name);
  const uncalled = BENCH_ENTRIES.filter(
    (entry) =>
      scriptsFor(entry).length === 0 &&
      !compose.includes(entry) &&
      !workflows.some((text) => text.includes(entry)),
  );
  assert.deepEqual(
    uncalled,
    [],
    `${BENCH_ENTRIES.length} entry points examined; these are named by no npm script, no workflow and no compose service`,
  );

  // A `- run:` line invokes a script when it says `npm run <name>` exactly — the token match is
  // what keeps `npm run bench` from claiming `bench:queue`, the substring trap `Q160` recorded.
  const invoked = (text: string): Set<string> =>
    new Set(
      text
        .split('\n')
        .filter((line) => /^\s*- run: /.test(line))
        .flatMap((line) =>
          [...line.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]!),
        ),
    );
  const scheduled = workflows.filter((text) => /^\s+schedule:$/m.test(text));
  assert.equal(scheduled.length, 1, 'the nightly soak is the one cron here');
  const hasCadence = (entry: string): boolean =>
    scheduled.some((text) => {
      const names = invoked(text);
      return (
        scriptsFor(entry).some((name) => names.has(name)) ||
        text.includes(entry)
      );
    });

  const cadenced = BENCH_ENTRIES.filter(hasCadence).sort();
  assert.deepEqual(
    cadenced,
    [...CADENCED].sort(),
    'the entries a scheduled workflow reaches are not the ones declared',
  );
  const manual = BENCH_ENTRIES.filter((entry) => !hasCadence(entry)).sort();
  assert.deepEqual(
    manual,
    [...MANUAL_ONLY.keys()].sort(),
    'an entry left both rosters, or joined the cron without being declared',
  );
  assert.equal(
    cadenced.length + manual.length,
    BENCH_ENTRIES.length,
    'the two rosters must partition every entry point',
  );
  for (const [entry, why] of MANUAL_ONLY) {
    assert.ok(
      existsSync(join(ROOT, entry)),
      `${entry} is admitted manual-only and is not there (${why})`,
    );
  }
});

test('the bench typechecks, and the root program is what covers it', async () => {
  // The bench keeps no tsconfig of its own: the root program's `include` reaches scripts/, and a
  // separate program would prove nothing extra, since the bench imports #src/* and #test/support/*
  // and any program that reads it pulls both in. The day bench/ exists, that stops being true —
  // point the roster at its tsconfig and read that program instead of this one.
  assert.ok(
    !existsSync(join(ROOT, 'bench')),
    'bench/ exists now; this unit is no longer covered by the root program',
  );
  const { files, status, output } = await rootProgram;
  assert.ok(files.size > 0, `tsc -p . listed no files at all\n${output}`);
  const unread = [...BENCH_ENTRIES, ...BENCH_ROOTS]
    .filter((file) => !files.has(join(ROOT, file)))
    .map((file) => file);
  assert.deepEqual(
    unread,
    [],
    `tsc -p . never reads ${unread.length} of the bench's 9 files`,
  );
  const errors = output
    .split('\n')
    .filter((line) => line.includes('error TS'))
    .join('\n');
  assert.equal(status, 0, `tsc -p . failed at the repository root\n${errors}`);
});

for (const pkg of packages) {
  // `tsc -p .` is the gate each package's README names, and it reads tsconfig.json alone. A
  // build-only `include` leaves the tests unchecked, and tsx strips their types without reading.
  test(`${pkg.slug}: tsconfig.json covers its own tests`, async () => {
    const { files, output } = await seen.get(pkg.slug)!;
    assert.ok(
      files.size > 0,
      `${pkg.slug}: tsc listed no files at all\n${output}`,
    );
    const missing = pkg.tests.filter((file) => !files.has(file)).map(show);
    assert.deepEqual(
      missing,
      [],
      `${pkg.slug}: npx tsc --noEmit never reads ${missing.length} of its ${pkg.tests.length} test files`,
    );
  });
}

for (const pkg of packages) {
  // Nothing else type-checks these files: the root tsconfig stops at the repo's own src and
  // test, and every package runs its tests through tsx, which strips types without checking.
  test(`${pkg.slug}: its tests type-check clean`, async () => {
    const { status, output } = await seen.get(pkg.slug)!;
    const errors = output
      .split('\n')
      .filter((line) => line.includes('error TS'))
      .join('\n');
    assert.equal(
      status,
      0,
      `${pkg.slug}: npx tsc --noEmit failed in packages/${pkg.slug}\n${errors}`,
    );
  });
}
