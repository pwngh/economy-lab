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

// A package test imports the lab and its siblings through their exports maps, so it runs against
// `dist` — last build's copy of that source. The fan-out dated that emit; `npm test -w <pkg>`,
// the loop a lane actually types, dated nothing, and its green could describe the previous build.
//
// What is gated here is the discrimination, not the refusal. A check that refused every package
// would satisfy "the stale one is caught" and be unusable: dating the whole tree stops a lane
// working on one package because a package it never loads is behind. So under one artificial
// staleness, the package that reads it must refuse and a package that does not must run.
//
// The staleness is applied to a package the root suite does not load and no other gate stales:
// test/dist-freshness.test.ts names the six units this suite consumes and webhook is not one,
// and test/dist-reach.test.ts holds its own window over receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unitsRead } from '#scripts/check-dist-fresh.ts';
import { readWorkspace } from '#scripts/support/workspace-graph.ts';
import { exclusively } from '#test/support/stale-window.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Reads the staled emit. */
const REFUSES = '@pwngh/economy-webhook';
/** Does not, and is the fastest suite in the workspace. */
const RUNS = '@pwngh/economy-events';

const STALED = 'packages/webhook/dist';
const LONG_AGO = new Date('2001-01-01T00:00:00Z');
const RUN_MS = 300_000;

function loop(name: string) {
  const env = { ...process.env };
  // node --test leaks this to children, and a child that inherits it switches to the reporter
  // protocol and exits 0 whatever its tests did.
  delete env.NODE_TEST_CONTEXT;
  // The root suite sets this after dating the tree itself, and every package loop it spawns
  // skips the work. Inside this window that marker would be a lie, so it is removed.
  delete env.ECONOMY_BUILDS_DATED;
  const ran = spawnSync('npm', ['test', '-w', name], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: RUN_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: ran.status,
    wedged: ran.signal !== null,
    output: `${ran.stdout ?? ''}${ran.stderr ?? ''}`,
  };
}

/** Runs the body with one of the staled package's build outputs behind its source. */
function whileBehind(body: () => void): void {
  const dir = join(ROOT, STALED);
  const emitted = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(
    emitted.length > 0,
    `${STALED} holds no build output to date; run node scripts/build-packages.mjs`,
  );
  const output = join(dir, emitted.sort()[0]!);
  const was = statSync(output);
  utimesSync(output, was.atime, LONG_AGO);
  try {
    body();
  } finally {
    utimesSync(output, was.atime, was.mtime);
  }
}

test('a package dates the emit its own tests read, and no more', () => {
  const workspace = readWorkspace(ROOT);
  const reads = (name: string): string[] =>
    unitsRead(ROOT, workspace.get(name)!.dir).map((unit) => unit.name);

  // The pair the window below rests on, asserted apart from it: one loads the staled package's
  // emit and one does not.
  assert.ok(
    reads(REFUSES).includes(REFUSES),
    `${REFUSES} does not read itself`,
  );
  assert.ok(
    !reads(RUNS).includes(REFUSES),
    `${RUNS} reads ${REFUSES}, so a refusal there would say nothing about narrowness`,
  );

  // Narrow for every package that runs a loop, not just the pair. A set as wide as the tree is
  // the refusal nobody can work under, and it is what reading the manifests gives.
  const suites = [...workspace.values()].filter((member) =>
    member.json.scripts?.test?.includes('check-package-fresh'),
  );
  assert.equal(
    suites.length,
    16,
    `${suites.length} packages run their own loop`,
  );
  const all = new Set<string>();
  for (const member of suites) {
    const here = reads(member.name);
    assert.ok(
      here.length > 0 && here.length < 10,
      `${member.name} dates ${here.length} units`,
    );
    for (const name of here) all.add(name);
  }
  // Every unit is read by somebody, or a package's emit is one nothing here would ever date.
  assert.ok(all.size > 10, `only ${all.size} units are read by any package`);
});

// create-economy runs a root test file rather than a tree of its own, and a root test file that
// reads an emit carries the guard itself. Derived, so an exemption that stopped being true fails.
test('the one package with no freshness clause is covered by the root guard', () => {
  const workspace = readWorkspace(ROOT);
  const without = [...workspace.values()].filter(
    (member) =>
      member.json.scripts?.test !== undefined &&
      !member.json.scripts.test.includes('check-package-fresh'),
  );
  assert.deepEqual(
    without.map((member) => member.name),
    ['create-economy'],
  );
  const script = without[0]!.json.scripts!.test;
  const suite = /--test\s+(\S+)/.exec(script)?.[1];
  assert.ok(suite !== undefined, `no test file in ${JSON.stringify(script)}`);
  const source = readFileSync(join(without[0]!.dir, suite), 'utf8');
  assert.match(
    source,
    /^import '#test\/support\/dist-guard\.ts';$/m,
    `${suite} is run by ${without[0]!.name} and dates nothing`,
  );
});

// The window and its control are one hold: a sibling gate staling the tree between them would
// refuse the control for its own reason.
test('the package loop refuses an emit behind its source, and only where it is read', () => {
  exclusively(() => {
    whileBehind(() => {
      const refused = loop(REFUSES);
      assert.ok(
        !refused.wedged,
        'the refusing run was killed rather than refusing',
      );
      assert.notEqual(
        refused.status,
        0,
        `${REFUSES} ran against a build behind its source\n${refused.output.slice(-3000)}`,
      );
      assert.match(
        refused.output,
        /dist-freshness/,
        `the run failed for some reason other than the emit\n${refused.output.slice(-3000)}`,
      );
      assert.match(refused.output, /npm run build -w/, refused.output);
      // A refusal that still ran the tests is not a refusal.
      assert.doesNotMatch(refused.output, /^# tests \d+$/m, refused.output);

      // The other half of the discrimination, inside the same window.
      const allowed = loop(RUNS);
      assert.ok(!allowed.wedged, 'the allowed run was killed');
      assert.equal(
        allowed.status,
        0,
        `${RUNS} was refused for a build it never loads\n${allowed.output.slice(-3000)}`,
      );
      assert.match(allowed.output, /^# tests [1-9]\d*$/m, allowed.output);
    });

    // The control: the refusal was caused by the staleness, not by the package.
    const after = loop(REFUSES);
    assert.equal(after.status, 0, after.output.slice(-3000));
    assert.match(after.output, /^# tests [1-9]\d*$/m, after.output);
  });
});
