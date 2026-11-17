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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEconomy } from '../src/index.js';
import {
  PKG,
  TSX,
  childEnv,
  runSync,
  withoutSelectedBackends,
} from './support/process.js';

// A postgres nothing is listening on: preflight refuses on the name before a driver loads, so
// this never opens a socket.
const POSTGRES = 'postgres://u:p@127.0.0.1:5432/nope';

/** A project whose module wires one port and leaves the store to the environment — the shape
 *  this repository's own `economy/app.ts` has, and the one the two verbs disagreed on. */
function project(env: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'economy-honesty-'));
  writeFileSync(
    join(dir, 'economy.app.ts'),
    'export const authenticate = false;\nexport const ports = { dispatcher: false };\n',
  );
  if (env !== null) writeFileSync(join(dir, '.env'), env);
  return dir;
}

// The failure `check` cannot be allowed to have: it exists to answer whether the boot will work,
// and it printed `preflight clean` in front of a `dev` that refused on the same directory. Two
// causes, both live: `check` compiled the raw module while `dev` boots `withDev(module)`, and
// `dev` re-execs under `--env-file` while `check` never read the file at all.
test('a check that passes is a promise dev keeps, .env included', () => {
  const dir = project(`DATABASE_URL=${POSTGRES}\n`);

  const checked = runSync(['check'], dir);
  assert.equal(
    checked.status,
    2,
    `check answered ${checked.status} on a directory dev refuses:\n${checked.stdout}`,
  );
  assert.match(checked.stdout, /^env {7}\.env in place for this reading/m);
  assert.match(checked.stdout, /^preflight deployed and dev agree — 1 issue/m);
  assert.match(checked.stdout, /port\.unsupplied {2}DATABASE_URL/);

  // And the boot it predicted, on the same directory, refusing for the same reason.
  const booted = runSync(['dev'], dir);
  assert.equal(booted.status, 1, booted.stdout);
  assert.match(booted.stderr, /DATABASE_URL names a postgres:\/\/ database/);
});

// The module file is a program, and this one decides its ports while it is being imported. So the
// `.env` has to be in place before the load, not merged into the preflight afterwards: `check`
// used to read a module with no ports at all where `dev` read one wiring a dispatcher.
test('the module is loaded under the environment the run will have', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-envmod-'));
  writeFileSync(
    join(dir, 'economy.app.ts'),
    'export const authenticate = false;\n' +
      'export const ports = process.env.WIRE_IT ? { dispatcher: false } : undefined;\n',
  );
  writeFileSync(join(dir, '.env'), `WIRE_IT=1\nDATABASE_URL=${POSTGRES}\n`);
  const checked = runSync(['check'], dir);
  // Without the .env the module states no ports and `withDev` would fill the store, so dev would
  // read clean. With it the module wires a dispatcher and neither posture supplies a store.
  assert.equal(checked.status, 2, checked.stdout);
  assert.match(checked.stdout, /^seams .*[^(]\bports\b/m);
  assert.match(checked.stdout, /^preflight deployed and dev agree — 1 issue/m);

  const booted = runSync(['dev'], dir);
  assert.equal(booted.status, 1, booted.stdout);
  assert.match(booted.stderr, /DATABASE_URL names a postgres:\/\/ database/);
});

// Refusing everything would satisfy the test above. A project whose environment names nothing
// still has to come up clean and answer 0, and the same project with the store wired has to stay
// clean once the .env names one.
test('a clean project still reports clean, before and after its .env names a backend', () => {
  const bare = runSync(['check'], project(null));
  assert.equal(bare.status, 0, `${bare.stdout}\n${bare.stderr}`);
  assert.match(bare.stdout, /^preflight deployed and dev agree — clean$/m);
  assert.ok(!bare.stdout.includes('env       '), 'no .env, so no env row');

  // A .env that names nothing the module has to supply leaves both postures clean.
  const quiet = runSync(['check'], project('WEBHOOK_SECRET=whsec_x\n'));
  assert.equal(quiet.status, 0, `${quiet.stdout}\n${quiet.stderr}`);
  assert.match(quiet.stdout, /^preflight deployed and dev agree — clean$/m);
  assert.match(quiet.stdout, /^env {7}\.env in place for this reading/m);
});

