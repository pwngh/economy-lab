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
 * Holds the one property that stops a test hanging where it should fail: every wait has a ceiling.
 *
 * `node --test` has no default timeout. A test that waits on a row lock, a child process or a
 * socket therefore runs forever, and a run that never ends reports nothing — the same end state as
 * a gate that passes while examining nothing, except that CI blames its own job clock instead of
 * naming the file. Two instances were found on one day, each only because a mutation happened to
 * trigger it, which is why this is a roster and not two fixes.
 *
 * Two layers, and this file holds both:
 *
 *   - The backstop. Every `node --test` in the repository passes `--test-timeout`, so a file
 *     nobody has audited — including one written tomorrow — is bounded by the runner rather than
 *     by whoever remembered. It bounds the FILE, cumulatively across its tests, and the parent
 *     runner enforces it, so it kills a child stuck inside a synchronous call as well.
 *   - The ceilings at the call sites that genuinely wait. The backstop is deliberately generous
 *     and is therefore not what catches a wedge quickly: a `spawnSync` with no `timeout` of its
 *     own burns the whole file budget and takes every other test in the file with it.
 *
 * A bound above the file bound is fiction — the file is cancelled first and the larger number
 * never applies — so that ordering is asserted too.
 *
 * The last three tests spawn a real runner over a file that genuinely hangs, both ways it can, and
 * one that is left unbounded to show what is being replaced. A timeout nobody has watched fire is
 * exactly the untested guarantee this file exists to refuse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEPS, TEST_TIMEOUT_MS } from '#scripts/check.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOUND = `--test-timeout=${TEST_TIMEOUT_MS}`;

// This file's own children, bounded for the reason everything below is bounded.
const CHILD_BOUND_MS = 60_000;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Every `*.ts`/`*.tsx` under a directory, at any depth, root-relative and sorted. */
function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourcesUnder(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/** Every test source this repository owns: the root suite plus each package's own. */
function testSources(): string[] {
  const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/test`)
    .filter((dir) => existsDir(dir));
  return [...sourcesUnder('test'), ...packages.flatMap(sourcesUnder)].sort();
}

function existsDir(dir: string): boolean {
  try {
    readdirSync(join(ROOT, dir));
    return true;
  } catch {
    return false;
  }
}

/** Every `package.json` the tree owns: the root, each workspace member, each template. */
function manifests(): string[] {
  const found = ['package.json'];
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const next = `${dir}/${entry.name}`;
      if (existsDir(next) && hasManifest(next))
        found.push(`${next}/package.json`);
      if (depth > 0) walk(next, depth - 1);
    }
  };
  walk('packages', 2);
  return found.sort();
}

function hasManifest(dir: string): boolean {
  try {
    readFileSync(join(ROOT, dir, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The argument list of the call whose opening parenthesis follows `from`, read by counting
 * parentheses. A regex cannot do this: these calls span lines and nest objects.
 */
function callArguments(source: string, from: number): string {
  const open = source.indexOf('(', from);
  assert.notEqual(open, -1, 'a call site with no argument list');
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '(') depth += 1;
    else if (source[at] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, at);
    }
  }
  return assert.fail('a call site whose argument list never closes');
}

/** Where `at` falls in `source`, as a 1-based line number. */
const lineOf = (source: string, at: number): number =>
  source.slice(0, at).split('\n').length;

// --- The backstop -------------------------------------------------------------------

test('every node --test the step table runs carries the file bound', () => {
  const runners = STEPS.filter((step) => step.run.includes('--test'));
  for (const step of runners) {
    assert.ok(
      step.run.includes(BOUND),
      `check step "${step.id}" runs node --test with no ${BOUND}`,
    );
    // Before `--test`, or node reads it as a path to run rather than as its own flag.
    assert.ok(
      step.run.indexOf(BOUND) < step.run.indexOf('--test'),
      `check step "${step.id}" passes ${BOUND} after --test, where node takes it for a path`,
    );
  }
  assert.equal(
    runners.length,
    10,
    'the table runs a different number of suites',
  );
});

// A script string that invokes the runner. Kept as one reader so the sample below is the same
// pattern the sweep uses, not a second one written to agree with it.
const NODE_TEST = /(^|\s)node\s.*\s--test(\s|$)/;

test('every test script in the tree carries the file bound', () => {
  // The reader, turned on a sample carrying the fault first: one that stopped matching returns an
  // empty roster and passes every assertion below it.
  assert.match('node --import tsx --test test/*.test.ts', NODE_TEST);

  const found = manifests();
  const invocations: string[] = [];
  for (const path of found) {
    const scripts = (
      JSON.parse(read(path)) as { scripts?: Record<string, string> }
    ).scripts;
    for (const [name, script] of Object.entries(scripts ?? {})) {
      if (!NODE_TEST.test(script)) continue;
      invocations.push(`${path}#${name}`);
      assert.ok(
        script.includes(BOUND),
        `${path} "${name}" runs node --test with no ${BOUND}: ${script}`,
      );
      assert.ok(
        script.indexOf(BOUND) < script.search(/\s--test(\s|$)/),
        `${path} "${name}" passes ${BOUND} after --test, where node takes it for a path`,
      );
    }
  }
  assert.equal(found.length, 20, `read ${found.length} package manifests`);
  assert.equal(
    invocations.length,
    20,
    `examined ${invocations.length} node --test invocations in package scripts`,
  );
});

