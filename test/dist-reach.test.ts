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

// A test that reaches this repository through a package reads `dist`, and `dist` is last build's
// copy of `src/`. Mutate a source, run such a test without rebuilding, and it stays green — which
// was read as the mutation being caught. It was the previous build answering.
//
// So both runners classify the files they are about to run and refuse the ones that read an emit
// while that emit is behind its source. What is gated here is the discrimination, not the
// refusal: under one artificial staleness a file that reaches a package must refuse and a file
// that reads `#src/*` must run, or the guard is either blind or a blanket that nobody can work
// under.
//
// The staleness is applied to a package the root suite does not load, so a run of this file
// cannot make a sibling suite refuse: test/dist-freshness.test.ts asserts the real tree is fresh
// for the units this suite consumes, and receipt is not one of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILDS_DATED, buildUnits } from '#scripts/check-dist-fresh.ts';
import { ALL_TEST_FILES } from '#scripts/check.ts';
import { exclusively } from '#test/support/stale-window.ts';
import { reachesDist } from '#scripts/support/dist-reach.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** No spawn may outlive this. A guard that wedges has not refused anything. */
const SPAWN_MS = 90_000;

/** Older than any source in the tree, so the pairing does not have to be worked out. */
const LONG_AGO = new Date('2000-01-01T00:00:00Z');

/**
 * The file `Q58` watched stay green under a mutated guard. Its own import list names
 * `#src/money.ts`, so it reads as a source test; the engines arrive one file further in.
 */
const WITNESS = 'test/engines/leg-wire.test.ts';

/** A source-only file: everything it loads resolves through `#src/*`. Cheap, so it can run. */
const SOURCE_ONLY = 'test/accounts.test.ts';

/** A package reader cheap enough to run to completion when the emit is level. */
const READS_EMIT = 'test/no-shims.test.ts';

/**
 * A unit whose emit no root suite file loads, which is what makes it safe to back-date here.
 * The freshness checker refuses on any stale output in the repository, so which unit carries the
 * staleness does not change what the guard does.
 */
const OFF_TO_ONE_SIDE = 'packages/receipt/dist';

function spawn(argv: readonly string[], marker?: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // A run started from inside the suite already carries the marker its parent set. The raw form
  // is by definition a shell that carries nothing, so it is removed rather than merely not added.
  delete env[BUILDS_DATED];
  if (marker !== undefined) env[BUILDS_DATED] = marker;
  const run = spawnSync(process.execPath, [...argv], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: SPAWN_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: run.status,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    wedged: run.signal !== null,
  };
}

const ranTests = (output: string): number =>
  Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0);

const passedTests = (output: string): number =>
  Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);

/** Runs a body with one build output dated before every source, and puts its time back after. */
function whileBehind(body: (staled: string) => void): void {
  const dir = join(ROOT, OFF_TO_ONE_SIDE);
  const emitted = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(
    emitted.length > 0,
    `${OFF_TO_ONE_SIDE} holds no build output to date; run node scripts/build-packages.mjs`,
  );
  const output = join(dir, emitted.sort()[0]!);
  const was = statSync(output);
  // Staleness is a property of the repository, so a second gate holding its own window would
  // make this one's refusals land for the wrong reason, and its controls refuse for no reason.
  exclusively(() => {
    utimesSync(output, was.atime, LONG_AGO);
    try {
      // The whole point of the window is that the tree is stale inside it. A staleness that did
      // not take would let the steps below run for real, which is minutes rather than a refusal.
      const dated = spawn(['scripts/check-dist-fresh.ts']);
      assert.notEqual(
        dated.status,
        0,
        `back-dating ${OFF_TO_ONE_SIDE} did not make the checker refuse\n${dated.output.slice(-1500)}`,
      );
      body(output);
    } finally {
      utimesSync(output, was.atime, was.mtime);
    }
  });
}

