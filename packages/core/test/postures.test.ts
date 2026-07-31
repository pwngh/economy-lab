/**
 * @pwngh/economy-core
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
import { createApp, resolveConfig } from '../src/app.js';
import { knobRule, readKnobOrNull } from '../src/knobs.js';
import {
  compilePostures,
  resolveEconomyModule,
  withDev,
} from '../src/module.js';
import type { ResolvedModule } from '../src/module.js';

type Env = Record<string, string | undefined>;

const errors = (issues: readonly unknown[]): string[] =>
  issues
    .filter((i) => (i as { severity?: string }).severity === 'error')
    .map(
      (i) => `${(i as { code: string }).code}:${(i as { path: string }).path}`,
    )
    .sort();

/** What the boot actually does in a posture: the codes it refuses with, or [] when it comes up. */
async function bootVerdict(
  definition: ResolvedModule,
  env: Env,
): Promise<string[]> {
  try {
    const app = await createApp(definition, { env, worker: false });
    await app.close();
    return [];
  } catch (e) {
    // assertPreflight's fault carries the rows it refused on, code and path each.
    const raised = (
      e as { detail?: { issues?: { code: string; path: string }[] } }
    ).detail?.issues;
    assert.ok(
      raised !== undefined,
      `the boot threw something preflight cannot describe: ${String(e)}`,
    );
    return raised.map((i) => `${i.code}:${i.path}`).sort();
  }
}

// The whole point of `economy check`: one module and one environment, and the verdict it prints
// is the verdict the boot reaches. `check` used to compile the raw definition while `dev` booted
// `withDev(definition)`, so the two readings described different bags — and the direction of the
// disagreement flips with the module, which is why this drives the real createApp for each
// posture instead of comparing two rule sets.
test('every posture check reports is the verdict createApp reaches in that posture', async () => {
  const POSTGRES = 'postgres://u:p@127.0.0.1:5432/nope';
  const REDIS = 'redis://127.0.0.1:6379';
  // Each pair is a module and an environment. The names are what makes a failure readable.
  const pairs: Array<[string, Record<string, unknown>, Env]> = [
    ['bare module, empty env', { authenticate: false }, {}],
    [
      'bare module, DATABASE_URL named',
      { authenticate: false },
      { DATABASE_URL: POSTGRES },
    ],
    [
      'bare module, both backends named',
      { authenticate: false },
      { DATABASE_URL: POSTGRES, REDIS_URL: REDIS },
    ],
    // The shape this repository's own economy has: a ports export that carries something other
    // than the store, so `withDev` leaves it alone and neither posture fills the slot.
    [
      'partial ports, DATABASE_URL named',
      { authenticate: false, ports: { dispatcher: false } },
      { DATABASE_URL: POSTGRES },
    ],
    [
      'partial ports, empty env',
      { authenticate: false, ports: { dispatcher: false } },
      {},
    ],
    ['no posture stated, empty env', {}, {}],
    [
      'unsupported store scheme',
      { authenticate: false },
      { DATABASE_URL: 'sqlite://x' },
    ],
  ];
  assert.equal(pairs.length, 7, `the pair table holds ${pairs.length} rows`);

  let compared = 0;
  for (const [name, raw, env] of pairs) {
    const mod = resolveEconomyModule(raw, `${name}.app.ts`);
    const postures = compilePostures(mod, env);
    assert.deepEqual(
      postures.map((p) => p.name),
      ['deployed', 'dev'],
      'both postures are answered for',
    );
    for (const posture of postures) {
      const definition = posture.name === 'dev' ? withDev(mod, env) : mod;
      assert.deepEqual(
        errors(posture.preflight),
        await bootVerdict(definition, env),
        `${name} — the ${posture.name} report and the ${posture.name} boot disagree`,
      );
      compared += 1;
    }
  }
  assert.equal(compared, 14, `${compared} verdicts compared, expected 14`);
});

// The direction is module-dependent, and a fix that only ever made the two agree by reporting the
// dev reading twice would pass the test above. These are the two rows that point opposite ways.
test('the two postures genuinely differ, in both directions', async () => {
  const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/nope' };
  const bare = compilePostures(
    resolveEconomyModule({ authenticate: false }, 'bare.app.ts'),
    env,
  );
  assert.deepEqual(errors(bare[0]!.preflight), [
    'port.unsupplied:DATABASE_URL',
  ]);
  assert.deepEqual(errors(bare[1]!.preflight), [], 'withDev fills the store');

  const wired = compilePostures(
    resolveEconomyModule(
      { authenticate: false, ports: { dispatcher: false } },
      'wired.app.ts',
    ),
    env,
  );
  assert.deepEqual(errors(wired[0]!.preflight), [
    'port.unsupplied:DATABASE_URL',
  ]);
  assert.deepEqual(
    errors(wired[1]!.preflight),
    ['port.unsupplied:DATABASE_URL'],
    'a stated ports export is never decorated, so dev refuses too',
  );
});

