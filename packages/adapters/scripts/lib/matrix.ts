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

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SMOKE = fileURLToPath(new URL('../matrix-smoke.ts', import.meta.url));
const CWD = fileURLToPath(new URL('../..', import.meta.url));

export const ADAPTERS = ['express', 'fastify'] as const;

/** Both survivors convert Node `req`/`res`, so the grid runs under the one runtime they target. */
export const RUNTIME = 'node';

export type Mark = 'pass' | 'fail';

export const LEGS = ['healthz', 'submit', 'webhook'] as const;

function cell(adapter: string): Mark {
  // Deleted, not blanked: an empty string still counts as set, and a child that sees
  // NODE_TEST_CONTEXT reports to a parent nobody is listening on and exits 0 on failure.
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: '',
    NODE_OPTIONS: '',
  };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    ['--import', fileURLToPath(import.meta.resolve('tsx')), SMOKE, adapter],
    { cwd: CWD, encoding: 'utf8', timeout: 60_000, env },
  );
  // A cell passes only on per-leg evidence lines, never on exit code alone.
  const smoked = LEGS.every((leg) =>
    new RegExp(`^leg ok ${leg}$`, 'm').test(r.stdout),
  );
  if (r.status === 0 && smoked && /^ok /m.test(r.stdout)) return 'pass';
  console.error(`--- ${RUNTIME} × ${adapter} failed\n${r.stdout}${r.stderr}`);
  return 'fail';
}

export function runMatrix(): { grid: string; failed: boolean } {
  const width = 12;
  const pad = (s: string) => s.padEnd(width);
  const marks = ADAPTERS.map(cell);
  const grid = [
    'runtime × adapter — the three legs per cell: /healthz, authed submit, byte-exact webhook',
    [pad(''), ...ADAPTERS.map(pad)].join('').trimEnd(),
    [pad(RUNTIME), ...marks.map(pad)].join('').trimEnd(),
    '',
    'every cell ran live over a socket — there is no mark for a cell that did not run',
  ].join('\n');
  return { grid, failed: marks.includes('fail') };
}
