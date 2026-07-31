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

// Every runner in this repository but the root suite reads TAP, and TAP cannot see a test file
// that ends its own process: `node:test` counts that file as one passing test, and its own
// run-level totals — the numbers TAP prints — are computed after the child is already gone, so
// they agree with it perfectly. `scripts/support/counted.reporter.mjs` is the one instrument all
// four runners attach, and it reads the per-file `test:summary` each child sends while it is
// still alive.
//
// So every count here is checked against `--test-reporter=tap` over the same fixture, never
// against the reporter itself. A reporter compared to its own output agrees by construction.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const REPORTER = join(ROOT, 'scripts/support/counted.reporter.mjs');

/** No spawn outlives this. A gate that wedges has refused nothing. */
const SPAWN_MS = 60_000;

/** Two ordinary files. Structurally varied so the positive control is not a single test. */
const HEALTHY = `import { describe, test } from 'node:test';
test('plain one', () => {});
test('named skip', { skip: 'a rig this fixture does not have' }, () => {});
describe('a suite', () => { test('deep one', () => {}); });
`;

/**
 * A module holding `test()` calls that a real file imports. `node:test` stamps every event it
 * registers with THIS file, which never reported a summary of its own — the shape that made the
 * first cut of this reporter refuse four package suites that were entirely healthy.
 */
const REGISTRAR = `import { describe, test } from 'node:test';
export function registerCases(count) {
  describe('shared cases', () => {
    for (let i = 1; i <= count; i += 1) test(\`case \${i}\`, () => {});
  });
}
`;

const IMPORTS_REGISTRAR = `import { test } from 'node:test';
import { registerCases } from './registrar.mjs';
registerCases(3);
test('local one', () => {});
`;

/** Ends the process from inside a test, after the run has started reporting. */
const WALKS_OUT = `import { test } from 'node:test';
test('walks out mid-run', async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(0);
});
test('never gets to run', () => {});
`;

/** The same, one tick earlier: node has forwarded nothing about this file when it dies. */
const WALKS_OUT_SYNC = `import { test } from 'node:test';
test('walks out at once', () => { process.exit(0); });
test('never gets to run', () => {});
`;

const REGISTERS_NOTHING = `export {};
`;

const RED = `import { test } from 'node:test';
test('honest failure', () => { throw new Error('nope'); });
test('passing one', () => {});
`;

const IMPORT_THROWS = `import 'node:no-such-builtin';
import { test } from 'node:test';
test('never runs', () => {});
`;

interface Run {
  readonly status: number | null;
  readonly out: string;
}

const dir = mkdtempSync(join(tmpdir(), 'economy-counted-'));

function fixture(name: string, source: string): string {
  writeFileSync(join(dir, name), source);
  return name;
}

const files = {
  healthy: fixture('healthy.test.mjs', HEALTHY),
  shared: fixture('shared.test.mjs', IMPORTS_REGISTRAR),
  walksOut: fixture('walks-out.test.mjs', WALKS_OUT),
  walksOutSync: fixture('walks-out-sync.test.mjs', WALKS_OUT_SYNC),
  empty: fixture('empty.test.mjs', REGISTERS_NOTHING),
  red: fixture('red.test.mjs', RED),
  throws: fixture('throws.test.mjs', IMPORT_THROWS),
};

fixture('registrar.mjs', REGISTRAR);

