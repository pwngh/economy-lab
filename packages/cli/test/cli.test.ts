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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERBS, parse } from '../src/lib/parse-args.js';
import { PKG, runSync } from './support/process.js';

test('worker verb with `worker: false` refuses (ROLE_CONFLICT)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-cli-'));
  const file = join(dir, 'conflict.app.ts');
  writeFileSync(
    file,
    'export const authenticate = false;\nexport const worker = false;\n',
  );
  const r = runSync(['worker', '--app', file], PKG);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ROLE_CONFLICT/);
});

test('unknown verb and missing flag value both print usage on stderr and exit 2', () => {
  const unknown = runSync(['frobnicate'], PKG);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: economy/);
  const missing = runSync(['check', '--app'], PKG);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: economy/);
});

// Bare `economy` used to run `dev` — a service, from the emptiest input, while an unknown verb
// only printed usage. There is no implicit verb now: a missing verb refuses the way an unknown
// one does, and the roster is the only door to a boot.
test('a missing verb refuses with usage and starts nothing', () => {
  const bare = runSync([], PKG);
  assert.equal(bare.status, 2, `bare economy answered ${String(bare.status)}`);
  assert.equal(bare.stdout, '', 'a refusal prints no banner');
  assert.match(bare.stderr, /usage: economy </);
  // The same seam from the other side: a leading flag is not a verb, so there is no implicit
  // one for it to reach either.
  const flagFirst = runSync(['--port', '3000'], PKG);
  assert.equal(flagFirst.status, 2);
  assert.match(flagFirst.stderr, /usage: economy </);
  // Positive control: a named verb still dispatches.
  assert.equal(parse(['dev']).ok, true);
  assert.equal(parse([]).ok, false);
});

// The parser refused an out-of-scope flag by name and still resolved two conflicting values
// silently: `--port 3000 --port 4000` bound 4000. A repeated value flag now refuses too.
test('a value flag given twice refuses naming both values', () => {
  const twice = runSync(['dev', '--port', '3000', '--port', '4000'], PKG);
  assert.equal(twice.status, 2);
  assert.match(
    twice.stderr,
    /--port is given twice — `3000` then `4000`; drop one/,
  );
  for (const argv of [
    ['dev', '--app', 'a.ts', '--app', 'b.ts'],
    ['serve', '--host', '::1', '--host', '0.0.0.0'],
    ['worker', '--interval', '5000', '--interval', '5000'],
  ]) {
    assert.equal(parse(argv).ok, false, `${argv.join(' ')} was accepted`);
  }
  // Positive controls: two different value flags still parse, and each keeps its value.
  const parsed = parse(['dev', '--port', '3000', '--interval', '5000']);
  assert.ok(parsed.ok, 'two different value flags refused');
  assert.equal(parsed.args.flags.PORT, 3000);
  assert.equal(parsed.args.flags.WORKER_INTERVAL_MS, 5000);
});

// `check --json --desugar` printed the JSON and dropped the desugar with no mention. Both
// flags mean something now: the desugar rides the report as one more field.
test('check --json --desugar carries the desugar in the JSON report', () => {
  const both = runSync(['check', '--json', '--desugar'], PKG);
  assert.equal(both.status, 0, both.stderr);
  const report = JSON.parse(both.stdout) as {
    desugar?: string;
    postures: unknown[];
  };
  assert.match(
    report.desugar ?? '',
    /createEconomy/,
    'the JSON carries the floor calls',
  );
  assert.ok(Array.isArray(report.postures), 'the report is still the report');
  // And neither flag changes the other's plain form.
  const alone = JSON.parse(runSync(['check', '--json'], PKG).stdout) as Record<
    string,
    unknown
  >;
  assert.ok(!('desugar' in alone), '--json alone stays as it was');
  const floor = runSync(['check', '--desugar'], PKG);
  assert.equal(floor.status, 0, floor.stderr);
  assert.match(floor.stdout, /createEconomy/);
  assert.ok(
    !floor.stdout.trimStart().startsWith('{'),
    '--desugar alone is the floor text, not JSON',
  );
});

test('dev hardening: refuses NODE_ENV=production — the mirror of serve', () => {
  const r = runSync(['dev'], PKG, { NODE_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dev posture/);
  assert.match(r.stderr, /economy serve/);
});

test('serve hardening: refuses outside production, refuses --demo, refuses dev stand-ins', () => {
  const outside = runSync(['serve'], PKG);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /production posture/);

  assert.equal(
    runSync(['serve', '--demo'], PKG, { NODE_ENV: 'production' }).status,
    2,
  );

  const standIns = runSync(['serve'], PKG, { NODE_ENV: 'production' });
  assert.equal(standIns.status, 1);
  assert.match(standIns.stderr, /AUTH_POSTURE|preflight/);
});

// The roster tripwire: five framework verbs — run the app, and say what it is. Operating a
// live economy is the lab's job. Growing this list is a deliberate event, never a fix-to-pass.
test('the roster is exactly the five framework verbs', () => {
  assert.deepEqual([...VERBS], ['dev', 'serve', 'worker', 'check', 'routes']);
});

test('check and routes run on defaults from this package root', () => {
  const checked = runSync(['check'], PKG);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /seams/);
  const routed = runSync(['routes'], PKG);
  assert.equal(routed.status, 0, routed.stderr);
  assert.match(routed.stdout, /auth/);
});
