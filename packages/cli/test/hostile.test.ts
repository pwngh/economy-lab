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
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEconomyDir } from '../src/lib/module.js';
import { PKG, runSync } from './support/process.js';

// serve owns all three flags and refuses on posture with exit 1, so a fold that stopped
// rejecting shows up as the wrong code here instead of booting a server this test cannot stop.
test('parse refuses a non-numeric knob value with usage exit 2', () => {
  assert.equal(runSync(['serve', '--port', 'abc'], PKG).status, 2);
  assert.equal(runSync(['serve', '--interval', '5x'], PKG).status, 2);
  assert.equal(runSync(['serve', '--batch', 'many'], PKG).status, 2);
});

test('usage refusals land on stderr, like every other refusal', () => {
  const r = runSync(['frobnicate'], PKG);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: economy/);
});

// Each verb below answers 0 or 1 on its own, so the 2 is the junk being refused and not the
// verb's ordinary exit.
test('trailing positional junk refuses with usage exit 2', () => {
  assert.equal(runSync(['check', 'junk'], PKG).status, 2);
  assert.equal(runSync(['routes', 'junk'], PKG).status, 2);
  assert.equal(runSync(['serve', 'junk'], PKG).status, 2);
});

// Everything the repo's own .env sets. The package fan-out runs under
// `--env-file-if-exists=.env`, so these are the values a spawned verb actually meets on this
// machine; DATABASE_URL alone decides which store the CLI opens.
const AMBIENT: Record<string, string> = {
  DATABASE_URL: 'postgres://poison:poison@127.0.0.1:1/nothing',
  PG_URL: 'postgres://poison:poison@127.0.0.1:1/nothing',
  MYSQL_TEST_URL: 'mysql://poison:poison@127.0.0.1:1/nothing',
  REDIS_URL: 'redis://127.0.0.1:1',
  SIGNING_SECRET: 'sig_ambient',
  WEBHOOK_SECRET: 'whsec_ambient',
  TASKQ: 'poison',
};

/** Runs `body` with AMBIENT laid over this process's environment, then puts it back. */
function poisoned<T>(body: () => T): T {
  const held = new Map(
    Object.keys(AMBIENT).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, AMBIENT);
    return body();
  } finally {
    for (const [name, value] of held) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Every refusal above states no environment at all, so a name the machine happens to hold is the
// one way one of them can refuse for a reason it never asked for. This runs two of them under an
// environment built to cause exactly that.
test('a refused verb reads the environment this file states and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-hostile-'));
  writeFileSync(
    join(dir, 'economy.app.ts'),
    "console.error('SAW ' + JSON.stringify(process.env));\n" +
      'export const authenticate = false;\n',
  );

  const seen = poisoned(() => ({
    checked: runSync(['check', '--json'], dir),
    refused: runSync(['serve', '--port', 'abc'], dir),
  }));

  assert.equal(seen.checked.status, 0, seen.checked.stderr);
  const saw = JSON.parse(
    /^SAW (\{.*\})$/m.exec(seen.checked.stderr)?.[1] ??
      assert.fail(
        `the module never reported its environment:\n${seen.checked.stderr}`,
      ),
  ) as Record<string, string>;

  // Written out here rather than read back from the helper, which would agree with itself
  // whatever it passed. macOS CoreFoundation stamps __CF_USER_TEXT_ENCODING into every process it
  // starts whatever environment it is handed; it is absent on Linux, where the filter drops
  // nothing.
  const machine = ['HOME', 'PATH', 'TMPDIR'].filter(
    (name) => process.env[name] !== undefined,
  );
  assert.deepEqual(
    Object.keys(saw)
      .filter((name) => name !== '__CF_USER_TEXT_ENCODING')
      .sort(),
    [...machine, 'NODE_ENV'].sort(),
  );
  for (const name of Object.keys(AMBIENT)) {
    assert.equal(
      saw[name],
      undefined,
      `${name} reached the verb from the machine`,
    );
  }

  // The store the ambient DATABASE_URL would have chosen, had it arrived.
  const report = JSON.parse(seen.checked.stdout) as {
    adapters: { store: { kind: string; url: string | null } };
  };
  assert.deepEqual(report.adapters.store, { kind: 'memory', url: null });

  // And why no call site here needs to neutralise a name by hand: the parse refusal lands on its
  // own terms while the machine names a postgres database the CLI has no adapter for.
  assert.equal(seen.refused.status, 2, seen.refused.stderr);
  assert.match(seen.refused.stderr, /usage: economy/);
});