/**
 * The scripts that spell `node --test` in their own argv rather than in a package script. Named,
 * so a fourth one is a deliberate edit here rather than a hole nothing reads. `check.ts` builds
 * the flag from `TEST_TIMEOUT_MS`, and the test above resolves what it actually passes.
 */
const SPAWNING_SCRIPTS = [
  'scripts/check.ts',
  'scripts/publish-packages.mjs',
  'scripts/suite.mjs',
];

test('every node --test a script spawns carries the file bound', () => {
  const spawning = readdirSync(join(ROOT, 'scripts'))
    .filter((name) => /\.(mjs|ts)$/.test(name))
    .map((name) => `scripts/${name}`)
    .filter((path) => read(path).includes(`'--test'`));
  assert.deepEqual(spawning, SPAWNING_SCRIPTS);
  for (const path of spawning) {
    const source = read(path);
    assert.equal(
      (source.match(/'--test'/g) ?? []).length,
      1,
      `${path} spells --test more than once, so one bound cannot answer for both`,
    );
    const bound = source.indexOf('--test-timeout=');
    assert.notEqual(bound, -1, `${path} spawns node --test with no bound`);
    assert.ok(
      bound < source.indexOf(`'--test'`),
      `${path} passes its bound after --test, where node takes it for a path`,
    );
  }
});

// --- The ceilings at the call sites ---------------------------------------------------

// Split, so this file's own source does not carry the token the sweep looks for and count itself
// a violation. The same reason `hostile.test.ts` joins its sample at run time.
const SYNC_CALL_SOURCE = `\\b(spawn${'Sync'}|execFile${'Sync'}|exec${'Sync'})\\s*\\(`;

test('every synchronous child-process call in a test carries its own bound', () => {
  // The pattern, turned on a sample carrying the fault. Built the same way, for the same reason.
  assert.match(
    `const r = spawn${'Sync'}(cmd, args, { cwd });`,
    new RegExp(SYNC_CALL_SOURCE),
  );

  const sites: string[] = [];
  for (const path of testSources()) {
    const source = read(path);
    for (const found of source.matchAll(new RegExp(SYNC_CALL_SOURCE, 'g'))) {
      const args = callArguments(source, found.index);
      sites.push(path);
      assert.match(
        args,
        /\btimeout:/,
        `${path}:${lineOf(source, found.index)} calls ${found[1]} with no timeout — it blocks the event loop, so nothing inside the file can bound it`,
      );
    }
  }
  assert.deepEqual(sites, SYNC_CALL_SITES);
});

/**
 * Every file that makes a synchronous child-process call, once per call. Files rather than lines:
 * a line number moves whenever anything above it does, and a roster that reds on an unrelated edit
 * gets loosened rather than read. The failure message still names the line.
 */
