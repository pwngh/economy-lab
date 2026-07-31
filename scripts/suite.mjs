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

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BUILDS_DATED, assertBuildsFresh } from './check-dist-fresh.ts';
import { describeReach, reachesDist } from './support/dist-reach.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = '/tmp/economy-lab-suite';
const LOCK = `${DIR}/lock.json`;
const LAST = `${DIR}/last.json`;

const WAIT_POLL_MS = 2_000;
const WAIT_LIMIT_MS = 30 * 60_000;

const read = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const write = (path, value) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * The counted reporter's refusal. It is the one thing here no total can show: a file that ends
 * its own process is counted as one passing test by everything that reports after it died.
 */
const LOST = /^counted: what ran is not what was counted\.$/m;

/**
 * The counts a run reported, from either shape: the root suite's numbered reporter, or plain
 * TAP when a subset runs without it. A shape that parses neither is a failure, never a pass.
 */
function summarize(out) {
  // Built rather than written literally: the reporter colours its summary, and an escape
  // character inside a regex literal is a lint error.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const plain = out.replace(ansi, '');

  if (LOST.test(plain)) {
    return {
      summary: 'a file left this run without reporting what it did',
      failed: true,
    };
  }

  const line = plain.match(
    /Summary\s+(all passed|report unreliable|\d+ failed)\s+·\s+(\d+) suites\s+·\s+(\d+) tests\s+\((\d+) pass(?:, (\d+) fail)?(?:, (\d+) skip)?\)/,
  );
  if (line) {
    const [, verdict, suites, tests, pass, fail = '0', skip = '0'] = line;
    // `report unreliable` is the reporter saying its own counts disagree with what node:test
    // says ran, so these numbers describe nothing and the run is a failure whatever they read.
    return {
      summary:
        verdict === 'report unreliable'
          ? 'the reporter disagrees with node:test about what ran'
          : `${tests} tests, ${pass} pass, ${fail} fail, ${skip} skip, ${suites} suites`,
      failed: verdict !== 'all passed' || fail !== '0',
    };
  }

  const tap = (key) => plain.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1];
  if (tap('tests') !== undefined) {
    const fail = tap('fail') ?? '0';
    return {
      summary: `${tap('tests')} tests, ${tap('pass') ?? '?'} pass, ${fail} fail, ${tap('skipped') ?? '0'} skip`,
      failed: fail !== '0',
    };
  }

  return { summary: 'no summary line found in the output', failed: true };
}

/** Signal 0 tests for existence without delivering anything. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/** A lock whose holder has died is stale — a crashed run must not block the next one forever. */
function held() {
  const lock = read(LOCK);
  if (!lock) return null;
  if (alive(lock.pid)) return lock;
  rmSync(LOCK, { force: true });
  return null;
}

function status() {
  const lock = held();
  const last = read(LAST);
  if (lock) {
    console.log(
      `RUNNING  pid ${lock.pid}, started ${ago(lock.startedAt)} ago — ${lock.label}`,
    );
  } else {
    console.log('idle');
  }
  if (last) {
    console.log(
      `last     ${last.ok ? 'PASS' : 'FAIL'} ${ago(last.finishedAt)} ago in ${last.tookS}s — ${last.summary}`,
    );
    console.log(`         ${last.label}`);
  }
  return lock ? 1 : 0;
}

/** Waits out the current holder. The result is not reused: it predates this caller's edits. */
function waitForIdle() {
  const start = Date.now();
  let announced = false;
  for (;;) {
    const lock = held();
    if (!lock) return true;
    if (!announced) {
      console.error(
        `suite: waiting for pid ${lock.pid} (${lock.label}), started ${ago(lock.startedAt)} ago`,
      );
      announced = true;
    }
    if (Date.now() - start > WAIT_LIMIT_MS) {
      console.error(
        `suite: still held after ${Math.round(WAIT_LIMIT_MS / 60_000)}m — giving up`,
      );
      return false;
    }
    execFileSync('sleep', [String(WAIT_POLL_MS / 1000)]);
  }
}