// The test above proves one spawn states its environment. This proves the rest do, because the
// leak it closes spreads by copy: six helpers in this directory each built a child out of the
// parent environment, and a seventh is one paste away. The patterns below are written as escapes,
// so this file is scanned along with the others rather than matching itself.
test('no test in this package hands a child the machine environment', () => {
  const HERE = new URL('.', import.meta.url).pathname;
  const files = readdirSync(HERE)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  assert.deepEqual(
    files,
    [
      'cli.test.ts',
      'dev-serve.test.ts',
      'help.test.ts',
      'honesty.test.ts',
      'hostile.test.ts',
      'interop-fuzz.test.ts',
      'live.test.ts',
      'loader.test.ts',
      'platform.test.ts',
      'refusal-fix.test.ts',
      'render.test.ts',
    ],
    'a test file arrived or left — add it here, and route any spawn it makes through runSync',
  );
  const sources = new Map(
    [...files, 'support/injected.ts', 'support/process.ts'].map((name) => [
      name,
      readFileSync(join(HERE, name), 'utf8'),
    ]),
  );

  // Which files spawn a child at all. Everything else reaches the CLI through runSync or runLive,
  // so childEnv states its environment and this roster is the whole surface to police. It also
  // keeps the scan honest: a regex that stopped matching returns an empty roster here.
  const spawns = [...sources]
    .filter(([, src]) => /\bspawn(Sync)?\(/.test(src))
    .map(([name]) => name);
  assert.deepEqual(spawns, [
    'dev-serve.test.ts', // spawns node itself: the built entry under --watch, and the strip-types flag
    'honesty.test.ts', // proves a worker exits naturally after its output sink throws
    'support/process.ts', // the helper every spawn of a verb goes through
  ]);

  // Reading a name is how a test poisons its own environment and puts it back; spreading the
  // object is how the machine reaches a child. Only the second is banned.
  const reads = [...sources]
    .filter(([, src]) => /\bprocess\.env\b/.test(src))
    .map(([name]) => name);
  assert.deepEqual(reads, [
    'help.test.ts', // holds NODE_ENV across an in-process call
    'honesty.test.ts', // fixture-module source, and the worker undo test reads one name back
    'hostile.test.ts', // poisons and restores AMBIENT above
    'live.test.ts', // the same, for the live verbs
    'support/injected.ts', // reads LEAK, the name that asks it to write to a real stream
    'support/process.ts', // childEnv, reading the three machine names by name
  ]);
  // An empty result passes while examining nothing, so the pattern is turned on a sample carrying
  // the leak first. The sample is joined at run time to keep it out of the scan above.
  const SPREAD = /\.\.\.process\.env/;
  assert.match(`env: { ...process` + `.env, NODE_ENV: '' }`, SPREAD);
  const spread = [...sources]
    .filter(([, src]) => SPREAD.test(src))
    .map(([name]) => name);
  assert.deepEqual(
    spread,
    [],
    'these hand a child the whole machine environment',
  );
});

test('loader skips dotfiles under routes/ and webhooks/ instead of refusing the module', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-dot-'));
  mkdirSync(join(dir, 'routes', 'webhooks'), { recursive: true });
  writeFileSync(join(dir, 'app.ts'), 'export const authenticate = false;\n');
  writeFileSync(
    join(dir, 'routes', 'gift.ts'),
    'export function get() { return new Response("g"); }\n',
  );
  writeFileSync(join(dir, 'routes', '.DS_Store'), 'finder junk');
  writeFileSync(join(dir, 'routes', 'webhooks', '.gitkeep'), '');
  const mod = await loadEconomyDir(dir, { label: 'x' });
  assert.deepEqual(Object.keys(mod.routes ?? {}), ['GET /gift']);
});