// `economy serve` through the bin was the one door that read no `.env`: dev re-execs under
// --env-file, the npm scripts spell out --env-file-if-exists, check and routes adopt it. So the
// verb check describes as *deployed* was the only one whose environment check could not have.
// One rule now covers all five: every verb runs under `.env` when it exists, already-set wins.
test('serve judges the module under the .env beside it', () => {
  const dir = project(`DATABASE_URL=${POSTGRES}\n`);
  const refused = runSync(['serve'], dir, { NODE_ENV: 'production' });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /\.env in place — a name already set wins/);
  assert.match(
    refused.stderr,
    /DATABASE_URL/,
    'the refusal never saw the file',
  );
  assert.match(refused.stderr, /serve refuses dev stand-ins/);

  // Without the file the same door still refuses on the missing production anchors, but
  // nothing names the postgres the environment never stated: the file is that name's one
  // source, so its appearance above is the read.
  const bare = runSync(['serve'], project(null), { NODE_ENV: 'production' });
  assert.equal(bare.status, 1);
  assert.doesNotMatch(bare.stderr, /DATABASE_URL/);
});

// The worker role is the other deployed door, driven in process so the undo is observable:
// a host calling runEconomy keeps its own environment once the run has answered.
test('worker adopts .env for the run and gives back what it added', async () => {
  const dir = project(`DATABASE_URL=${POSTGRES}\n`);
  const cwd = process.cwd();
  let held = '';
  const err = {
    write: (text: string) => {
      held += text;
      return true;
    },
  };
  const quiet = { write: () => true };
  process.chdir(dir);
  try {
    await withoutSelectedBackends(async () => {
      const running = runEconomy(['worker'], { stdout: quiet, stderr: err });
      // The refusal answers at once. A worker that boots instead holds the run open on the
      // parked timer, so that failure is caught here and unwedged, not waited out.
      let timer: NodeJS.Timeout | undefined;
      const wedged = new Promise<'wedged'>((settle) => {
        timer = setTimeout(() => settle('wedged'), 5_000);
      });
      const code = await Promise.race([running, wedged]);
      clearTimeout(timer);
      if (code === 'wedged') {
        process.emit('SIGTERM');
        await running;
        assert.fail(
          'worker booted instead of refusing — .env never reached the load',
        );
      }
      assert.equal(code, 1, held);
      // The name came from the file, refused the boot, and is gone again.
      assert.equal(
        process.env.DATABASE_URL,
        undefined,
        'the .env name outlived the run',
      );
    });
  } finally {
    process.chdir(cwd);
  }
  assert.match(held, /DATABASE_URL names a postgres:\/\/ database/);
});

// The dev posture is only reported where dev can run: it refuses NODE_ENV=production outright.
test('a production environment reports the deployed posture alone', () => {
  const dir = project(null);
  const r = runSync(['check'], dir, { NODE_ENV: 'production' });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /^preflight deployed \(economy serve, worker\) — /m);
  assert.ok(!r.stdout.includes('preflight dev'), 'dev cannot run here');
});

// `--port 0x1f` bound 31. The flag path used `Number`; the environment path has used the lab's
// integer rule all along, and the comment there names this exact case as fixed.
test('a numeric flag admits what the environment admits, and names the rule when it refuses', () => {
  const refused: Array<[string, string]> = [
    ['--port', '0x1f'],
    ['--port', '8080.5'],
    ['--port', '-1'],
    ['--port', 'Infinity'],
    ['--port', '1e3'],
    ['--port', '65536'],
    ['--interval', '0'],
    ['--batch', '0'],
    ['--batch', '2.5'],
  ];
  assert.equal(refused.length, 9, `${refused.length} values checked`);
  for (const [flag, value] of refused) {
    const r = runSync(['dev', flag, value], PKG);
    assert.equal(r.status, 2, `economy dev ${flag} ${value} was accepted`);
    assert.match(
      r.stderr,
      new RegExp(
        `^\\${flag} takes a whole number .* — \`${value}\` is not one$`,
        'm',
      ),
      `${flag} ${value} refused without naming the rule:\n${r.stderr}`,
    );
  }
  // Positive controls: a valid port parses, and `--port 0` still asks the OS to pick one — the
  // one row where a typed value is admitted that a deploy file's PORT is not.
  for (const value of ['0', '8080', '65535']) {
    const parsed = runSync(['dev', '--port', value, '--app', 'no.app.ts'], PKG);
    assert.notEqual(
      parsed.status,
      2,
      `--port ${value} was refused:\n${parsed.stderr}`,
    );
    assert.ok(
      !parsed.stderr.includes('takes a whole number'),
      `--port ${value} was refused:\n${parsed.stderr}`,
    );
  }
});