const SYNC_CALL_SITES = [
  'packages/adapters/test/matrix.test.ts',
  // Twice: the strip-types recovery run, and the taken-port refusal under a Deno stand-in.
  'packages/cli/test/dev-serve.test.ts',
  'packages/cli/test/dev-serve.test.ts',
  'packages/cli/test/support/process.ts',
  'packages/ui/test/invocation.test.tsx',
  'test/acceptance/harness.ts',
  'test/bin-mode.test.ts',
  'test/clients-contract.test.ts',
  // Twice: the connect-or-skip child, and the port-coverage recorder.
  'test/conformance-contract.test.ts',
  'test/conformance-contract.test.ts',
  'test/counted-reporter.test.ts',
  'test/create-economy.test.ts',
  'test/dist-reach.test.ts',
  'test/economy.close.test.ts',
  'test/generate-economy.test.ts',
  'test/hang-bounds.test.ts',
  'test/numbered-reporter.test.ts',
  'test/package-loop-fresh.test.ts',
  'test/package-test-typechecks.test.ts',
  'test/publishing.test.ts',
  'test/workspace-tests.test.ts',
];

/** A bound the sweep reads but cannot resolve to a number. Named, never waved past. */
const UNRESOLVED_BOUNDS = [
  'test/economy.close.test.ts timeoutMs',
  'test/engine-open.test.ts DEFAULT_CONNECT_TIMEOUT_MS * 3',
  'test/hang-bounds.test.ts killAfterMs',
];

const CONSTANT = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([\d_]+)\s*;/g;

/** Every `#test/...` module a source imports from, as a repo-relative path. */
function imported(source: string): string[] {
  return [...source.matchAll(/from '#(test\/[^']+)'/g)].map(
    (found) => found[1]!,
  );
}

/** The numeric constants a source declares, by name. */
function constantsIn(source: string, into: Map<string, number>): void {
  for (const found of source.matchAll(CONSTANT)) {
    into.set(found[1]!, Number(found[2]!.replaceAll('_', '')));
  }
}

test('no bound inside a test outlives the file bound that cancels the file first', () => {
  let examined = 0;
  let resolved = 0;
  const unresolved: string[] = [];
  for (const path of testSources()) {
    const source = read(path);
    // Numeric constants this file can see, so `timeout: LEG_BOUND_MS` resolves to a number rather
    // than being waved past as an expression nobody read. Same-file was enough while every bound
    // was written beside its call; a shared harness moves the declaration one file away, and a
    // resolver that reads only the file in front of it answers "unresolved" for a bound that is
    // written down plainly — which is how a roster of exemptions grows until nothing is checked.
    // Resolution follows the imports rather than sweeping the tree by name: `RUNS` and `NOW` are
    // each declared with different values in different suites, and a name-keyed map would answer
    // for whichever file it read last.
    const constants = new Map<string, number>();
    for (const from of imported(source)) constantsIn(read(from), constants);
    constantsIn(source, constants);
    // Key position only. The word also appears inside failure messages and comments, and a sweep
    // that counted those would report bounds nobody wrote.
    for (const found of source.matchAll(/[{,]\s*timeout:\s*([^,\n}]+)/g)) {
      examined += 1;
      const written = found[1]!.trim();
      const value = /^[\d_]+$/.test(written)
        ? Number(written.replaceAll('_', ''))
        : constants.get(written);
      if (value === undefined) {
        unresolved.push(`${path} ${written}`);
        continue;
      }
      resolved += 1;
      assert.ok(
        value <= TEST_TIMEOUT_MS,
        `${path}:${lineOf(source, found.index)} allows ${value}ms, past the ${TEST_TIMEOUT_MS}ms file bound that cancels the file first`,
      );
    }
  }
  assert.deepEqual(unresolved, UNRESOLVED_BOUNDS);
  assert.equal(examined, 38, `examined ${examined} declared bounds`);
  assert.equal(resolved, examined - unresolved.length);
});

// --- The bound, fired -----------------------------------------------------------------

interface Ran {
  readonly took: number;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly out: string;
}

