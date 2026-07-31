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
 * `node:test` reporter printing a spec-style tree with hierarchical numbers (1, 1.2, ...) so
 * "1.3 failed" is findable. Streams: each top-level suite prints the moment it completes, like
 * the built-in spec reporter. Parallel workers interleave events across files, so a per-file
 * stack rebuilds each tree and numbers follow completion order. Wired up via --test-reporter
 * in package.json.
 *
 * Everything `node:test` finished is printed, and the run refuses to end quietly if the report
 * disagrees with what `node:test` says ran. A counting instrument that prints a smaller green
 * number is the one failure nothing downstream can see.
 */

import { relative } from 'node:path';
import process from 'node:process';

// ANSI colors only on a TTY; piped or captured output stays plain text.
const tty = process.stdout.isTTY;
const paint = (open, close) => (s) =>
  tty ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
const dim = paint(2, 22);
const bold = paint(1, 22);
const green = paint(32, 39);
const red = paint(31, 39);
const yellow = paint(33, 39);
const cyan = paint(36, 39);

/**
 * One node of the tree. `kind` is `node:test`'s own word for it — `'test'` or `'suite'` — and
 * arrives with the pass/fail event, as `status` does. Both stay null for a node that started
 * and never finished.
 */
function makeNode(name, standIn = false) {
  return {
    name,
    children: [],
    status: null,
    kind: null,
    duration: null,
    error: null,
    standIn,
  };
}

const here = (file) => relative(process.cwd(), file);

