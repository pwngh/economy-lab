/**
 * @pwngh/economy-adapters
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
import { fileURLToPath } from 'node:url';
import { ADAPTERS, LEGS, RUNTIME } from '../scripts/lib/matrix.js';

const MATRIX = fileURLToPath(new URL('../scripts/matrix.ts', import.meta.url));
const SMOKE = fileURLToPath(
  new URL('../scripts/matrix-smoke.ts', import.meta.url),
);
const CWD = fileURLToPath(new URL('..', import.meta.url));

const spawnTsx = (
  script: string,
  args: string[],
  env: Record<string, string> = {},
) => {
  // Deleted, not blanked: an empty string still counts as set, and a nested `node --test`
  // that sees it reports to a parent nobody is listening on and exits 0 with failing tests.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: '',
    NODE_OPTIONS: '',
    MATRIX_SMOKE_BREAK: '',
    ...env,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: 300_000,
    env: childEnv,
  });
};

const runtimeRow = (stdout: string): string[] => {
  const found = stdout.split('\n').find((l) => l.startsWith(`${RUNTIME} `));
  assert.ok(found, `${RUNTIME} row present`);
  return found!.trim().split(/\s+/).slice(1);
};

// The grid golden. Every cell is a live socket under the runtime both survivors target, so
// there is no mark for a cell that did not run: a grid printing anything but pass is red.
test('the grid prints and every cell smoked live', () => {
  const r = spawnTsx(MATRIX, []);
  assert.equal(r.status, 0, `matrix exit 0:\n${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0]!, /^runtime × adapter /);
  assert.deepEqual(
    lines[1]!.trim().split(/\s+/),
    [...ADAPTERS],
    'the header names every adapter',
  );
  const marks = runtimeRow(r.stdout);
  assert.equal(marks.length, ADAPTERS.length, 'one mark per adapter');
  assert.deepEqual(
    marks,
    ADAPTERS.map(() => 'pass'),
    'every cell smoked live',
  );
  assert.doesNotMatch(
    r.stdout,
    /\b(skip|n\/a)\b/,
    'a cell that did not run has no mark to hide behind',
  );
});

// The smoke's own output is the per-leg proof the matrix pins on: three evidence lines, then ok.
test('smoke: every leg prints its own pass evidence', () => {
  const r = spawnTsx(SMOKE, ['express']);
  assert.equal(r.status, 0, `smoke exit 0:\n${r.stdout}\n${r.stderr}`);
  for (const leg of LEGS) {
    assert.match(
      r.stdout,
      new RegExp(`^leg ok ${leg}$`, 'm'),
      `evidence line for ${leg}`,
    );
  }
  assert.match(r.stdout, /^ok express$/m);
});

// Negative controls: corrupt one leg's input and the smoke must go red, naming that leg and
// printing no pass evidence for it. A stubbed or short-circuited leg check fails here.
test('smoke negative control: each corrupted leg turns the smoke red', () => {
  for (const leg of LEGS) {
    const r = spawnTsx(SMOKE, ['express'], { MATRIX_SMOKE_BREAK: leg });
    assert.notEqual(
      r.status,
      0,
      `corrupted ${leg} must exit nonzero:\n${r.stdout}\n${r.stderr}`,
    );
    assert.doesNotMatch(
      r.stdout,
      new RegExp(`^leg ok ${leg}$`, 'm'),
      `no pass evidence for corrupted ${leg}`,
    );
    assert.ok(
      `${r.stdout}${r.stderr}`.includes(`${leg}:`),
      `failure names ${leg}:\n${r.stdout}\n${r.stderr}`,
    );
  }
});

// The same corruption through the matrix itself: every cell must show fail and the exit code
// must follow — a grid that stays green while its legs are broken is the failure this catches.
test('matrix negative control: a corrupted leg fails every cell and the exit code', () => {
  const r = spawnTsx(MATRIX, [], { MATRIX_SMOKE_BREAK: 'webhook' });
  assert.notEqual(r.status, 0, `matrix must exit nonzero:\n${r.stdout}`);
  assert.deepEqual(
    runtimeRow(r.stdout),
    ADAPTERS.map(() => 'fail'),
    'every live cell fails',
  );
});
