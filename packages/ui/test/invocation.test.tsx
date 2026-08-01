/**
 * @pwngh/economy-ui
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// tsx takes its JSX transform from the tsconfig it resolves against the
// WORKING DIRECTORY, and applies it only to files that tsconfig's `include`
// matches. The root program never includes `packages/`, so a repo-root run of
// this package's `.tsx` tests gets esbuild's classic transform and every
// render dies on `ReferenceError: React is not defined` — failures that read
// like product defects. The documented way to run this suite is therefore
// package-cwd: `npm test -w @pwngh/economy-ui`. These two tests hold that
// command to the truth in both directions: the whole roster passes, and a
// genuinely failing .tsx test still fails for its own reason. The file is
// itself `.tsx` so the suite's own glob cannot silently drop it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

// The suite's glob matches this file too, so the spawned run re-enters it;
// the marker makes the inner copy a pair of trivial passes.
const IS_CHILD = 'UI_INVOCATION_GATE_CHILD' in process.env;

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UI_INVOCATION_GATE_CHILD: '1',
  };
  // A nested `node --test` that inherits NODE_TEST_CONTEXT exits 0 while its
  // tests fail; it must be deleted, not blanked.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runFromPackage(files: string[]) {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...files],
    {
      cwd: PKG_ROOT,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // Piped output gets the tap reporter, whose summary these lines are; a
  // changed default turns the counts NaN and fails loudly rather than green.
  const read = (field: string) =>
    Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
  return {
    output,
    counts: {
      tests: read('tests'),
      pass: read('pass'),
      fail: read('fail'),
      cancelled: read('cancelled'),
      skipped: read('skipped'),
      todo: read('todo'),
    },
  };
}

// The shell's expansion of the test script's glob, derived from the directory
// itself so the roster cannot go stale.
function documentedRoster(): string[] {
  return readdirSync(join(PKG_ROOT, 'test'))
    .filter((name) => name.endsWith('.test.tsx'))
    .sort()
    .map((name) => `test/${name}`);
}

test('the documented package-cwd command runs every .tsx suite and tells the truth', () => {
  if (IS_CHILD) return;
  assert.ok(
    existsSync(join(PKG_ROOT, 'tsconfig.json')),
    `no tsconfig.json at ${PKG_ROOT} — the package root did not resolve`,
  );
  const files = documentedRoster();
  assert.ok(files.length > 0, 'the documented glob matches no files');
  const { output, counts } = runFromPackage(files);
  assert.ok(
    Number.isFinite(counts.tests),
    `no test summary in the output\n${output.slice(-2000)}`,
  );
  assert.ok(
    counts.tests >= files.length,
    `${files.length} files examined but only ${counts.tests} tests ran`,
  );
  assert.equal(
    counts.cancelled,
    0,
    `cancelled tests report "0 pass 0 fail" and read like an empty file\n${output.slice(-2000)}`,
  );
  assert.ok(
    !output.includes('React is not defined'),
    `the classic JSX transform leaked in — the transform no longer comes from this package's tsconfig\n${output.slice(-3000)}`,
  );
  assert.equal(
    counts.fail,
    0,
    `${counts.fail} of ${counts.tests} failed under the documented command\n${output.slice(-3000)}`,
  );
  assert.equal(
    counts.pass + counts.skipped + counts.todo,
    counts.tests,
    `of ${counts.tests} tests, ${counts.pass} passed, ${counts.skipped} skipped, ${counts.todo} todo — the rest ran nowhere`,
  );
});

test('a genuinely failing .tsx test still fails under the command, for its own reason', () => {
  if (IS_CHILD) return;
  const control = join('test', 'support', 'jsx-control.tsx');
  assert.ok(
    existsSync(join(PKG_ROOT, control)),
    `${control} is missing — the control cannot run`,
  );
  const { output, counts } = runFromPackage([control]);
  assert.equal(
    counts.tests,
    1,
    `the control holds one test, ${counts.tests} ran`,
  );
  assert.ok(
    !output.includes('React is not defined'),
    `the control died on the JSX transform, not its own assertion\n${output.slice(-2000)}`,
  );
  assert.equal(
    counts.fail,
    1,
    `the control's deliberate failure did not surface — the command can no longer see a real failure\n${output.slice(-2000)}`,
  );
  assert.ok(
    output.includes('control: intentional failure'),
    `the failure is not the control's own\n${output.slice(-2000)}`,
  );
});