/** Runs the fixtures with TAP, and with the reporter beside it when asked. */
function runner(named: readonly string[], counted: boolean): Run {
  const env = { ...process.env };
  // node --test leaks this to children, and a child that inherits it reports to a parent that is
  // not listening and exits 0 whatever its tests did. Deleted, never blanked.
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-timeout=30000',
      '--test-reporter=tap',
      '--test-reporter-destination=stdout',
      ...(counted
        ? [`--test-reporter=${REPORTER}`, '--test-reporter-destination=stderr']
        : []),
      ...named,
    ],
    { cwd: dir, encoding: 'utf8', env, timeout: SPAWN_MS },
  );
  return { status: ran.status, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}` };
}

/** What node:test itself says the run did, taken from a run this reporter was not in. */
function fromTap(named: readonly string[]): {
  tests: number;
  pass: number;
  fail: number;
  status: number | null;
} {
  const { out, status } = runner(named, false);
  const field = (name: string): number => {
    const found = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(out)?.[1];
    assert.ok(found !== undefined, `tap printed no "# ${name}" line:\n${out}`);
    return Number(found);
  };
  return {
    tests: field('tests'),
    pass: field('pass'),
    fail: field('fail'),
    status,
  };
}

const ACCOUNTED =
  /^counted: (\d+) files, (\d+) tests, (\d+) pass, (\d+) fail, (\d+) skip$/m;

function accounted(out: string): {
  files: number;
  tests: number;
  pass: number;
} {
  const line = ACCOUNTED.exec(out);
  assert.ok(line, `the run printed no accounting line:\n${out}`);
  return {
    files: Number(line[1]),
    tests: Number(line[2]),
    pass: Number(line[3]),
  };
}

const REFUSED = /^counted: what ran is not what was counted\.$/m;

// The positive control, and it is a test rather than a footnote: a healthy run has to report its
// true totals, stay quiet and exit 0. Without it, "a lost file is caught" is satisfied by a
// reporter that refuses every run.
test('a run where every file reported is quiet, and its counts are node’s', () => {
  const named = [files.healthy, files.shared, files.red];
  const ran = runner(named, true);
  const tap = fromTap(named);
  const read = accounted(ran.out);

  assert.equal(read.tests, tap.tests, ran.out);
  assert.equal(read.pass, tap.pass, ran.out);
  assert.equal(read.files, 3, 'the registrar was counted as a file of its own');
  assert.doesNotMatch(ran.out, REFUSED, ran.out);
  // The run is red for its own reason, and that is the reporter's silence being checked: the one
  // fixture here that fails is the one this reporter must not have an opinion about.
  assert.equal(ran.status, tap.status);
  assert.equal(ran.status, 1);
});

test('a healthy run on its own exits 0 with the reporter attached', () => {
  const ran = runner([files.healthy, files.shared], true);
  assert.equal(ran.status, 0, ran.out);
  assert.doesNotMatch(ran.out, REFUSED, ran.out);
  const read = accounted(ran.out);
  assert.deepEqual(
    [read.files, read.tests],
    [2, fromTap([files.healthy, files.shared]).tests],
  );
});

describe('a file that reported nothing is named', () => {
  for (const [what, file] of [
    ['ends its own process mid-run', files.walksOut],
    ['ends its own process before it reports', files.walksOutSync],
    ['registers no test at all', files.empty],
  ] as const) {
    test(`a file that ${what}`, () => {
      const named = [file, files.healthy];

      // The defect, reproduced on purpose: node's own reporter calls this run green.
      const tap = fromTap(named);
      assert.equal(tap.status, 0, 'the fixture no longer passes under tap');
      assert.equal(tap.fail, 0, 'the fixture fails for some other reason now');

      const ran = runner(named, true);
      assert.equal(ran.status, 1, ran.out);
      assert.match(ran.out, REFUSED, ran.out);
      assert.match(ran.out, new RegExp(file.replace('.', '\\.')), ran.out);
      // Strictly smaller than what node counted, which is the whole disagreement.
      assert.ok(
        accounted(ran.out).tests < tap.tests,
        `the files reported as much as the run did:\n${ran.out}`,
      );
    });
  }
});

// A file whose import throws never reports counts either, and node says so at the top of the
// output. A second refusal underneath it would train a reader to scroll past this reporter.
test('a file whose import throws is left to the failure already printed', () => {
  const named = [files.throws, files.healthy];
  const ran = runner(named, true);
  assert.equal(ran.status, 1, ran.out);
  assert.doesNotMatch(ran.out, REFUSED, ran.out);
});

// The false positive that four healthy package suites hit on the first cut of this reporter.
test('a shared registrar is not a file that left the run', () => {
  const ran = runner([files.shared], true);
  assert.equal(ran.status, 0, ran.out);
  assert.doesNotMatch(ran.out, REFUSED, ran.out);
  const read = accounted(ran.out);
  assert.equal(
    read.files,
    1,
    'the registrar was counted as a file the run was given',
  );
  assert.equal(read.tests, fromTap([files.shared]).tests);
});

/**
 * The other half of the entry: one instrument, and every runner that spawns `node --test`
 * carrying it. Read out of each caller's own text, because a reporter nobody attached is
 * indistinguishable from a run with nothing wrong.
 */
test('every runner in this repository attaches it', () => {
  const named = 'counted.reporter.mjs';
  const carriers = [
    'scripts/check.ts',
    'scripts/suite.mjs',
    'scripts/test-packages.mjs',
    'package.json',
  ];
  for (const carrier of carriers) {
    const text = readFileSync(join(ROOT, carrier), 'utf8');
    assert.ok(
      text.includes(named),
      `${carrier} spawns node --test and does not attach ${named}, so a file that ends its own process reads there as one passing test`,
    );
    assert.match(
      text,
      /--test-reporter-destination=stderr/,
      `${carrier} attaches the reporter and names no destination for it`,
    );
  }
  assert.equal(carriers.length, 4);
});

test('the fixtures were written outside the repository, and are gone', () => {
  assert.ok(dir.startsWith(tmpdir()), `${dir} is not a throwaway directory`);
  rmSync(dir, { recursive: true, force: true });
});
