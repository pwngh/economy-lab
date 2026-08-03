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
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readWorkspace,
  runtimeDependencies,
} from '#scripts/support/workspace-graph.ts';
import {
  DRIVERS,
  ELSEWHERE,
  NO_SUITE,
  suitePlan,
} from '#test/support/package-suites.ts';
import { failureReport, failureSections } from '#test/support/tap-failures.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const workspace = readWorkspace(ROOT);

// Read inside each test rather than once up here. A script in a shape the planner refuses to
// read throws, and at module scope that throw takes the whole file down — including the test
// below whose whole job is to name that script as the thing that changed.
const planned = () => suitePlan(ROOT);

// Every script a package may run its tests with. A new form is a deliberate edit here, because
// the file sets below are derived from these strings and a shape they cannot read reads as none.
//
// Each one dates the emit it is about to read before it runs anything. create-economy is the
// exception by derivation, not by exemption: its suite is a root test file, and a root test file
// that reads an emit carries `#test/support/dist-guard.ts` itself.
const APPROVED = [
  'node --test-timeout=600000 --test ../../test/create-economy.test.ts',
  'node ../../scripts/check-package-fresh.ts && node --import tsx --test-timeout=600000 --test test/*.test.ts',
  'node ../../scripts/check-package-fresh.ts && node --import tsx --test-timeout=600000 --test test/*.test.tsx',
];

const ENGINE_SUITES = [
  '@pwngh/economy-mysql',
  '@pwngh/economy-postgres',
  '@pwngh/economy-redis',
  '@pwngh/economy-sqs',
];

/**
 * Every test file under a directory, however deep. Depth is the point: each package's script
 * globs one level, so a file moved into a subdirectory drops out of the run silently, and only
 * a walk that goes deeper than the glob can see it. Build output and installed dependencies
 * carry test files of their own and are not this tree's.
 */
function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

test('every workspace member declares a test script, or is a named exemption', () => {
  let examined = 0;
  let withScript = 0;
  for (const member of workspace.values()) {
    examined += 1;
    if (member.json.scripts?.test !== undefined) {
      withScript += 1;
      continue;
    }
    assert.ok(
      NO_SUITE.has(member.name),
      `${member.name} declares no test script and has no named exemption`,
    );
  }
  assert.equal(examined, 18, `read ${examined} workspace members`);
  assert.equal(examined, withScript + NO_SUITE.size);
});

// An exemption outliving the reason it was written for stops being a reason and becomes a hole:
// a package that grew tests and kept the exemption would run none of them.
test('every exempted member has no test file on disk', () => {
  for (const [name, reason] of NO_SUITE) {
    const member = workspace.get(name);
    assert.ok(member, `${name} is exempted but is not a workspace package`);
    assert.deepEqual(
      testFiles(member!.dir),
      [],
      `${name} is exempted from the fan-out and carries test files anyway`,
    );
    assert.ok(
      reason.length > 20,
      `${name} is exempted with no reason worth reading`,
    );
  }
  assert.equal(NO_SUITE.size, 1);
});

test('every test script is one of the approved forms', () => {
  const scripts = [...workspace.values()]
    .map((member) => member.json.scripts?.test)
    .filter((script) => script !== undefined);
  assert.deepEqual([...new Set(scripts)].sort(), APPROVED);
  assert.equal(scripts.length, 17);
});