test('the emit is only dated for the files that read it', () => {
  for (const file of [WITNESS, SOURCE_ONLY, READS_EMIT]) {
    assert.ok(
      existsSync(join(ROOT, file)),
      `${file} is gone; repoint this gate`,
    );
  }
  whileBehind(() => {
    const refused = spawn(['scripts/suite.mjs', 'file', WITNESS, READS_EMIT]);
    assert.ok(
      !refused.wedged,
      'the refusing run was killed rather than refusing',
    );
    assert.notEqual(
      refused.status,
      0,
      `two files that read the emit ran against a build behind its source\n${refused.output.slice(-3000)}`,
    );
    assert.match(
      refused.output,
      /dist-freshness/,
      `the run failed for some reason other than the emit\n${refused.output.slice(-3000)}`,
    );
    // The reach is what the refusal has to name: this file's own imports do not show it.
    assert.match(
      refused.output,
      new RegExp(`${WITNESS} -> test/support/adapters\\.ts -> @pwngh/economy-`),
      `the refusal does not say how ${WITNESS} arrives at a package\n${refused.output.slice(-3000)}`,
    );
    assert.equal(
      ranTests(refused.output),
      0,
      `the refusal printed test counts, so it ran the files anyway\n${refused.output.slice(-3000)}`,
    );

    // The other half. A guard that refused every run would satisfy everything above it, and
    // would also stop every lane from iterating on `src/` at all.
    const allowed = spawn(['scripts/suite.mjs', 'file', SOURCE_ONLY]);
    assert.ok(!allowed.wedged, 'the source-only run was killed');
    assert.equal(
      allowed.status,
      0,
      `${SOURCE_ONLY} reads no emit and was refused anyway\n${allowed.output.slice(-3000)}`,
    );
    assert.ok(
      ranTests(allowed.output) > 0,
      `${SOURCE_ONLY} reported no tests\n${allowed.output.slice(-2000)}`,
    );
  });
});

test('a file that reads the emit runs once the emit is level', () => {
  // The control for the refusal above: the same runner, the same kind of file, nothing stale.
  // Level means level for every gate, so this waits out any window a sibling file is holding.
  exclusively(() => {
    const run = spawn(['scripts/suite.mjs', 'file', READS_EMIT]);
    assert.ok(!run.wedged, 'the level run was killed');
    assert.equal(
      run.status,
      0,
      `${READS_EMIT} was refused against a fresh emit\n${run.output.slice(-3000)}`,
    );
    assert.ok(
      ranTests(run.output) > 0,
      `${READS_EMIT} reported no tests\n${run.output.slice(-2000)}`,
    );
    assert.match(
      run.output,
      new RegExp(`${READS_EMIT} -> `),
      `the run did not say that ${READS_EMIT} reads the lab through a package\n${run.output.slice(-2000)}`,
    );
  });
});

test('one row of the table run on its own is dated the same way', () => {
  whileBehind(() => {
    // `engines` is a row whose files reach the backends. Selected alone it skips `fresh:dist`,
    // which is the shape a mutation proof uses.
    const refused = spawn(['scripts/check.ts', 'engines']);
    assert.ok(
      !refused.wedged,
      `the engines row ran for ${SPAWN_MS}ms instead of refusing — the staleness did not reach it`,
    );
    assert.notEqual(
      refused.status,
      0,
      'the engines row ran against a stale emit',
    );
    assert.match(
      refused.output,
      /dist-freshness/,
      `the row failed for some reason other than the emit\n${refused.output.slice(-3000)}`,
    );

    // A row that runs no test files reads no emit, so the guard must leave it alone.
    const untouched = spawn(['scripts/check.ts', 'node-floor']);
    assert.ok(!untouched.wedged, 'the node-floor row was killed');
    assert.equal(
      untouched.status,
      0,
      `a row that runs no test file was refused for a stale emit\n${untouched.output.slice(-2000)}`,
    );
  });
});

/** Every root test file on disk, walked here rather than taken from the table it is compared to. */
function rootTestFiles(dir = join(ROOT, 'test'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) rootTestFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(relative(ROOT, path));
  }
  return out;
}

/**
 * Whether the lab's own build compiles this file into `dist/`. Such a file is published, and
 * `build-dist.mjs` rewrites its local specifiers into the emit — so importing the guard from one
 * would ship a check on THIS repository's build inside the tarball. Derived from the build roots
 * rather than named, so a root that starts or stops being compiled moves the exemption with it.
 */
