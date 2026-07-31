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

// The root suite's headline is whatever `test/support/numbered.reporter.mjs` prints, so a test
// the reporter loses is a test nothing downstream can miss. It cannot be caught by reading the
// report: a dropped test leaves no gap, only a smaller number.
//
// Every count here is therefore checked against `--test-reporter=tap`, node's own reporter, run
// over the same fixture. Comparing the reporter to itself would agree by construction.
//
// The shape that loses tests is a shared registrar — a `describe()` in one file whose `test()`
// calls are written in another — because `node:test` stamps an event with the file the call was
// written in, not the file being run.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORTER = fileURLToPath(
  new URL('./support/numbered.reporter.mjs', import.meta.url),
);

/** Structurally varied on purpose: an empty suite, a skipped suite and a todo are the three
 *  shapes where node's idea of a test and a reader's idea of one come apart. */
const HEALTHY = `import { describe, it, test } from 'node:test';
describe('outer', () => {
  it('plain one', () => {});
  it('todo one', { todo: true }, () => {});
  describe('inner', () => { it('deep one', () => {}); });
});
describe('empty suite', () => {});
describe('skipped suite', { skip: true }, () => { it('never', () => {}); });
test('lone skip', { skip: true }, () => {});
test('top level', () => {});
`;

const RED = `import { describe, before, it, test } from 'node:test';
describe('hook blows up', () => {
  before(() => { throw new Error('hook died'); });
  it('cancelled one', () => {});
});
test('failing one', () => { throw new Error('nope'); });
test('passing one', () => {});
`;

const REGISTRAR = `import { test } from 'node:test';
export function registerCases(count) {
  for (let i = 1; i <= count; i += 1) test(\`case \${i}\`, () => {});
  test('skipped case', { skip: true }, () => {});
}
`;

const SHARED = `import { describe, test } from 'node:test';
import { registerCases } from './registrar.mjs';
describe('shared registrar', () => {
  registerCases(5);
});
test('local one', () => {});
`;

const WALKS_OUT = `import { test } from 'node:test';
test('walks out mid-run', async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  process.exit(0);
});
test('never gets to run', () => {});
`;

interface Run {
  readonly status: number | null;
  readonly out: string;
}

interface Counts {
  readonly tests: number;
  readonly suites: number;
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

function runner(file: string, reporter: string): Run {
  const env = { ...process.env };
  // node --test leaks this to children, and a child that inherits it reports to a parent that is
  // not listening and exits 0 whatever its tests did. Deleted, never blanked.
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${reporter}`, '--test-timeout=60000', file],
    { encoding: 'utf8', env, timeout: 120_000 },
  );
  return { status: ran.status, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}` };
}

/** What node:test itself says ran, folded into the five figures the report prints. */
function fromTap(file: string): Counts {
  const { out } = runner(file, 'tap');
  const field = (name: string): number => {
    const found = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(out)?.[1];
    assert.ok(found !== undefined, `tap printed no "# ${name}" line:\n${out}`);
    return Number(found);
  };
  return {
    tests: field('tests'),
    suites: field('suites'),
    pass: field('pass'),
    // A cancelled test reports as a failure and is counted apart from one that ran and failed.
    fail: field('fail') + field('cancelled'),
    // A todo reports as a pass carrying a flag, and the report marks it the way it marks a skip.
    skip: field('skipped') + field('todo'),
  };
}

const SUMMARY =
  /Summary\s+(all passed|report unreliable|\d+ failed)\s+·\s+(\d+) suites\s+·\s+(\d+) tests\s+\((\d+) pass(?:, (\d+) fail)?(?:, (\d+) skip)?\)/;

function fromReport(out: string): Counts & { readonly verdict: string } {
  const line = SUMMARY.exec(out);
  assert.ok(line, `the report printed no summary line:\n${out}`);
  return {
    verdict: line[1]!,
    suites: Number(line[2]),
    tests: Number(line[3]),
    pass: Number(line[4]),
    fail: Number(line[5] ?? 0),
    skip: Number(line[6] ?? 0),
  };
}

/** A copy of the reporter with one edit, for proving a clause is load-bearing. */
function mutant(dir: string, name: string, from: string, to: string): string {
  const source = readFileSync(REPORTER, 'utf8');
  assert.ok(
    source.includes(from),
    `the reporter no longer contains ${JSON.stringify(from)}, so this mutation changes nothing`,
  );
  const edited = source.replace(from, to);
  assert.notEqual(edited, source, 'the mutation left the reporter unchanged');
  const path = join(dir, name);
  writeFileSync(path, edited);
  return path;
}