// `economy dev` refuses NODE_ENV=production outright, so there is no dev boot to describe there.
test('a production environment answers with the deployed posture alone', () => {
  const mod = resolveEconomyModule({ authenticate: false }, 'a.app.ts');
  assert.deepEqual(
    compilePostures(mod, { NODE_ENV: 'production' }).map((p) => p.name),
    ['deployed'],
  );
  assert.deepEqual(
    compilePostures(mod, { NODE_ENV: 'test' }).map((p) => p.name),
    ['deployed', 'dev'],
  );
});

// One reading of a knob, whatever typed it. `Number` read `0x1f` as 31 and `8080.5` as a port.
test('a knob admits the same integers at every door, and refuses the rest', () => {
  const refused = [
    '0x1f',
    '8080.5',
    'Infinity',
    'NaN',
    '1e3',
    '',
    '  ',
    '3000 ',
    '+3000',
    '-1',
  ];
  assert.equal(
    refused.length,
    10,
    `${refused.length} malformed values checked`,
  );
  for (const value of refused) {
    assert.equal(
      readKnobOrNull('PORT', value),
      null,
      `--port ${JSON.stringify(value)} was accepted`,
    );
  }
  // Positive controls: refusing everything would satisfy the loop above.
  assert.equal(readKnobOrNull('PORT', '8080'), 8080);
  assert.equal(readKnobOrNull('PORT', '65535'), 65_535);
  assert.equal(
    readKnobOrNull('PORT', '0'),
    0,
    '--port 0 asks the OS to pick one',
  );
  assert.equal(readKnobOrNull('PORT', '65536'), null, 'past the last port');
  assert.equal(readKnobOrNull('WORKER_BATCH', '0'), null, 'a sweep of nothing');
  assert.equal(readKnobOrNull('WORKER_BATCH', '1'), 1);
  assert.equal(readKnobOrNull('WORKER_INTERVAL_MS', '0'), null);
  assert.equal(readKnobOrNull('SHUTDOWN_TIMEOUT_MS', '0'), 0);
  assert.match(knobRule('PORT'), /from 0 to 65535/);
  assert.match(knobRule('WORKER_BATCH'), /1 or greater/);
});

// The same value handed to createApp rather than typed, and the same rule.
test('an out-of-range flag handed to createApp refuses by name; a valid one resolves', () => {
  const mod = resolveEconomyModule({ authenticate: false }, 'flags.app.ts');
  for (const flags of [
    { PORT: -1 },
    { PORT: 8080.5 },
    { PORT: 65_536 },
    { WORKER_BATCH: 0 },
    { WORKER_INTERVAL_MS: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => resolveConfig(mod, {}, flags),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, 'ECONOMY_MODULE.SEAM_SHAPE');
        assert.match(e.message, /flags/);
        return true;
      },
      `${JSON.stringify(flags)} was accepted`,
    );
  }
  const ok = resolveConfig(mod, {}, { PORT: 4000, WORKER_BATCH: 25 });
  assert.equal(ok.find((k) => k.key === 'PORT')?.value, 4000);
  assert.equal(ok.find((k) => k.key === 'PORT')?.source, 'flag');
  assert.equal(ok.find((k) => k.key === 'WORKER_BATCH')?.value, 25);
});

// The module seam was the third reading: `Number.isFinite` let a batch of zero and a negative
// interval through, and a worker with `batch: 0` sweeps nothing without saying so.
test('the worker seam admits what the environment admits, and no more', () => {
  for (const worker of [
    { batch: 0 },
    { batch: -1 },
    { intervalMs: 0 },
    { intervalMs: 1.5 },
    { intervalMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => resolveEconomyModule({ authenticate: false, worker }, 'w.app.ts'),
      /BAD_WORKER/,
      `worker: ${JSON.stringify(worker)} was accepted`,
    );
  }
  const fine = resolveEconomyModule(
    { authenticate: false, worker: { batch: 1, intervalMs: 5_000 } },
    'w.app.ts',
  );
  assert.deepEqual(fine.worker, { batch: 1, intervalMs: 5_000 });
});