/** How many chains a refusal prints before it counts the rest. */
const LISTED = 4;

/**
 * Names the files in this run that load the lab out of its emit, and refuses when that emit is
 * behind its source. Such a file reads last build's copy of `src/`, so it stays green under an
 * unbuilt change and its green says nothing about that change.
 */
function distIsWhatTheyRead(paths) {
  const reaching = reachesDist(ROOT, paths);
  if (reaching.length === 0) return true;
  const shown = reaching.slice(0, LISTED).map(describeReach).join('\n  ');
  const rest =
    reaching.length > LISTED ? `\n  and ${reaching.length - LISTED} more` : '';
  try {
    assertBuildsFresh(ROOT, 'the files in this run that read an emit');
  } catch (refusal) {
    console.error(refusal.message);
    console.error(
      `\nsuite: ${reaching.length} of ${paths.length} file(s) here reach the lab through a package, so they run against dist:\n  ${shown}${rest}\nA source change they do not see is a source change they cannot witness.`,
    );
    return false;
  }
  console.error(
    `suite: ${reaching.length} of ${paths.length} file(s) read the lab through a package rather than its source:\n  ${shown}${rest}`,
  );
  return true;
}

function run(label) {
  // The whole suite reaches every emit in the tree, so there is nothing to classify.
  try {
    assertBuildsFresh(ROOT, 'the root suite');
  } catch (refusal) {
    console.error(refusal.message);
    return 2;
  }
  if (!waitForIdle()) return 2;
  write(LOCK, { pid: process.pid, startedAt: new Date().toISOString(), label });

  const startedMs = Date.now();
  let out = '';
  try {
    const r = spawnSync('npm', ['test'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, [BUILDS_DATED]: '1' },
    });
    out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    process.stdout.write(out);

    const { summary, failed } = summarize(out);
    const ok = !failed && r.status === 0;
    write(LAST, {
      finishedAt: new Date().toISOString(),
      tookS: Math.round((Date.now() - startedMs) / 1000),
      ok,
      summary,
      label,
    });
    console.error(`\nsuite: ${ok ? 'PASS' : 'FAIL'} — ${summary}`);
    return r.status ?? 1;
  } finally {
    rmSync(LOCK, { force: true });
  }
}

/**
 * Runs named test files. No lock: a handful of files finishes in seconds and is what most
 * work actually needs, so this is the path to reach for first.
 */
function files(paths) {
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length) {
    console.error(`suite: no such file: ${missing.join(' ')}`);
    return 2;
  }
  if (!distIsWhatTheyRead(paths)) return 2;
  const r = spawnSync(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--test-timeout=600000',
      '--test',
      // Beside node's own reporter, never instead of it: TAP's totals are computed once every
      // child has ended, so a file that ended itself reads there as one passing test.
      '--test-reporter=tap',
      '--test-reporter-destination=stdout',
      '--test-reporter=./scripts/support/counted.reporter.mjs',
      '--test-reporter-destination=stderr',
      ...paths,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, [BUILDS_DATED]: '1' },
    },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);
  console.error(`\nsuite: ${paths.length} file(s) — ${summarize(out).summary}`);
  return r.status ?? 1;
}

const USAGE = `usage: suite.mjs <command>

  file <path...>   run just these test files — seconds, no lock. START HERE.
  status           is a full suite running, and what did the last one say?
  run [label]      the whole root suite, one at a time. Only for the headline number.

Concurrent full suites contend for the same database rigs and report the contention as
failures, so run queues behind any run already going. A targeted file run does not.`;

const [cmd = 'status', ...rest] = process.argv.slice(2);

if (cmd === 'status') {
  process.exitCode = status();
} else if (cmd === 'file' && rest.length) {
  process.exitCode = files(rest);
} else if (cmd === 'run') {
  process.exitCode = run(rest.join(' ') || `pid ${process.pid}`);
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