/** Runs `source` as a test file under a real runner, and reports what the runner said. */
function runSubject(
  source: string,
  args: readonly string[],
  killAfterMs: number,
): Ran {
  const dir = mkdtempSync(join(tmpdir(), 'economy-hang-'));
  try {
    const file = join(dir, 'subject.test.mjs');
    writeFileSync(file, source);
    const env = { ...process.env };
    // node --test leaks this to children, and a child that inherits it reports to a parent that
    // is not listening and exits 0 whatever its tests did. Deleted, never blanked.
    delete env.NODE_TEST_CONTEXT;
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [...args, file], {
      encoding: 'utf8',
      env,
      timeout: killAfterMs,
    });
    return {
      took: Date.now() - startedAt,
      status: run.status,
      signal: run.signal,
      out: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The timer is not decoration. A promise nobody settles while the event loop has nothing else to
// do is detected by node in milliseconds — "Promise resolution is still pending but the event loop
// has already resolved" — so it is not a hang. A hang needs a live handle keeping the loop open,
// which is exactly what a database connection, a socket or a child process is.
const AWAITS_FOREVER = `import { test } from 'node:test';
test('waits on something that never arrives', async () => {
  const openHandle = setInterval(() => {}, 1_000);
  try {
    await new Promise(() => {});
  } finally {
    clearInterval(openHandle);
  }
});
`;

// The half that is not obvious: a synchronous call blocks the event loop, so nothing inside the
// child can time it out. The bound fires anyway, because the parent runner holds the clock.
// Assembled, so this file's own source does not carry the token the sweep above looks for.
const BLOCKS_THE_LOOP = `import { test } from 'node:test';
import { spawn${'Sync'} } from 'node:child_process';
test('blocks the event loop in a child that outlives the bound', () => {
  spawn${'Sync'}(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
});
`;

for (const [what, source] of [
  ['awaiting a promise nobody settles', AWAITS_FOREVER],
  ['blocked inside a synchronous call', BLOCKS_THE_LOOP],
] as const) {
  test(`the file bound kills a test ${what}`, () => {
    const run = runSubject(
      source,
      ['--test-timeout=2000', '--test', '--test-reporter=tap'],
      CHILD_BOUND_MS,
    );
    // Output, never exit status alone: a child reporting on the wrong protocol exits 0.
    assert.match(
      run.out,
      /failureType: 'testTimeoutFailure'/,
      `the runner did not report a timeout:\n${run.out.slice(-2000)}`,
    );
    assert.match(run.out, /test timed out after 2000ms/);
    // Naming the file is the difference between this and a job that dies on its own clock.
    assert.match(run.out, /subject\.test\.mjs/);
    assert.equal(run.status, 1, 'a timed-out run must not exit 0');
    assert.ok(
      run.took < 30_000,
      `the bound took ${run.took}ms to fire, so it bounded nothing`,
    );
    // A timeout is reported `cancelled`, never `fail`, which is why scripts/check.ts refuses on
    // that line rather than reading `# fail` alone.
    assert.match(run.out, /^# cancelled 1$/m);
    assert.match(run.out, /^# fail 0$/m);
  });
}

const CONTROL_KILL_MS = 5_000;

test('the same file with no bound is what the bound replaces', () => {
  // The control. Left as node ships it, the run is still going when the spawn's own timeout kills
  // it from outside — which is the state every command line in this repository was in.
  const run = runSubject(AWAITS_FOREVER, ['--test'], CONTROL_KILL_MS);
  assert.ok(
    run.took >= CONTROL_KILL_MS,
    `the unbounded run ended on its own in ${run.took}ms, so this subject no longer hangs`,
  );
  assert.doesNotMatch(
    run.out,
    /testTimeoutFailure/,
    'something bounded the unbounded run',
  );
  // The disease itself, stated: a hang reports nothing at all. No counts, no failing test, no
  // named file — only a runner that had to be killed from outside.
  assert.doesNotMatch(run.out, /^# tests \d+$/m);
  assert.doesNotMatch(run.out, /^not ok /m);
});
