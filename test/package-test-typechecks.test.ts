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

// `npm test -w <pkg>` is the loop the lane brief prescribes, and tsx strips types without reading
// them: a package test file that does not compile ran green in that loop and red in the table at
// landing. So every package that keeps tests declares a `pretest` that compiles its own project,
// and npm refuses to run the tests when it fails.
//
// Three facts hold that up, and each is checked apart from the others here or next door:
//   the manifests declare it            — the roster below
//   its project reads the test files    — asserted here off `include`, proven with --listFiles
//                                         by test/tsconfig-coverage.test.ts
//   npm runs it first and stops on it   — the fixture below, driven with the declared command
//
// The fixture's own `test` script is not the packages' — it exists only to print a marker, so a
// run that skipped straight past the compiler is visible as the marker arriving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWorkspace } from '#scripts/support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The one command. Read off the manifests below, never compared against a literal. */
const RAN = 'the fixture ran its tests';

/** No npm run may outlive this. A wedged fixture is not a passing one. */
const FIXTURE_MS = 120_000;

/**
 * A member that keeps no `pretest`, and why its test files are compiled anyway. Both sides are
 * resolved every run: an exemption whose reason stopped being true fails here.
 */
const EXEMPT = new Map([
  [
    '@pwngh/economy',
    'the umbrella is generated doors and declares no test script',
  ],
  [
    'create-economy',
    'its suite is test/create-economy.test.ts, which the root program compiles',
  ],
]);

const members = [...readWorkspace(ROOT).values()];

/** Members whose tests only this pretest would compile: they run their own suite from test/. */
const owns = members.filter(
  (member) =>
    member.json.scripts?.test !== undefined &&
    existsSync(join(member.dir, 'test')),
);

test('every package that keeps tests compiles them before it runs them', () => {
  assert.ok(members.length > 10, `the sweep read ${members.length} manifests`);
  assert.equal(
    owns.length + EXEMPT.size,
    members.length,
    `${members.length} members, ${owns.length} keep their own tests, ${EXEMPT.size} exempted`,
  );
  for (const [name, why] of EXEMPT) {
    const member = members.find((each) => each.name === name);
    assert.ok(
      member !== undefined,
      `${name} is exempted and is not a member (${why})`,
    );
    assert.ok(
      !owns.includes(member),
      `${name} now keeps its own test directory and a test script; delete its exemption (${why})`,
    );
  }
  const wrong: string[] = [];
  for (const member of owns) {
    const pretest = member.json.scripts?.pretest;
    if (pretest === undefined) {
      wrong.push(`${member.name} runs its tests without compiling them first`);
      continue;
    }
    // The compiler must be pointed at the package's own project, which is the only one that
    // reads its test tree. `tsc` against a file list would read no tsconfig at all.
    if (!/(^|\s)tsc\s/.test(pretest) || !pretest.includes('-p .')) {
      wrong.push(`${member.name}'s pretest is ${JSON.stringify(pretest)}`);
    }
  }
  assert.deepEqual(wrong, []);
  // One command, so the fixture below can be driven with it rather than with a copy of it.
  assert.equal(
    new Set(owns.map((member) => member.json.scripts!.pretest)).size,
    1,
    'the packages declare more than one pretest, so no single fixture speaks for them',
  );
});

test('the project each pretest compiles is the one that reads that package tests', () => {
  const wrong: string[] = [];
  for (const member of owns) {
    const config = join(member.dir, 'tsconfig.json');
    if (!existsSync(config)) {
      wrong.push(
        `${member.name} has no tsconfig.json for its pretest to compile`,
      );
      continue;
    }
    const include = (
      JSON.parse(readFileSync(config, 'utf8')) as {
        include?: readonly string[];
      }
    ).include;
    if (!include?.includes('test')) {
      wrong.push(
        `${member.name}'s tsconfig.json includes ${JSON.stringify(include ?? null)}, which does not name its test tree`,
      );
    }
  }
  assert.deepEqual(wrong, []);
});

/** Writes a package that declares the real pretest, and one test file with the given body. */
function fixture(dir: string, pretest: string, body: string): void {
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pretest-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          pretest,
          test: 'node --test test/fixture.test.ts',
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'esnext',
          // The packages all compile with `types: ["node"]`; a fixture outside the tree has to
          // be told where those live, or it fails on `node:test` rather than on its own error.
          typeRoots: [join(ROOT, 'node_modules', '@types')],
          types: ['node'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['test'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, 'test', 'fixture.test.ts'), body);
}

function runFixture(dir: string) {
  // npm gives a workspace member the repository's node_modules/.bin; a fixture outside the tree
  // is handed the same directory so it resolves the same compiler.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(ROOT, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
  };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync('npm', ['test'], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: FIXTURE_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    run,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    wedged: run.signal !== null,
  };
}

const PASSES = `import { test } from 'node:test';
const n: number = 1;
test('fixture', () => {
  if (n !== 1) throw new Error('no');
  process.stdout.write('${RAN}\\n');
});
`;

// The same file with one type error and nothing else changed: tsx and node's own type stripping
// both run this happily, and only a compiler refuses it.
const BREAKS = PASSES.replace(
  'const n: number = 1;',
  "const n: number = 'one';",
);

test('the prescribed loop refuses a package test that does not compile', () => {
  const pretest = owns[0]?.json.scripts?.pretest;
  assert.ok(
    pretest !== undefined,
    'no package declares a pretest to drive the fixture with',
  );
  const dir = mkdtempSync(join(tmpdir(), 'economy-pretest-'));
  try {
    fixture(dir, pretest, BREAKS);
    const broken = runFixture(dir);
    assert.ok(!broken.wedged, `the fixture was killed by ${broken.run.signal}`);
    assert.notEqual(
      broken.run.status,
      0,
      `\`npm test\` passed a test file that does not compile\n${broken.output.slice(-3000)}`,
    );
    assert.match(
      broken.output,
      /error TS\d+/,
      `the run failed for some reason other than the compiler\n${broken.output.slice(-3000)}`,
    );
    assert.ok(
      !broken.output.includes(RAN),
      `the tests ran anyway, so a failed pretest does not stop them\n${broken.output.slice(-3000)}`,
    );

    // Positive control. A pretest that failed on everything would satisfy every assertion above,
    // so the same fixture with the type error removed has to run its tests and say so.
    fixture(dir, pretest, PASSES);
    const clean = runFixture(dir);
    assert.ok(
      !clean.wedged,
      `the clean fixture was killed by ${clean.run.signal}`,
    );
    assert.equal(
      clean.run.status,
      0,
      `the fixture failed with nothing wrong with it\n${clean.output.slice(-3000)}`,
    );
    assert.ok(
      clean.output.includes(RAN),
      `the clean fixture never reached its tests\n${clean.output.slice(-3000)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
