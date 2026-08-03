/**
 * @pwngh/economy-cli
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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  compileEconomy,
  resolveEconomyModule,
} from '@pwngh/economy-core/module';
import { runEconomy } from '../src/index.js';
import {
  COMMANDS,
  FLAGS,
  VERBS,
  flagForm,
  parse,
} from '../src/lib/parse-args.js';
import {
  PKG,
  runInjected,
  runSync,
  withoutSelectedBackends,
} from './support/process.js';

const run = (args: string[]) => runSync(args, PKG);

/** One verb run with both streams injected, in a process whose real streams this test owns. */
const injected = (args: string[], env: Record<string, string> = {}) =>
  runInjected(args, PKG, env);

/** The committed rendering of every help page. See {@link helpPages} for how to regenerate it. */
const GOLDEN = join(import.meta.dirname, 'fixtures', 'help.golden.txt');

/** A sink that keeps what a verb wrote, standing in for a process stream. */
function sink(): { write(text: string): boolean; text(): string } {
  let held = '';
  return {
    write: (text) => {
      held += text;
      return true;
    },
    text: () => held,
  };
}

// This helper captures and restores console.log rather than printing to it; no-console reads
// those references as prints, so the ban is lifted for the swap and put back after it. It stops
// at the console: node:test writes this file's own result frames to the real streams, so the
// other half of the claim is held where nothing else writes them — see {@link runInjected}.
/* eslint-disable no-console */
async function offConsole<T>(
  body: () => Promise<T>,
): Promise<{ value: T; leaked: string[] }> {
  const leaked: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => {
    leaked.push(`console.log ${String(a[0])}`);
  };
  console.error = (...a: unknown[]) => {
    leaked.push(`console.error ${String(a[0])}`);
  };
  try {
    return { value: await body(), leaked };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** What a verb that ignored its sinks would do, so the guard above can be watched to fire. */
const printToConsole = (): void => {
  console.log('a report');
  console.error('a refusal');
};
/* eslint-enable no-console */

const sampleArgv = (verb: string, flag: (typeof FLAGS)[number]): string[] =>
  flag.takes === null ? [verb, flag.flag] : [verb, flag.flag, '1'];

/**
 * Every help page rendered, in one string, in the shape the golden holds them.
 *
 * Regenerate the golden by running this file with `HELP_GOLDEN=write`, then READ the diff: a
 * changed sentence is the point of the fixture, not an obstacle to it.
 */
async function helpPages(): Promise<string> {
  const parts: string[] = [];
  const roster = sink();
  assert.equal(await runEconomy(['--help'], { stdout: roster }), 0);
  parts.push(`=== economy --help ===\n${roster.text()}`);
  for (const verb of VERBS) {
    const out = sink();
    assert.equal(await runEconomy([verb, '--help'], { stdout: out }), 0);
    parts.push(`=== economy ${verb} --help ===\n${out.text()}`);
  }
  return parts.join('');
}

// Help renders from COMMANDS and FLAGS, so asserting the output back against those two tables
// proves only that the renderer read them: set `--watch`'s describe to 'does nothing' and every
// such assertion stays green while the page now lies about the flag. The golden is the one thing
// that makes the sentence itself a reviewable diff.
test('every help page is byte-identical to the committed golden', async () => {
  const rendered = await helpPages();
  if (process.env.HELP_GOLDEN === 'write') {
    writeFileSync(GOLDEN, rendered);
  }
  assert.equal(
    rendered,
    readFileSync(GOLDEN, 'utf8'),
    'the help text changed — read the diff, then rerun with HELP_GOLDEN=write',
  );
  // A golden of an empty render would also compare equal, so state what it holds.
  assert.equal(rendered.split('=== economy ').length - 1, 6);
  assert.ok(rendered.length > 2_000, `golden is ${rendered.length} bytes`);
});

test('--help and -h are the same request, on stdout, exit 0, nothing on stderr', async () => {
  const texts: string[] = [];
  for (const spelling of ['--help', '-h']) {
    const out = sink();
    const err = sink();
    assert.equal(
      await runEconomy([spelling], { stdout: out, stderr: err }),
      0,
      `${spelling} is a request, not a refusal`,
    );
    assert.equal(err.text(), '', `${spelling} writes nothing to stderr`);
    texts.push(out.text());
  }
  assert.equal(texts[0], texts[1], '-h is the long spelling, not a summary');
});

test('every verb page names its usage line, its flags heading, and its example', async () => {
  for (const spec of COMMANDS) {
    const out = sink();
    assert.equal(await runEconomy([spec.verb, '--help'], { stdout: out }), 0);
    const text = out.text();
    assert.ok(
      text.startsWith(`economy ${spec.verb} — ${spec.describe}\n`),
      `${spec.verb} opens with its roster line`,
    );
    assert.ok(
      text.includes(`\nusage: economy ${spec.verb} `),
      `${spec.verb} states a usage line`,
    );
    assert.ok(text.includes('\nflags:\n'), `${spec.verb} states its flags`);
    assert.ok(
      text.includes(`  ${spec.example}   # ${spec.result}`),
      `${spec.verb} help carries its worked example`,
    );
    // The flag column is padded; compare with the runs of spaces collapsed.
    const squashed = text.replace(/ {2,}/g, ' ');
    const honored = FLAGS.filter((f) => f.verbs.includes(spec.verb));
    for (const flag of honored) {
      assert.ok(
        squashed.includes(
          `${flagForm(flag)} ${flag.describe} (default: ${flag.fallback})`,
        ),
        `${spec.verb} help states ${flag.flag} with its default`,
      );
    }
    assert.equal(
      honored.length,
      FLAG_SCOPE_COUNTS[spec.verb],
      `${spec.verb} honors a different number of flags than the roster states`,
    );
  }
});

// help and parse read one table, so their agreeing resolves nothing about which verbs a flag
// belongs to. This is that table written out. The finding it closes: move `--json` from
// ['check','routes'] to ['dev'] and both the help gate and the parse gate agreed with the new
// wrong answer, because both re-read the mutated array.
const FLAG_SCOPE: Record<string, readonly string[]> = {
  '--app': ['dev', 'serve', 'worker', 'check', 'routes'],
  '--demo': ['dev', 'worker'],
  '--watch': ['dev'],
  '--no-worker': ['dev', 'serve'],
  '--json': ['check', 'routes'],
  '--desugar': ['check'],
  '--quiet-lints': ['check'],
  '--host': ['dev', 'serve'],
  '--port': ['dev', 'serve'],
  '--interval': ['dev', 'serve', 'worker'],
  '--batch': ['dev', 'serve', 'worker'],
};

/** How many flags each verb honors, derived from the literal above and never from FLAGS. */
const FLAG_SCOPE_COUNTS: Record<string, number> = Object.fromEntries(
  ['dev', 'serve', 'worker', 'check', 'routes'].map((verb) => [
    verb,
    Object.values(FLAG_SCOPE).filter((verbs) => verbs.includes(verb)).length,
  ]),
);

test('the roster and the flag scope table are these written-out rows', () => {
  assert.deepEqual(
    [...VERBS],
    ['dev', 'serve', 'worker', 'check', 'routes'],
    'a verb added or renamed is read here first',
  );
  assert.deepEqual(
    Object.fromEntries(FLAGS.map((flag) => [flag.flag, [...flag.verbs]])),
    FLAG_SCOPE,
    'a flag whose scope moved is read here first',
  );
  assert.equal(FLAGS.length, 11, `the table holds ${FLAGS.length} flags`);
  assert.deepEqual(FLAG_SCOPE_COUNTS, {
    dev: 8,
    serve: 6,
    worker: 4,
    check: 4,
    routes: 2,
  });
});

// The whole point of generating help from the parser's own table: a page cannot name a flag
// the parser rejects, and a flag cannot ship without a page that states it.
test('help and the parser read one table: no flag on a page the parser refuses, none unlisted', async () => {
  const pages = new Map<string, string>();
  for (const verb of VERBS) {
    const out = sink();
    await runEconomy([verb, '--help'], { stdout: out });
    pages.set(verb, out.text());
  }
  for (const [verb, text] of pages) {
    for (const flag of FLAGS) {
      const listed = new RegExp(`^  \\${flag.flag}[ (]`, 'm').test(text);
      if (!listed) continue;
      assert.ok(
        parse(sampleArgv(verb, flag)).ok,
        `${verb} help lists ${flag.flag}, which the parser refuses`,
      );
    }
  }
  for (const flag of FLAGS) {
    const pagesWith = [...pages]
      .filter(([, text]) => new RegExp(`^  \\${flag.flag}[ (]`, 'm').test(text))
      .map(([verb]) => verb);
    assert.deepEqual(
      pagesWith,
      [...flag.verbs],
      `${flag.flag} is stated on exactly the verbs that honor it`,
    );
  }
});

test('the defaults help prints are the knob table the framework compiles', async () => {
  const plan = await compileEconomy(
    resolveEconomyModule({ authenticate: false }),
    {},
  );
  const value = (key: string): string =>
    String(plan.knobs.find((k) => k.key === key)!.value);
  for (const [flag, key] of [
    ['--port', 'PORT'],
    ['--interval', 'WORKER_INTERVAL_MS'],
    ['--batch', 'WORKER_BATCH'],
  ] as const) {
    assert.equal(
      FLAGS.find((f) => f.flag === flag)!.fallback,
      value(key),
      `${flag} states the compiled default for ${key}`,
    );
  }
});

test('--version and -v print this package name and version, and exit 0', async () => {
  const { name, version } = JSON.parse(
    readFileSync(join(PKG, 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  for (const spelling of ['--version', '-v']) {
    const out = sink();
    const err = sink();
    assert.equal(await runEconomy([spelling], { stdout: out, stderr: err }), 0);
    assert.equal(out.text(), `${name} ${version}\n`);
    assert.equal(err.text(), '');
  }
});

test('the bin answers help and version too: stdout, exit 0, nothing on stderr', () => {
  const roster = run(['--help']);
  assert.equal(roster.status, 0, roster.stderr);
  assert.match(roster.stdout, /^economy — run an economy module/);
  assert.equal(roster.stderr, '');

  const page = run(['routes', '--help']);
  assert.equal(page.status, 0, page.stderr);
  assert.match(page.stdout, /^usage: economy routes /m);

  const version = run(['-v']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^@pwngh\/economy-cli \d+\.\d+\.\d+\n$/);
});

test('an unknown verb still refuses: usage on stderr, exit 2, nothing on stdout', async () => {
  const out = sink();
  const err = sink();
  assert.equal(
    await runEconomy(['frobnicate'], { stdout: out, stderr: err }),
    2,
  );
  assert.equal(out.text(), '');
  assert.match(err.text(), /^usage: economy </);
  assert.match(
    err.text(),
    /economy <verb> --help/,
    'the usage line points at help',
  );
});

test('the streams are injectable: a report verb writes to the sink and never to the console', async () => {
  const out = sink();
  const err = sink();
  // In process, so the environment is this one: cleared of the backends a machine names, or the
  // verb answers 2 on a preflight refusal the test never stated.
  const { value, leaked } = await withoutSelectedBackends(() =>
    offConsole(() => runEconomy(['check'], { stdout: out, stderr: err })),
  );
  assert.equal(value, 0, err.text());
  assert.match(out.text(), /seams/, 'the report landed in the sink');
  assert.deepEqual(leaked, [], 'nothing reached the real console');
});

test('offConsole holds what reaches the real console', async () => {
  const { leaked } = await offConsole(async () => printToConsole());
  assert.deepEqual(leaked, ['console.log a report', 'console.error a refusal']);
});

// The verbs that boot: their refusals ran through console.error until the streams were
// threaded, so both roles are proved on a path that never binds a socket.
test('the streams are injectable: a service verb refuses into the sink, not the console', async () => {
  const held = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const out = sink();
    const err = sink();
    const { value, leaked } = await offConsole(() =>
      runEconomy(['dev'], { stdout: out, stderr: err }),
    );
    assert.equal(value, 1);
    assert.match(err.text(), /economy dev is the dev posture/);
    assert.equal(out.text(), '');
    assert.deepEqual(leaked, [], 'nothing reached the real console');
  } finally {
    if (held === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = held;
  }
});

test('serve refuses into the sink the same way', async () => {
  const out = sink();
  const err = sink();
  const { value, leaked } = await offConsole(() =>
    runEconomy(['serve'], { stdout: out, stderr: err }),
  );
  assert.equal(value, 1);
  assert.match(err.text(), /economy serve is the production posture/);
  assert.deepEqual(leaked, [], 'nothing reached the real console');
});

test('the streams are injectable: neither real stream is written at all', () => {
  const report = injected(['check']);
  const said = report.said();
  assert.equal(said.code, 0, said.err);
  assert.match(said.out, /seams/, 'the report landed in the sink');
  assert.equal(report.stdout, '', 'the real stdout was never written');
  assert.equal(report.stderr, '', 'the real stderr was never written');

  const refusal = injected(['serve']);
  const refused = refusal.said();
  assert.equal(refused.code, 1);
  assert.match(refused.err, /economy serve is the production posture/);
  assert.equal(refusal.stdout, '', 'the real stdout was never written');
  assert.equal(refusal.stderr, '', 'the real stderr was never written');
});

test('a write to either real stream is seen', () => {
  assert.match(
    injected(['check'], { LEAK: 'stdout' }).stdout,
    /leaked to the real stdout/,
  );
  assert.match(
    injected(['check'], { LEAK: 'stderr' }).stderr,
    /leaked to the real stderr/,
  );
});

/**
 * Every source file the two tripwires below sweep, named. A floor cannot say "these exact files":
 * a walker bug returning eight of ten, or two files moved, satisfies `>= 8` while whatever went
 * missing silently stops being audited.
 */
const SOURCES = [
  'index.ts',
  'lib/cli.ts',
  'lib/commands/check.ts',
  'lib/commands/routes.ts',
  'lib/commands/service.ts',
  'lib/help.ts',
  'lib/module.ts',
  'lib/parse-args.ts',
  'lib/platform.ts',
  'lib/render.ts',
];

const sources = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [join(dir, e.name)]
          : [],
    );
  const root = join(PKG, 'src');
  const files = walk(root);
  assert.deepEqual(
    files.map((file) => file.slice(root.length + 1)).sort(),
    SOURCES,
    'the source roster moved — read the new file, then name it here',
  );
  return files;
};

// The tripwire behind the threading: a hard-coded console call is invisible to a host that
// drives the CLI in-process, so no source file may carry one.
test('no source file writes to the console', () => {
  const offenders = sources().filter((f) =>
    /\bconsole\.\w+\(/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(
    offenders,
    [],
    'these files write to the console instead of the injected stream',
  );
});

// The README's headline claim, enforced: runEconomy resolves a code, and a process.exit
// anywhere under it kills the host that embedded the CLI instead of answering.
test('no source file calls process.exit', () => {
  const offenders = sources().filter((f) =>
    /\bprocess\.exit\(/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(
    offenders,
    [],
    'these files exit the process instead of resolving a code',
  );
});

test('a flag the verb does not take is a usage error naming where it belongs', async () => {
  const err = sink();
  const out = sink();
  assert.equal(
    await runEconomy(['check', '--demo'], { stdout: out, stderr: err }),
    2,
  );
  assert.equal(out.text(), '');
  assert.match(err.text(), /economy check does not take --demo/);
  assert.match(
    err.text(),
    /dev and worker flag/,
    'the refusal names the verbs that do take it',
  );
  assert.match(err.text(), /economy check --help/, 'the refusal names the fix');
});

test('an out-of-scope flag refuses on every verb that does not honor it', () => {
  for (const flag of FLAGS) {
    for (const verb of VERBS) {
      const result = parse(sampleArgv(verb, flag));
      assert.equal(
        result.ok,
        flag.verbs.includes(verb),
        `economy ${verb} ${flag.flag} is ${flag.verbs.includes(verb) ? 'honored' : 'out of scope'}`,
      );
    }
  }
});