function published(file: string): boolean {
  return buildUnits(ROOT)[0]!.roots.some((root) =>
    file.startsWith(`${root.sources}/`),
  );
}

/**
 * The guard as a statement of its own, anchored to a whole line. A substring would also match
 * this file, which names the import in the message it prints when one is missing.
 */
const GUARD = /^import '#test\/support\/dist-guard\.ts';$/m;

/**
 * The roster behind `test/support/dist-guard.ts`. The guard only helps the files that carry it,
 * so what has to hold is that carrying it and reading an emit are the same set — a file that
 * starts reaching a package and does not pick the import up is the hole reopening quietly.
 */
/**
 * Every root test file that reaches this repository through a published door, by name.
 *
 * A count was here, and a count cannot say which file moved. When `test/errors.test.ts` stopped
 * being an emit reader on 2026-07-31 this pin printed `41 !== 42`, which reads as an import
 * somebody deleted and was diagnosed twice as a broken build — it was a true reclassification.
 * The roster names it, so the two are told apart from the message (`Q382`).
 */
const REACHING = [
  'test/acceptance/rigs.test.ts',
  'test/acceptance/smoke.test.ts',
  'test/adapters/edge-host.test.ts',
  'test/adapters/edge-tilia.test.ts',
  'test/adapters/entitlement-bitset.test.ts',
  'test/adapters/http-dispatcher.test.ts',
  'test/adapters/http.test.ts',
  'test/adapters/memory-cache.test.ts',
  'test/adapters/memory-rate-limit.test.ts',
  'test/adapters/memory.test.ts',
  'test/adapters/mysql-money-install-race.test.ts',
  'test/adapters/mysql.test.ts',
  'test/adapters/postgres-transient-classes.test.ts',
  'test/adapters/postgres.test.ts',
  'test/adapters/processor.test.ts',
  'test/adapters/redis.test.ts',
  'test/adapters/sqs.test.ts',
  'test/adapters/statement-order.test.ts',
  'test/adapters/tilia-payees.test.ts',
  'test/adapters/wire-trial.test.ts',
  'test/bench-harness.test.ts',
  'test/conformance-contract.test.ts',
  'test/conformance/balance-holds.test.ts',
  'test/conformance/claim-contention.race.test.ts',
  'test/conformance/claim-lock-lifetime.race.test.ts',
  'test/conformance/concurrency.adversarial.test.ts',
  'test/conformance/invariants.adversarial.test.ts',
  'test/conformance/money-db.test.ts',
  'test/conformance/settle-vs-reverse.race.test.ts',
  'test/conformance/velocity.rollback.test.ts',
  'test/create-economy.test.ts',
  'test/economy.close.test.ts',
  'test/engine-open.test.ts',
  'test/engines/leg-wire.test.ts',
  'test/env-surface.test.ts',
  'test/fuzz.test.ts',
  'test/lab-app.test.ts',
  'test/maturity.test.ts',
  'test/money-sql.test.ts',
  'test/no-shims.test.ts',
  'test/package-readmes.test.ts',
  'test/prove.test.ts',
  'test/root-changelog.test.ts',
  'test/sharding.test.ts',
  'test/taskq-host.test.ts',
  'test/worker/payouts-attempts-cas.test.ts',
];