export default async function* numberedReporter(source) {
  // stacks[file][n] = the still-open node at nesting depth n. Within a file, test:start fires
  // top-down and test:pass/fail closes the innermost open node, so the stack reconstructs the
  // hierarchy exactly; only the order across files is shuffled by parallelism.
  const stacks = new Map();
  // Top-level nodes started but not yet printed; whatever a crashed file leaves here still
  // prints at the end, so nothing vanishes as a pass.
  const pending = new Set();
  // Stand-ins holding subtests registered from a file with no suite of its own open, keyed by
  // that file.
  const standIns = new Map();
  const counts = { suites: 0, tests: 0, pass: 0, fail: 0, skip: 0 };
  const failures = [];
  const unknown = [];
  let topLevel = 0;
  // Counted straight off the stream, before anything is attached to a tree, so it cannot agree
  // with the tree by construction.
  let finished = 0;
  let printed = 0;
  let unfinished = 0;
  // Queued and started. A test file that ends its own process leaves tests queued that never
  // start, and node:test counts that file as one passing test — so its totals cannot catch it.
  let queued = 0;
  let started = 0;
  // What `node:test` says the run did. Its own bookkeeping, and the numbers its TAP reporter
  // prints.
  let announced = null;

  // A suite failing only because children failed would just repeat them in the failure list;
  // a hook failure is the suite's own and must be reported, or the run can claim "all passed".
  const ownSuiteFailure = (node) =>
    node.status === 'fail' &&
    (node.error?.failureType ?? node.error?.cause?.failureType) !==
      'subtestsFailed';

  /**
   * `node:test` stamps an event with the file the `test()` call was written in, not the file
   * being run, so a subtest registered from a shared module arrives with its suite nowhere on
   * that module's stack. It is held under a named stand-in rather than dropped: the count stays
   * true, and the run says the tree it printed is not the tree that ran.
   */
  const holdUnder = (file, stack, nesting) => {
    let root = standIns.get(file);
    if (root === undefined) {
      root = makeNode(`subtests registered in ${here(file)}`, true);
      standIns.set(file, root);
      pending.add(root);
    }
    if (!stack[0]) stack[0] = root;
    for (let depth = 1; depth < nesting; depth += 1) {
      if (stack[depth]) continue;
      const filler = makeNode('(no open suite)', true);
      stack[depth - 1].children.push(filler);
      stack[depth] = filler;
    }
  };

  const render = (node, number, depth, out) => {
    const indent = '   '.repeat(depth);
    const tag = dim(number);
    const kids = () =>
      node.children.forEach((child, i) =>
        render(child, `${number}.${i + 1}`, depth + 1, out),
      );

    if (node.standIn) {
      out.push(`${indent}${tag}  ${red('⟂')} ${bold(node.name)}`);
      kids();
      return;
    }
    if (node.status === null) {
      unfinished += 1;
      out.push(
        `${indent}${tag}  ${red('✖')} ${node.name} ${dim('(never finished)')}`,
      );
      failures.push({ number, name: node.name, error: node.error });
      kids();
      return;
    }

    printed += 1;
    if (node.kind === null) unknown.push(node.name);
    const dur =
      node.duration == null ? '' : dim(` (${node.duration.toFixed(2)}ms)`);

    if (node.kind === 'suite') {
      counts.suites += 1;
      const arrow =
        node.status === 'fail'
          ? red('▶')
          : node.status === 'skip'
            ? yellow('▶')
            : cyan('▶');
      const note = node.status === 'skip' ? dim(' (skipped)') : '';
      out.push(`${indent}${tag}  ${arrow} ${bold(node.name)}${note}`);
      if (ownSuiteFailure(node)) {
        failures.push({ number, name: node.name, error: node.error });
      }
      kids();
      return;
    }

    counts.tests += 1;
    let mark;
    if (node.status === 'skip') {
      mark = yellow('◌');
      counts.skip += 1;
    } else if (node.status === 'fail') {
      mark = red('✖');
      counts.fail += 1;
      failures.push({ number, name: node.name, error: node.error });
    } else {
      mark = green('✔');
      counts.pass += 1;
    }
    out.push(`${indent}${tag}  ${mark} ${node.name}${dur}`);
    kids();
  };

  const block = (node) => {
    topLevel += 1;
    const out = [];
    render(node, String(topLevel), 0, out);
    return `${topLevel > 1 ? '\n' : ''}${out.join('\n')}\n`;
  };

  for await (const event of source) {
    const d = event.data ?? {};
    // The run-level summary is the only event carrying no file, and it is the one number here
    // that this reporter did not derive.
    if (event.type === 'test:summary' && d.file === undefined) {
      announced = d.counts ?? null;
      continue;
    }
    const done = event.type === 'test:pass' || event.type === 'test:fail';
    // Counted before the file is looked at, so an event this reporter declines to place still
    // shows up in the reconciliation below.
    if (done) finished += 1;
    if (event.type === 'test:enqueue') queued += 1;
    if (event.type === 'test:dequeue') started += 1;
    const file = d.file;
    if (!file) continue;
    let stack = stacks.get(file);
    if (!stack) {
      stack = [];
      stacks.set(file, stack);
    }
    const nesting = d.nesting ?? 0;
    if (event.type === 'test:start') {
      const node = makeNode(d.name ?? '');
      if (nesting === 0) pending.add(node);
      else {
        if (!stack[nesting - 1]) holdUnder(file, stack, nesting);
        stack[nesting - 1].children.push(node);
      }
      stack[nesting] = node;
      stack.length = nesting + 1;
    } else if (done) {
      const node = stack[nesting];
      if (!node) continue;
      node.status =
        event.type === 'test:fail'
          ? 'fail'
          : d.skip || d.todo
            ? 'skip'
            : 'pass';
      node.kind = d.details?.type ?? null;
      node.duration = d.details?.duration_ms ?? null;
      if (event.type === 'test:fail') node.error = d.details?.error ?? null;
      stack.length = nesting; // close it; the slot is free for the next sibling
      if (nesting === 0) {
        pending.delete(node);
        yield block(node);
      }
    }
  }

  for (const node of pending) {
    yield block(node);
  }

  // Failure details, so the report needs no second reporter.
  if (failures.length > 0) {
    yield `\n${red(bold('Failures:'))}\n`;
    for (const f of failures) {
      const msg = (
        f.error?.cause?.message ??
        f.error?.message ??
        String(f.error ?? 'unknown error')
      ).split('\n')[0];
      yield `  ${dim(f.number)}  ${f.name}\n      ${red(msg)}\n`;
    }
  }

  // What this report claims, against what node:test says it ran. A drop is invisible in the
  // report itself — the number is simply smaller — so the two are compared rather than trusted.
  const disagreements = [];
  const compare = (what, mine, theirs) => {
    if (mine !== theirs) {
      disagreements.push(`${what}: this report ${mine}, node:test ${theirs}`);
    }
  };
  if (announced === null) {
    disagreements.push(
      'node:test announced no totals for this run, so there is nothing to reconcile against',
    );
  } else {
    compare('tests', counts.tests, announced.tests);
    compare('suites', counts.suites, announced.suites);
    compare('pass', counts.pass, announced.passed);
    compare('fail', counts.fail, announced.failed + announced.cancelled);
    compare('skip', counts.skip, announced.skipped + announced.todo);
  }
  if (finished === 0) {
    disagreements.push('no test finished in this run');
  }
  if (queued !== started) {
    disagreements.push(
      `${queued} test(s) were queued and ${started} started, so the rest left the run before node:test could count them`,
    );
  }
  if (printed !== finished) {
    disagreements.push(
      `${finished} test(s) and suite(s) finished, ${printed} reached this report`,
    );
  }
  if (unfinished > 0) {
    disagreements.push(
      `${unfinished} started and never finished, so node:test never counted them`,
    );
  }
  if (unknown.length > 0) {
    disagreements.push(
      `node:test did not say whether ${unknown.length} finished node(s) were tests or suites: ${unknown.slice(0, 4).join(', ')}`,
    );
  }
  for (const file of standIns.keys()) {
    disagreements.push(
      `subtests registered in ${here(file)} have no suite open in that file, so their place in the tree is not known — register them where their describe() is`,
    );
  }

  if (disagreements.length > 0) {
    yield `\n${red(bold('Report:'))} what was printed is not what ran.\n`;
    for (const line of disagreements) yield `  ${red(line)}\n`;
    process.exitCode = 1;
  }

  // Summary line, computed from the tree so it matches what was printed above.
  const verdict =
    failures.length > 0
      ? red(`${failures.length} failed`)
      : disagreements.length > 0
        ? red('report unreliable')
        : green('all passed');
  yield `\n${bold('Summary')}  ${verdict}  ·  ${counts.suites} suites  ·  ${counts.tests} tests` +
    `  (${green(counts.pass + ' pass')}` +
    (counts.fail ? `, ${red(counts.fail + ' fail')}` : '') +
    (counts.skip ? `, ${yellow(counts.skip + ' skip')}` : '') +
    `)\n`;
}