// The assertion that keeps a green run honest. `node --test` against a glob matching nothing
// exits 0 and reports zero tests, so a file renamed .ts for .tsx, or moved one directory down,
// leaves its package passing and untested. Two independently derived sets, compared.
test("every package's glob matches exactly the test files on disk", () => {
  let examined = 0;
  for (const suite of planned()) {
    assert.ok(
      suite.files.length > 0,
      `${suite.name}'s test script resolves to no file at all`,
    );
    const declared = ELSEWHERE.get(suite.name);
    if (declared !== undefined) {
      assert.deepEqual(
        [...suite.files],
        declared.map((path) => join(ROOT, path)),
        `${suite.name}'s script does not name the files its exemption declares`,
      );
      for (const file of suite.files) {
        assert.ok(
          existsSync(file),
          `${suite.name} names ${file}, which is absent`,
        );
        assert.ok(
          !file.startsWith(`${suite.dir}/`),
          `${suite.name} keeps ${file} under its own directory, so it needs no exemption`,
        );
      }
      continue;
    }
    examined += 1;
    assert.deepEqual(
      [...suite.files],
      testFiles(join(suite.dir, 'test')),
      `${suite.name}'s test script and its test/ directory disagree`,
    );
  }
  assert.equal(
    examined,
    16,
    `compared ${examined} packages against their test/`,
  );
  assert.equal(ELSEWHERE.size, 1);
});

test('the runner plans exactly the workspace, and allows one named suite its two skips', () => {
  const plan = planned();
  assert.deepEqual(
    plan.map((suite) => suite.name).sort(),
    [...workspace.keys()].filter((name) => !NO_SUITE.has(name)).sort(),
  );
  assert.equal(plan.length, 17);
  assert.deepEqual(
    plan
      .filter((suite) => suite.skipBudget !== 0)
      .map((suite) => [suite.name, suite.skipBudget]),
    [['@pwngh/economy-conformance', 2]],
  );
});

// The fixture's own ceiling. A synchronous spawn blocks the event loop, so nothing inside this
// file can bound it and the 600000 ms file bound is the only thing left — one wedged fixture would
// take every test here with it. Three trivial `node --test` runs finish in about a second.
const FIXTURE_BOUND_MS = 60_000;

/**
 * A real transcript in the shape the fan-out reads: the fixture is run by `node --test` over
 * a pipe, exactly as `npm test -w` runs a package, and stdout and stderr are concatenated the
 * way the runner concatenates them.
 */
