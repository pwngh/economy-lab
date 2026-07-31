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

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BUILDS_DATED, assertBuildsFresh } from './check-dist-fresh.ts';
import { suitePlan } from '../test/support/package-suites.ts';
import { failureReport } from '../test/support/tap-failures.ts';
import { readWorkspace } from './support/workspace-graph.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// node --test exports NODE_TEST_CONTEXT to children, and a child that inherits it switches to
// the reporter protocol and exits 0 whatever its tests did. An empty string still counts as set.
//
// The whole tree is dated once below, so each suite's own freshness check skips the work rather
// than repeating it sixteen times.
const env = { ...process.env, [BUILDS_DATED]: '1' };
delete env.NODE_TEST_CONTEXT;

// Each suite is run by its own package's test script, which this file cannot rewrite, so the
// reporter that answers for a file leaving the run is handed down the environment instead. As a
// URL, because NODE_OPTIONS is split on spaces and a path is not guaranteed to have none.
const COUNTED = new URL('./support/counted.reporter.mjs', import.meta.url).href;
env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS ?? '',
  '--test-reporter=tap --test-reporter-destination=stdout',
  `--test-reporter=${COUNTED} --test-reporter-destination=stderr`,
]
  .join(' ')
  .trim();

// Every package here imports the lab and its siblings through their exports maps, which point at
// dist. A suite run against a dist older than the source it was built from reports on the
// previous build under the name of this one, which is how a rewritten worker stayed green.
function fresh(plan) {
  let report;
  try {
    report = assertBuildsFresh(ROOT, 'the package fan-out');
  } catch (refusal) {
    console.error(refusal.message);
    return null;
  }

  // The two rosters are derived apart — one from build scripts, one from test scripts — so a
  // suite whose package is about to run untested for freshness shows up here as a disagreement.
  const workspace = readWorkspace(ROOT);
  const dated = new Set(report.units.map((unit) => unit.name));
  const undated = plan
    .map((suite) => suite.name)
    .filter(
      (name) =>
        workspace.get(name)?.json.scripts?.build !== undefined &&
        !dated.has(name),
    );
  if (undated.length > 0) {
    console.error(
      `test-packages: ${undated.join(', ')} build a dist that nothing dated against its source`,
    );
    return null;
  }
  return report;
}

function main() {
  const plan = suitePlan(ROOT);
  const report = fresh(plan);
  if (report === null) return 1;
  console.log(
    `test-packages: ${report.comparedOutputs.size} build outputs across ${report.units.length} units are at least as new as their sources`,
  );
  let failed = 0;
  let tests = 0;
  let pass = 0;
  let fail = 0;
  let skipped = 0;

  for (const suite of plan) {
    const run = spawnSync('npm', ['test', '-w', suite.name], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      shell: false,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const read = (field) =>
      Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
    const counts = {
      tests: read('tests'),
      pass: read('pass'),
      fail: read('fail'),
      skipped: read('skipped'),
    };

    // What the files themselves reported, which is the number a file that ended its own process
    // could not have written. TAP's totals are computed after it died and count it as one test.
    const accounted =
      /^counted: (\d+) files, (\d+) tests, (\d+) pass, (\d+) fail, (\d+) skip$/m.exec(
        output,
      );

    // Exit status alone is not evidence. A run that printed no counts never reported on its
    // tests, whatever it returned.
    if (Number.isNaN(counts.tests) || Number.isNaN(counts.pass)) {
      console.error(
        `${suite.name}: no test counts in the output; treating as failed`,
      );
      console.error(output.slice(-2000));
      failed += 1;
      continue;
    }

    tests += counts.tests;
    pass += counts.pass;
    fail += counts.fail;
    skipped += counts.skipped;

    // A glob matching nothing exits 0 and reports zero tests, so a file renamed out of its
    // package's pattern would otherwise leave this suite green having run nothing.
    const empty = counts.tests === 0;
    const lost =
      accounted === null ||
      Number(accounted[1]) !== suite.files.length ||
      Number(accounted[2]) !== counts.tests;
    const bad =
      run.status !== 0 ||
      counts.fail > 0 ||
      counts.skipped > suite.skipBudget ||
      lost ||
      empty;
    console.log(
      `${bad ? 'FAIL' : 'ok  '} ${suite.name}: ${counts.tests} tests, ${counts.pass} pass, ${counts.fail} fail, ${counts.skipped} skip`,
    );
    if (!bad) continue;

    if (empty) {
      console.error(
        `  ran no tests: ${suite.files.length} file(s) matched ${suite.name}'s test script.`,
      );
    }
    if (lost) {
      console.error(
        accounted === null
          ? `  no accounting line: the counted reporter never reported, so a file that ended its own process would read here as one passing test.`
          : `  ${suite.files.length} test file(s) in this suite and ${accounted[1]} reported, holding ${accounted[2]} test(s) against the run's ${counts.tests}.`,
      );
    }
    if (counts.skipped > suite.skipBudget) {
      console.error(
        `  ${counts.skipped} skipped (budget ${suite.skipBudget})${suite.needsEngine ? ': a backend is unreachable, so this leg proved nothing.' : '.'}`,
      );
    }
    console.error(failureReport(output, counts.fail));
    failed += 1;
  }

  if (failed > 0) {
    console.error(`test-packages: ${failed} of ${plan.length} suites failed`);
    return 1;
  }
  console.log(
    `test-packages: ${plan.length} suites, ${tests} tests, ${pass} pass, ${fail} fail, ${skipped} skip`,
  );
  return 0;
}

process.exitCode = main();