test('a root test file imports the guard exactly when it reads an emit', () => {
  const files = rootTestFiles();
  assert.deepEqual(
    [...files].sort(),
    [...ALL_TEST_FILES].sort(),
    'walking test/ and reading the table give different root test files',
  );
  assert.equal(files.length, 188, `walked ${files.length} root test files`);

  const reaching = new Set(reachesDist(ROOT, files).map((each) => each.file));
  assert.deepEqual(
    [...reaching].sort(),
    REACHING,
    'the root test files that reach the lab through a package changed',
  );

  let guarded = 0;
  let exempt = 0;
  let plain = 0;
  for (const file of files) {
    const carries = GUARD.test(readFileSync(join(ROOT, file), 'utf8'));
    if (!reaching.has(file)) {
      assert.ok(
        !carries,
        `${file} imports the guard and reads no emit, so the roster has stopped saying anything`,
      );
      plain += 1;
    } else if (published(file)) {
      assert.ok(
        !carries,
        `${file} is compiled into the published emit and cannot carry a check on this build`,
      );
      exempt += 1;
    } else {
      assert.ok(
        carries,
        `${file} reads the lab through a package and does not import the guard, so node --test on it reports a green that describes the previous build`,
      );
      guarded += 1;
    }
  }
  // Exact, because three counts that only have to sum are satisfied by every file landing in the
  // one bucket the loop can never fail.
  assert.deepEqual([guarded, exempt, plain], [46, 0, 142]);
  assert.equal(guarded + exempt, reaching.size);
  assert.equal(reaching.size, REACHING.length);
  assert.equal(guarded + exempt + plain, files.length);
});

/**
 * The command this guard exists for: `node --test <file>`, typed into a shell, with no broker and
 * no table between it and node. Nothing there classifies anything, so the refusal can only come
 * from the file's own import — and the same window proves it is not a blanket.
 *
 * Safe to run beside the rest of the suite for the same reason it is cheap: every sibling file was
 * spawned by a runner that dated the emit and passed the marker, so none of them re-dates inside
 * this window.
 */
test('the raw runner refuses a file that reads an emit behind its source', () => {
  whileBehind(() => {
    const refused = spawn(['--test', READS_EMIT]);
    assert.ok(!refused.wedged, 'the raw run was killed rather than refusing');
    assert.notEqual(
      refused.status,
      0,
      `${READS_EMIT} ran raw against a build behind its source\n${refused.output.slice(-3000)}`,
    );
    assert.match(
      refused.output,
      /dist-freshness/,
      `the raw run failed for some reason other than the emit\n${refused.output.slice(-3000)}`,
    );
    assert.match(
      refused.output,
      /fix: /,
      'the refusal does not name the command that repairs the build',
    );
    assert.equal(
      passedTests(refused.output),
      0,
      `the raw run passed tests against a stale emit\n${refused.output.slice(-3000)}`,
    );

    // A file that reads `#src/*` imports no guard and must still run under the same staleness,
    // or every lane iterating on a source test is stopped by a package it never loads.
    const allowed = spawn(['--test', SOURCE_ONLY]);
    assert.ok(!allowed.wedged, 'the source-only raw run was killed');
    assert.equal(
      allowed.status,
      0,
      `${SOURCE_ONLY} reads no emit and was refused anyway\n${allowed.output.slice(-2000)}`,
    );
    assert.ok(
      passedTests(allowed.output) > 0,
      `${SOURCE_ONLY} passed no tests\n${allowed.output.slice(-2000)}`,
    );

    // What the two prescribed runners pass after dating the tree themselves. Without it the guard
    // would date once per file, and would refuse every sibling suite inside this window.
    const dated = spawn(['--test', READS_EMIT], '1');
    assert.ok(!dated.wedged, 'the marked raw run was killed');
    assert.equal(
      dated.status,
      0,
      `a run whose parent had already dated the emit was refused anyway\n${dated.output.slice(-2000)}`,
    );
    assert.ok(
      passedTests(dated.output) > 0,
      `the marked run passed no tests\n${dated.output.slice(-2000)}`,
    );
  });
});

// The control for the refusal above: same command, same file, nothing stale. Without it, a guard
// that refused every raw run would satisfy everything in that window.
test('the raw runner runs the same file once the emit is level', () => {
  exclusively(() => {
    const run = spawn(['--test', READS_EMIT]);
    assert.ok(!run.wedged, 'the level raw run was killed');
    assert.equal(
      run.status,
      0,
      `${READS_EMIT} was refused raw against a fresh emit\n${run.output.slice(-3000)}`,
    );
    assert.ok(
      passedTests(run.output) > 0,
      `${READS_EMIT} passed no tests\n${run.output.slice(-2000)}`,
    );
  });
});