function tapTranscript(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tap-fixture-'));
  try {
    const file = join(dir, 'fixture.test.mjs');
    writeFileSync(file, source);
    // An inherited NODE_TEST_CONTEXT switches the child to the reporter protocol; it must be
    // deleted, not blanked.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', file], {
      encoding: 'utf8',
      env,
      timeout: FIXTURE_BOUND_MS,
    });
    return `${run.stdout ?? ''}${run.stderr ?? ''}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Two failures and a todo at the head, then enough passing tests that everything failed sits
// well outside the final 4000 bytes of the transcript.
const OVERFLOW_FIXTURE = [
  "import { describe, it, test } from 'node:test';",
  "import assert from 'node:assert';",
  "test('the spend posts at the listed price', () => {",
  "  assert.strictEqual(49900, 50000, 'the wallet moved for a mispriced spend');",
  '});',
  "describe('the batch path', () => {",
  "  it('holds the catalog gate', () => {",
  "    assert.strictEqual('committed', 'rejected', 'submitBatch let the mispriced spend through');",
  '  });',
  '});',
  "test('a todo point prints not ok without failing', { todo: true }, () => {",
  '  assert.fail();',
  '});',
  'for (let i = 1; i <= 80; i += 1) {',
  "  test(`a passing test padding the transcript tail, number ${String(i).padStart(3, '0')}`, () => {",
  '    assert.ok(true);',
  '  });',
  '}',
].join('\n');

let overflow: string | undefined;
const overflowTranscript = () => (overflow ??= tapTranscript(OVERFLOW_FIXTURE));

test("a failing suite's report is its own not ok lines and messages", () => {
  const transcript = overflowTranscript();
  assert.match(transcript, /^# tests 83$/m);
  assert.match(transcript, /^# fail 2$/m);
  assert.ok(
    !transcript.slice(-4000).includes('not ok'),
    'the fixture no longer overflows: its failures fit the final 4000 bytes',
  );

  const report = failureReport(transcript, 2);
  assert.ok(
    report.includes('not ok 1 - the spend posts at the listed price'),
    'the flat failure is missing from the report',
  );
  assert.ok(
    report.includes('the wallet moved for a mispriced spend'),
    'the flat failure lost its assertion message',
  );
  assert.ok(
    report.includes('submitBatch let the mispriced spend through'),
    'the failure nested in a describe lost its assertion message',
  );
  assert.equal(
    (report.match(/^\s*not ok /gm) ?? []).length,
    4,
    'the report shows the two failed tests, the suite holding one, and the todo point',
  );
  assert.ok(
    !/^\s*ok \d+ - /m.test(report),
    'a passing row in the failure report means it degraded to printing everything',
  );
});

// The control that keeps "failures are visible" from being satisfied by printing failures
// that did not happen: a green record yields nothing to show.
test('a green transcript yields no failure section', () => {
  const transcript = tapTranscript(
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      'for (let i = 1; i <= 6; i += 1) {',
      '  test(`a passing test, number ${i}`, () => {',
      '    assert.ok(true);',
      '  });',
      '}',
    ].join('\n'),
  );
  assert.match(transcript, /^# tests 6$/m);
  assert.match(transcript, /^# fail 0$/m);

  const { sections, counted } = failureSections(transcript);
  assert.equal(counted, 0);
  assert.deepEqual(sections, []);
});

// A parent that dies with a pending subtest yields a `cancelledByParent` point, tallied under
// `# cancelled` — the report keeps it as context without letting it break the fail count.
test('a cancelled subtest rides along without unbalancing the report', () => {
  const transcript = tapTranscript(
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "test('parent that dies with a pending child', async (t) => {",
      "  t.test('child that never settles', () => new Promise(() => {}));",
      "  assert.fail('the parent failed before the child settled');",
      '});',
      'for (let i = 1; i <= 80; i += 1) {',
      "  test(`a passing test padding the transcript tail, number ${String(i).padStart(3, '0')}`, () => {",
      '    assert.ok(true);',
      '  });',
      '}',
    ].join('\n'),
  );
  assert.match(transcript, /^# fail 1$/m);
  assert.match(transcript, /^# cancelled 1$/m);
  assert.ok(
    !transcript.slice(-4000).includes('not ok'),
    'the fixture no longer overflows: its failures fit the final 4000 bytes',
  );

  const report = failureReport(transcript, 1);
  assert.ok(
    report.includes('the parent failed before the child settled'),
    'the failing parent lost its assertion message',
  );
  assert.ok(
    report.includes('not ok 1 - child that never settles'),
    'the cancelled child is missing as context',
  );
  assert.ok(
    !/^\s*ok \d+ - /m.test(report),
    'a passing row in the failure report means it degraded to printing everything',
  );
});

test('a transcript that cannot account for every failure is printed whole', () => {
  const transcript = overflowTranscript();
  const headless = transcript
    .split('\n')
    .filter((line) => !line.includes('not ok'))
    .join('\n');

  const report = failureReport(headless, 2);
  assert.ok(
    report.includes('accounts for 0 of the 2 failures the summary reports'),
    'the report does not name the disagreement between points and summary',
  );
  assert.ok(
    report.includes('number 042'),
    'the report hides part of a transcript it could not account for',
  );
});

// The roster is derived from what the packages declare rather than written down, and the list
// it derives from is held live: a driver no package depends on would sit here forever, and a
// driver added to a package but missing from the list would take its suite out of the roster.
test('the engine roster is derived, and every driver it reads is live', () => {
  assert.deepEqual(
    planned()
      .filter((suite) => suite.needsEngine)
      .map((suite) => suite.name)
      .sort(),
    ENGINE_SUITES,
  );
  for (const driver of DRIVERS) {
    const declaring = [...workspace.values()].filter(
      (member) => driver in runtimeDependencies(member),
    );
    assert.ok(
      declaring.length > 0,
      `${driver} is in the driver list and no workspace package declares it`,
    );
  }
  assert.equal(DRIVERS.length, 5);
});
