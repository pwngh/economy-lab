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
 * The one question TAP cannot answer: did every file in this run report what it did?
 *
 * A test file that ends its own process — `process.exit(0)` in a test, a native crash — takes its
 * remaining tests with it, and `node:test` counts that file as ONE passing test. Its TAP and its
 * run-level `test:summary` then agree perfectly, because both are computed after the child died,
 * so no reader of either can tell. A file that registered no test at all reads the same way.
 *
 * `node:test` also emits a `test:summary` PER FILE, out of that file's own child process, before
 * the run-level one. That is the number a dead child cannot write. This reporter adds up the
 * per-file summaries, names every file that ended without one, and checks its own arithmetic
 * against the run's total.
 *
 * It prints one `counted:` line whatever happens, so a runner can tell "the run was accounted for"
 * from "this reporter was never attached" — the two look identical in silence. On a disagreement
 * it names the files and sets a non-zero exit, so every runner that spawns `node --test` gets the
 * refusal out of the exit code without parsing anything.
 *
 * Attach it beside a real reporter, never instead of one:
 *
 *     --test-reporter=tap --test-reporter-destination=stdout
 *     --test-reporter=./scripts/support/counted.reporter.mjs --test-reporter-destination=stderr
 */

import { relative, resolve } from 'node:path';
import process from 'node:process';

const here = (file) => relative(process.cwd(), file);

/**
 * Whether this event is node announcing one of the files the run was given, rather than a test
 * inside one. A file is enqueued under its own path; a test is enqueued under its name. The
 * difference matters because a shared registrar — a module holding `test()` calls that other
 * files import — is stamped on every event it registered and has no summary of its own, which
 * would otherwise read exactly like a file that walked out.
 */
function namesItsOwnFile(data) {
  const name = data.name;
  if (data.nesting !== 0 || typeof name !== 'string' || name === '') {
    return false;
  }
  return (
    resolve(process.cwd(), name) === data.file ||
    data.file.endsWith(`/${name}`) ||
    data.file === name
  );
}

export default async function* countedReporter(source) {
  /** Every file this run touched, whether it was given to the runner or merely imported. */
  const seen = new Set();
  /** The files the runner was given. */
  const entries = new Set();
  /** The counts each file reported for itself. */
  const reported = new Map();
  /** Files node itself reported as failed — an import that threw is already loud. */
  const blamed = new Set();
  /** What node says the whole run did. The one figure here this reporter did not add up. */
  let run = null;

  for await (const event of source) {
    const data = event.data ?? {};
    const file = data.file;
    if (event.type === 'test:summary') {
      if (file === undefined) run = data.counts ?? null;
      else reported.set(file, data.counts ?? null);
      continue;
    }
    // Forwarded child output names its file the way argv spelled it, where every other event
    // names it absolutely — so counting these would make one file look like two.
    if (event.type === 'test:stdout' || event.type === 'test:stderr') continue;
    if (file === undefined) continue;
    seen.add(file);
    if (event.type === 'test:enqueue' && namesItsOwnFile(data))
      entries.add(file);
    if (event.type === 'test:fail') blamed.add(file);
  }

  const total = { tests: 0, pass: 0, fail: 0, skip: 0 };
  for (const counts of reported.values()) {
    if (counts === null) continue;
    total.tests += counts.tests;
    total.pass += counts.passed;
    total.fail += counts.failed + counts.cancelled;
    total.skip += counts.skipped + counts.todo;
  }

  const unreported = [...entries].filter((file) => !reported.has(file));
  const refusals = [];

  // The clause this reporter exists for. A file node blamed has already said so in the output
  // above; a file it counted as passing and that never reported is the silent one.
  const silent = unreported.filter((file) => !blamed.has(file));
  if (silent.length > 0) {
    refusals.push(
      `${silent.length} file(s) passed without reporting any counts of their own, so this run counts each as one test rather than the tests it holds — a file that ends its own process takes the rest with it, and a file that registers nothing looks the same:\n    ${silent.map(here).join('\n    ')}`,
    );
  }

  // The per-file counts against the run's, which also checks the sorting above: a file that
  // reported nothing contributes exactly one test to the run's total, so the two numbers are
  // equal or this reporter has mistaken a file for a registrar and is under-reading the run.
  if (run === null) {
    if (seen.size > 0) {
      refusals.push(
        'node:test announced no totals for this run, so there is nothing to add the files up against',
      );
    }
  } else if (run.tests - total.tests !== unreported.length) {
    refusals.push(
      `the files report ${total.tests} test(s) of the run's ${run.tests}, which ${unreported.length} file(s) reporting nothing does not account for`,
    );
  }

  yield `counted: ${entries.size} files, ${total.tests} tests, ${total.pass} pass, ${total.fail} fail, ${total.skip} skip\n`;

  if (refusals.length > 0) {
    yield 'counted: what ran is not what was counted.\n';
    for (const refusal of refusals) yield `  ${refusal}\n`;
    process.exitCode = 1;
  }
}
