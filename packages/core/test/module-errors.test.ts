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
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openTestEconomy } from '@pwngh/economy-test';
import { installSecondCopy } from '../../../test/support/second-copy.js';
import { EconomyModuleError, resolveEconomyModule } from '../src/module.js';

const rejects = (
  raw: Record<string, unknown>,
  code: string,
  ...parts: string[]
) => {
  try {
    resolveEconomyModule(raw, 'my.app.ts');
    assert.fail(`expected ${code}`);
  } catch (e) {
    const err = e as Error & { code: string };
    assert.equal(err.code, `ECONOMY_MODULE.${code}`);
    assert.ok(err.message.includes('my.app.ts'), 'names the file');
    for (const p of parts) assert.ok(err.message.includes(p), `names ${p}`);
  }
};

test('every boot error names the file, the export, and the fix (law 10 at boot)', () => {
  rejects({ default: {} }, 'DEFAULT_EXPORT', 'default', 'named exports only');
  rejects({ polciy: {} }, 'UNKNOWN_EXPORT', 'polciy', 'did you mean');
  rejects({ reactions: {} }, 'UNKNOWN_EXPORT', 'reactions', 'after');
  rejects({ flags: { velocity: false } }, 'NOT_YET', 'flags', 'payouts: false');
  rejects({ policy: 42 }, 'SEAM_SHAPE', 'policy', 'got number');
  rejects({ policy: 'abc' }, 'SEAM_SHAPE', 'policy', 'got string');
  rejects({ policy: [] }, 'SEAM_SHAPE', 'policy', 'got array');
  rejects({ policy: null }, 'SEAM_SHAPE', 'policy', 'got null');
  rejects({ policy: () => ({}) }, 'SEAM_SHAPE', 'policy', 'portsBag');
  rejects({ ports: 42 }, 'SEAM_SHAPE', 'ports', 'overrides');
  rejects({ ports: () => ({}) }, 'SEAM_SHAPE', 'ports', 'portsBag');
  rejects({ ports: { flux: 1 } }, 'SEAM_SHAPE', 'flux', 'fifteen slots');
  rejects({ ports: { config: {} } }, 'SEAM_SHAPE', 'ports', 'policy');
  rejects({ ports: { secrets: {} } }, 'SEAM_SHAPE', 'ports', 'environment');
  rejects(
    { instances: 7 },
    'SEAM_SHAPE',
    'instances',
    'InstanceEconomiesOptions',
  );
  rejects({ authenticate: 'yes' }, 'NOT_A_FUNCTION', 'authenticate', '`false`');
  rejects({ worker: 7 }, 'BAD_WORKER', 'worker', 'intervalMs');
  rejects(
    { worker: { intervalMs: 'fast' } },
    'BAD_WORKER',
    'worker',
    'a whole number 1 or greater',
  );
  rejects({ worker: { batch: [] } }, 'BAD_WORKER', 'worker', 'got object');
  // The seam used to admit anything finite, so a batch of zero — a worker that sweeps nothing —
  // resolved silently while the same value in the environment was refused.
  rejects({ worker: { batch: 0 } }, 'BAD_WORKER', 'worker', 'got 0');
  rejects({ worker: { intervalMs: -1 } }, 'BAD_WORKER', 'worker', 'got -1');
  rejects(
    { worker: { sweeps: 'payouts' } },
    'BAD_WORKER',
    'worker',
    'array of sweep names',
  );
  rejects(
    { worker: { sweeps: ['payouts', 'nope'] } },
    'UNKNOWN_SWEEP',
    'nope',
    'sixteen sweeps',
  );
  rejects({ http: { reads: false } }, 'NOT_YET', 'http', 'reserved', 'flags');
  rejects({ flags: { reads: true } }, 'SEAM_SHAPE', 'flags', 'leaving it out');
  rejects({ after: [] }, 'SEAM_SHAPE', 'after', 'event handlers');
  rejects(
    { after: { 'economy.big.bang': () => {} } },
    'UNKNOWN_EVENT',
    'economy.big.bang',
    'fourteen events',
  );
  rejects(
    { after: { 'economy.sale.completed': 7 } },
    'SEAM_SHAPE',
    'after',
    'function',
  );
});