function inTempDir<T>(what: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'economy-reporter-'));
  try {
    return what(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const write = (dir: string, name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

describe('the numbered reporter counts what ran', () => {
  // The positive control. Without it, "a drop is caught" is satisfied by a reporter that refuses
  // every run, and a reporter that never reports a true total is no more useful than one that
  // reports a false one.
  test('a healthy run reports the totals node:test reports, and passes', () => {
    inTempDir((dir) => {
      const file = write(dir, 'healthy.test.mjs', HEALTHY);
      const expected = fromTap(file);
      // An empty run agrees with an empty run about everything.
      assert.ok(expected.tests > 0, 'the fixture registered no tests');
      assert.ok(expected.suites > 0, 'the fixture registered no suites');
      assert.ok(expected.skip > 0, 'the fixture skipped nothing');

      const ran = runner(file, REPORTER);
      const got = fromReport(ran.out);
      assert.equal(got.verdict, 'all passed', ran.out);
      assert.equal(ran.status, 0, ran.out);
      assert.deepEqual(
        { ...got, verdict: undefined },
        { ...expected, verdict: undefined },
        ran.out,
      );
      // The totals could be right while the tree printed nothing readable.
      for (const name of ['deep one', 'lone skip', 'top level']) {
        assert.ok(
          ran.out.includes(name),
          `${name} was counted but not printed`,
        );
      }
    });
  });

  // An honestly red run must read as red tests, not as a reporter that cannot be trusted.
  test('a run with a failure and a cancellation reports both, and blames the tests', () => {
    inTempDir((dir) => {
      const file = write(dir, 'red.test.mjs', RED);
      const expected = fromTap(file);
      assert.ok(expected.fail > 0, 'the fixture failed nothing');

      const ran = runner(file, REPORTER);
      const got = fromReport(ran.out);
      assert.match(got.verdict, /^\d+ failed$/, ran.out);
      assert.notEqual(ran.status, 0, ran.out);
      assert.deepEqual(
        { ...got, verdict: undefined },
        { ...expected, verdict: undefined },
        ran.out,
      );
      // A red run is already non-zero, so nothing else here would notice the reconciliation
      // firing wrongly — and a cancellation is the one outcome it could misread as a lost test.
      assert.doesNotMatch(ran.out, /what was printed is not what ran/, ran.out);
    });
  });

  test('a subtest registered in another file is still printed, counted, and called out', () => {
    inTempDir((dir) => {
      write(dir, 'registrar.mjs', REGISTRAR);
      const file = write(dir, 'shared.test.mjs', SHARED);
      const expected = fromTap(file);

      const ran = runner(file, REPORTER);
      const got = fromReport(ran.out);
      assert.deepEqual(
        { ...got, verdict: undefined },
        { ...expected, verdict: undefined },
        ran.out,
      );
      for (const name of ['case 1', 'case 5', 'skipped case']) {
        assert.ok(ran.out.includes(name), `${name} left the report`);
      }
      assert.equal(got.verdict, 'report unreliable', ran.out);
      assert.notEqual(ran.status, 0, ran.out);
      assert.match(ran.out, /registrar\.mjs/, ran.out);
      assert.match(ran.out, /no suite open in that file/, ran.out);
    });
  });

  // The clause that has to hold whatever the reporter does with an unplaceable subtest: if one is
  // lost, the totals stop matching and the run says so. Proven by dropping one on purpose.
  test('a dropped subtest fails the reconciliation', () => {
    inTempDir((dir) => {
      write(dir, 'registrar.mjs', REGISTRAR);
      const file = write(dir, 'shared.test.mjs', SHARED);
      const expected = fromTap(file);
      const dropping = mutant(
        dir,
        'dropping.reporter.mjs',
        `        if (!stack[nesting - 1]) holdUnder(file, stack, nesting);
        stack[nesting - 1].children.push(node);`,
        `        if (stack[nesting - 1]) stack[nesting - 1].children.push(node);`,
      );

      const ran = runner(file, dropping);
      const got = fromReport(ran.out);
      // The defect itself: a smaller number, printed green, with nothing missing from the tree.
      assert.ok(
        got.tests < expected.tests,
        `the mutation dropped nothing, so this proves nothing:\n${ran.out}`,
      );
      assert.notEqual(ran.status, 0, ran.out);
      assert.equal(got.verdict, 'report unreliable', ran.out);
      assert.match(ran.out, /tests: this report \d+, node:test \d+/, ran.out);
      assert.match(
        ran.out,
        /\d+ test\(s\) and suite\(s\) finished, \d+ reached this report/,
        ran.out,
      );
    });
  });

  // Nothing to compare against is not agreement. Without this the reconciliation is satisfied by
  // a run that announced no totals at all.
  test('a run node:test announced no totals for is not a pass', () => {
    inTempDir((dir) => {
      const file = write(dir, 'healthy.test.mjs', HEALTHY);
      const deaf = mutant(
        dir,
        'deaf.reporter.mjs',
        'announced = d.counts ?? null;',
        'announced = null;',
      );

      const ran = runner(file, deaf);
      assert.equal(fromReport(ran.out).verdict, 'report unreliable', ran.out);
      assert.notEqual(ran.status, 0, ran.out);
      assert.match(ran.out, /announced no totals/, ran.out);
    });
  });

  // Zero equals zero, and a run that matched no file reports zero.
  test('a run in which nothing finished is not a pass', () => {
    inTempDir((dir) => {
      const ran = runner(join(dir, 'no-such-*.test.mjs'), REPORTER);
      assert.notEqual(ran.status, 0, ran.out);
      assert.match(ran.out, /no test finished in this run/, ran.out);
    });
  });

  // The one place the report is right to disagree with node:test. A file that ends its own
  // process takes its tests with it, and node counts the file as one passing test — so its
  // totals reconcile with themselves perfectly. What is queued and never started does not.
  test('a file that ends its own process cannot report as one passing test', () => {
    inTempDir((dir) => {
      const file = write(dir, 'walks-out.test.mjs', WALKS_OUT);
      const blind = fromTap(file);
      assert.equal(blind.fail, 0, 'node:test noticed, so this proves nothing');

      const ran = runner(file, REPORTER);
      assert.equal(fromReport(ran.out).verdict, 'report unreliable', ran.out);
      assert.notEqual(ran.status, 0, ran.out);
      assert.match(ran.out, /queued and \d+ started/, ran.out);
    });
  });
});