test('a worker whose banner sink throws releases its parked timer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-worker-sink-'));
  writeFileSync(
    join(dir, 'economy.app.ts'),
    'export const authenticate = false;\n',
  );
  const cli = new URL('../src/index.ts', import.meta.url).href;
  // No process.exit: a forgotten interval must keep the child alive and hit the bound.
  const source = `import { runEconomy } from ${JSON.stringify(cli)};
process.exitCode = await runEconomy(['worker'], {
  stdout: { write() { throw new Error('banner sink failed'); } },
});`;
  const run = spawnSync(
    process.execPath,
    ['--import', TSX, '--input-type=module', '-e', source],
    { cwd: dir, encoding: 'utf8', env: childEnv(), timeout: 10_000 },
  );
  assert.match(run.stderr, /banner sink failed/);
  assert.equal(
    run.error,
    undefined,
    'worker stayed alive after its sink threw',
  );
  assert.equal(run.signal, null);
  assert.equal(run.status, 1);
});

test('the dev banner is printed only once shutdown can handle a signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-ready-signal-'));
  const cwd = process.cwd();
  let handled = false;
  const out = {
    write: (text: string) => {
      if (text.startsWith('economy dev — ')) {
        handled = process.emit('SIGTERM');
        // Before the fix the banner preceded the handler. Drain on the next turn so that
        // regression fails the assertion instead of leaving the server running.
        if (!handled) setImmediate(() => process.emit('SIGTERM'));
      }
      return true;
    },
  };
  process.chdir(dir);
  try {
    await withoutSelectedBackends(async () => {
      const code = await runEconomy(['dev', '--port', '0'], {
        stdout: out,
        stderr: { write: () => true },
      });
      assert.equal(code, 0);
      assert.equal(handled, true, 'the banner preceded the shutdown handler');
    });
  } finally {
    process.chdir(cwd);
  }
});

// runEconomy is documented as never calling process.exit so a host can drive the CLI in-process.
// In that path the watcher and the signal handlers outlived the run: the FSWatcher held the host's
// event loop open and could still fire, building a second app against a service already closed.
test('an in-process run releases its watcher and its signal handlers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-lifecycle-'));
  writeFileSync(
    join(dir, 'economy.app.ts'),
    'export const authenticate = false;\n',
  );
  const cwd = process.cwd();
  const quiet = { write: () => true };
  const before = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
  process.chdir(dir);
  try {
    await withoutSelectedBackends(async () => {
      for (let run = 0; run < 3; run += 1) {
        const running = runEconomy(['dev', '--port', '0'], {
          stdout: quiet,
          stderr: quiet,
        });
        // The run settles on the signal; a handler that was never registered would hang here.
        await new Promise((r) => setTimeout(r, 150));
        process.emit('SIGTERM');
        assert.equal(await running, 0, `run ${run} did not drain`);
        // A closed handle leaves the table on the next turn of the loop, not on close().
        await new Promise((r) => setTimeout(r, 60));
      }
    });
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(
    {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    },
    before,
    'three runs left signal handlers behind',
  );
  // Nothing is left holding the loop open either: a live FSWatcher is a ref'd handle, and
  // node reports it here by name.
  const held = (
    process as unknown as {
      _getActiveHandles(): { constructor: { name: string } }[];
    }
  )._getActiveHandles();
  assert.deepEqual(
    held.filter((h) => h.constructor.name === 'FSWatcher').length,
    0,
    'a dev watcher outlived its run',
  );
});
