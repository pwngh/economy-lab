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
 * A custom `node:test` reporter that prints a spec-style tree with hierarchical
 * numbers: each top-level suite gets a whole number (1, 2, 3, ...) and each test
 * under it gets a dotted sub-number (1.1, 1.2, ...; deeper nesting keeps extending
 * the dots). The numbers are assigned here at print time — nothing in the test
 * files changes — so you can say "1.3 failed" and find it.
 *
 * Why it buffers the whole run before printing: `node --test` runs test files in
 * parallel worker processes, so their events arrive interleaved and in a different
 * order each run. To make the numbers stable, this collects every event, groups
 * them back together by file, sorts the files by path, and only then walks the
 * tree assigning numbers. The trade-off is that output appears once at the end
 * rather than streaming live — fine for a suite that finishes in a second or two.
 *
 * Wire it up in package.json:
 *   node --test --test-reporter=./test/support/numbered.reporter.mjs \
 *        --test-reporter-destination=stdout "test/**\/*.test.ts"
 */

// ANSI colors, but only when writing straight to a terminal. When the output is
// piped or captured (no TTY), everything is plain text so logs stay clean.
const tty = process.stdout.isTTY;
const paint = (open, close) => (s) =>
  tty ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
const dim = paint(2, 22);
const bold = paint(1, 22);
const green = paint(32, 39);
const red = paint(31, 39);
const yellow = paint(33, 39);
const cyan = paint(36, 39);

// One node in a file's test tree: a suite (has `children`) or a single test (none).
// `status` is filled in when the matching test:pass / test:fail event arrives.
function makeNode(name) {
  return { name, children: [], status: null, duration: null, error: null };
}

export default async function* numberedReporter(source) {
  // Group structural events by the file they came from, preserving each file's own
  // order (which IS reliable — only the order ACROSS files is shuffled by parallelism).
  const eventsByFile = new Map();
  for await (const event of source) {
    const file = event.data?.file;
    if (!file) continue; // run-level events (final summary, etc.) are recomputed below
    if (!eventsByFile.has(file)) eventsByFile.set(file, []);
    eventsByFile.get(file).push(event);
  }

  // Rebuild each file's tree. Within a file, test:start fires top-down (a parent
  // before its children) and test:pass/fail closes the innermost open node, so a
  // simple depth-indexed stack reconstructs the hierarchy exactly.
  const rootsByFile = new Map();
  for (const [file, events] of eventsByFile) {
    const roots = [];
    const stack = []; // stack[n] = the still-open node at nesting depth n
    for (const event of events) {
      const d = event.data ?? {};
      const nesting = d.nesting ?? 0;
      if (event.type === 'test:start') {
        const node = makeNode(d.name ?? '');
        if (nesting === 0) roots.push(node);
        else if (stack[nesting - 1]) stack[nesting - 1].children.push(node);
        stack[nesting] = node;
        stack.length = nesting + 1;
      } else if (event.type === 'test:pass' || event.type === 'test:fail') {
        const node = stack[nesting];
        if (node) {
          node.status =
            event.type === 'test:fail'
              ? 'fail'
              : d.skip || d.todo
                ? 'skip'
                : 'pass';
          node.duration = d.details?.duration_ms ?? null;
          if (event.type === 'test:fail') node.error = d.details?.error ?? null;
          stack.length = nesting; // close it; the slot is free for the next sibling
        }
      }
    }
    rootsByFile.set(file, roots);
  }

  // Walk the trees in a stable file order, numbering as we go.
  const lines = [];
  const failures = [];
  let counts = { suites: 0, tests: 0, pass: 0, fail: 0, skip: 0 };
  let topLevel = 0;

  const render = (node, number, depth) => {
    const indent = '   '.repeat(depth);
    const tag = dim(number);
    if (node.children.length > 0) {
      counts.suites += 1;
      const arrow = node.status === 'fail' ? red('▶') : cyan('▶');
      lines.push(`${indent}${tag}  ${arrow} ${bold(node.name)}`);
      node.children.forEach((child, i) =>
        render(child, `${number}.${i + 1}`, depth + 1),
      );
    } else {
      counts.tests += 1;
      let mark;
      if (node.status === 'fail') {
        mark = red('✖');
        counts.fail += 1;
        failures.push({ number, name: node.name, error: node.error });
      } else if (node.status === 'skip') {
        mark = yellow('◌');
        counts.skip += 1;
      } else {
        mark = green('✔');
        counts.pass += 1;
      }
      const dur =
        node.duration != null ? dim(` (${node.duration.toFixed(2)}ms)`) : '';
      lines.push(`${indent}${tag}  ${mark} ${node.name}${dur}`);
    }
  };

  for (const file of [...rootsByFile.keys()].sort()) {
    for (const root of rootsByFile.get(file)) {
      topLevel += 1;
      if (lines.length > 0) lines.push(''); // blank line between top-level suites
      render(root, String(topLevel), 0);
    }
  }

  yield lines.join('\n') + '\n';

  // Failure details, so the report stands on its own without a second reporter.
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

  // Summary line, computed from the tree so it always matches what was printed above.
  const verdict =
    counts.fail > 0 ? red(`${counts.fail} failed`) : green('all passed');
  yield `\n${bold('Summary')}  ${verdict}  ·  ${counts.suites} suites  ·  ${counts.tests} tests` +
    `  (${green(counts.pass + ' pass')}` +
    (counts.fail ? `, ${red(counts.fail + ' fail')}` : '') +
    (counts.skip ? `, ${yellow(counts.skip + ' skip')}` : '') +
    `)\n`;
}