test('a valid module resolves pure, sync, frozen', () => {
  const mod = resolveEconomyModule({
    authenticate: false,
    worker: { sweeps: ['payouts'] },
  });
  assert.equal(mod.file, 'economy.app.ts');
  assert.deepEqual(mod.exports, ['authenticate', 'worker']);
  assert.ok(Object.isFrozen(mod));
});

const SOURCE = fileURLToPath(new URL('../src/errors.ts', import.meta.url));

test('EconomyModuleError.is matches a refusal a second resolved copy threw', async () => {
  const copy = installSecondCopy({
    packageName: '@pwngh/economy-core',
    sourcePath: SOURCE,
  });
  try {
    // The fixture is the real module, not a stand-in: compiled from src/errors.ts as it stands,
    // and exporting exactly what this file's copy exports.
    assert.equal(
      copy.sha,
      createHash('sha256').update(readFileSync(SOURCE, 'utf8')).digest('hex'),
    );
    const second = (await import(
      pathToFileURL(copy.consumer).href
    )) as typeof import('../src/errors.js');
    const ours = await import('../src/errors.js');
    assert.deepEqual(Object.keys(second).sort(), Object.keys(ours).sort());
    assert.deepEqual(
      Object.keys(second),
      ['EconomyModuleError', 'MODULE_ERROR_CODES'],
      'the copy carries the class and the code map',
    );

    // Two class objects, or the rest of this test proves nothing.
    assert.notEqual(second.EconomyModuleError, EconomyModuleError);
    const args = [
      'SEAM_SHAPE',
      'shop/app.ts',
      'ports',
      'pass a portsBag instead',
    ] as const;
    const theirs = new second.EconomyModuleError(...args);
    const mine = new EconomyModuleError(...args);
    assert.equal(
      theirs.message,
      mine.message,
      'the copy builds the same refusal',
    );

    // The defect: the prototype chain does not cross the copy boundary.
    assert.equal(theirs instanceof EconomyModuleError, false);
    assert.equal(mine instanceof second.EconomyModuleError, false);

    // The brand does, in both directions.
    assert.equal(EconomyModuleError.is(theirs), true);
    assert.equal(second.EconomyModuleError.is(mine), true);
    assert.equal(theirs.code, 'ECONOMY_MODULE.SEAM_SHAPE');
    assert.equal(theirs.export, 'ports');
  } finally {
    rmSync(copy.dir, { recursive: true, force: true });
  }
});

// A boundary that is already here, no fixture needed: @pwngh/economy-test raises its refusals
// through the core's built copy, while this suite holds ../src. Two copies, one install.
test('EconomyModuleError.is matches the refusal the built copy raises through the harness', async () => {
  let raised: unknown;
  try {
    await openTestEconomy({ polciy: {} });
  } catch (e) {
    raised = e;
  }
  assert.equal((raised as Error | undefined)?.name, 'EconomyModuleError');
  assert.equal(
    raised instanceof EconomyModuleError,
    false,
    'dist and src are different classes',
  );
  assert.equal(EconomyModuleError.is(raised), true);
  assert.equal(
    (raised as EconomyModuleError).code,
    'ECONOMY_MODULE.UNKNOWN_EXPORT',
  );
});

test('the brand is additive: instanceof still answers same-copy', () => {
  const mine = new EconomyModuleError(
    'NOT_FOUND',
    'shop',
    'app.ts',
    'add an app.ts root module',
  );
  assert.ok(mine instanceof EconomyModuleError);
  assert.ok(mine instanceof Error);
});

test('the brand rejects non-errors, plain objects, and a bare Error', () => {
  assert.equal(EconomyModuleError.is(new Error('plain')), false);
  assert.equal(
    EconomyModuleError.is({ code: 'ECONOMY_MODULE.SEAM_SHAPE' }),
    false,
  );
  assert.equal(EconomyModuleError.is(null), false);
  assert.equal(EconomyModuleError.is(undefined), false);
  assert.equal(EconomyModuleError.is('ECONOMY_MODULE.SEAM_SHAPE'), false);
});
