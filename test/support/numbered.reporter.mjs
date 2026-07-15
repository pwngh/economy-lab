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
 */

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

// A suite (has `children`) or a single test; `status` arrives with the pass/fail event.
function makeNode(name) {
  return { name, children: [], status: null, duration: null, error: null };
}

export default async function* numberedReporter(source) {
  // stacks[file][n] = the still-open node at nesting depth n. Within a file, test:start fires
  // top-down and test:pass/fail closes the innermost open node, so the stack reconstructs the
  // hierarchy exactly; only the order across files is shuffled by parallelism.
  const stacks = new Map();
  // Top-level nodes started but not yet printed; whatever a crashed file leaves here still
  // prints at the end, so nothing vanishes as a pass.
  const pending = new Set();
  const counts = { suites: 0, tests: 0, pass: 0, fail: 0, skip: 0 };
  const failures = [];
  let topLevel = 0;

  // A suite failing only because children failed would just repeat them in the failure list;
  // a hook failure is the suite's own and must be reported, or the run can claim "all passed".
  const ownSuiteFailure = (node) =>
    node.status === 'fail' &&
    (node.error?.failureType ?? node.error?.cause?.failureType) !==
      'subtestsFailed';

  const render = (node, number, depth, out) => {
    const indent = '   '.repeat(depth);
    const tag = dim(number);
    if (node.children.length > 0) {
      counts.suites += 1;
      const arrow = node.status === 'fail' ? red('▶') : cyan('▶');
      out.push(`${indent}${tag}  ${arrow} ${bold(node.name)}`);
      if (ownSuiteFailure(node)) {
        failures.push({ number, name: node.name, error: node.error });
      }
      node.children.forEach((child, i) =>
        render(child, `${number}.${i + 1}`, depth + 1, out),
      );
    } else {
      counts.tests += 1;
      let mark;
      if (node.status === 'skip') {
        mark = yellow('◌');
        counts.skip += 1;
      } else if (node.status !== 'pass') {
        // 'fail', or null: a test with no pass/fail event never finished — not a pass.
        mark = red('✖');
        counts.fail += 1;
        failures.push({ number, name: node.name, error: node.error });
      } else {
        mark = green('✔');
        counts.pass += 1;
      }
      const dur =
        node.duration == null ? '' : dim(` (${node.duration.toFixed(2)}ms)`);
      out.push(`${indent}${tag}  ${mark} ${node.name}${dur}`);
    }
  };

  const block = (node) => {
    topLevel += 1;
    const out = [];
    render(node, String(topLevel), 0, out);
    return `${topLevel > 1 ? '\n' : ''}${out.join('\n')}\n`;
  };

  for await (const event of source) {
    const d = event.data ?? {};
    const file = d.file;
    if (!file) continue; // run-level events (final summary, etc.) are recomputed below
    let stack = stacks.get(file);
    if (!stack) {
      stack = [];
      stacks.set(file, stack);
    }
    const nesting = d.nesting ?? 0;
    if (event.type === 'test:start') {
      const node = makeNode(d.name ?? '');
      if (nesting === 0) pending.add(node);
      else if (stack[nesting - 1]) stack[nesting - 1].children.push(node);
      stack[nesting] = node;
      stack.length = nesting + 1;
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const node = stack[nesting];
      if (!node) continue;
      node.status =
        event.type === 'test:fail'
          ? 'fail'
          : d.skip || d.todo
            ? 'skip'
            : 'pass';
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

  // Summary line, computed from the tree so it matches what was printed above.
  const verdict =
    failures.length > 0
      ? red(`${failures.length} failed`)
      : green('all passed');
  yield `\n${bold('Summary')}  ${verdict}  ·  ${counts.suites} suites  ·  ${counts.tests} tests` +
    `  (${green(counts.pass + ' pass')}` +
    (counts.fail ? `, ${red(counts.fail + ' fail')}` : '') +
    (counts.skip ? `, ${yellow(counts.skip + ' skip')}` : '') +
    `)\n`;
}
