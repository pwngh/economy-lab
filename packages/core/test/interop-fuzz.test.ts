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
import { throwingGetter } from '@pwngh/economy-test';
import {
  EconomyModuleError,
  resolveEconomyModule,
  stripInterop,
} from '../src/module.js';

// H3: hostile module shapes against the resolver — CJS/ESM interop artifacts, getters
// that throw, prototype-chain and Symbol exports, frozen and sealed namespaces. Every
// refusal is an EconomyModuleError whose message names its fix; a raw TypeError or
// ReferenceError escaping the resolver is the failure this suite exists to catch.

test('a throwing getter refuses by name with the fix, never a raw throw', () => {
  for (const [key, error] of [
    ['policy', new TypeError('lazy require exploded')],
    ['surprise', new ReferenceError('cannot access before initialization')],
  ] as const) {
    assert.throws(
      () =>
        resolveEconomyModule(
          throwingGetter(key, error, { authenticate: false }),
          'economy.app.ts',
        ),
      (e: unknown) => {
        assert.ok(
          EconomyModuleError.is(e),
          `${key}: a named refusal, not ${String(e)}`,
        );
        assert.match(e.message, new RegExp(key), `${key}: the export is named`);
        assert.match(e.message, /—|:/, `${key}: the message carries a fix`);
        return true;
      },
    );
  }
});

test('stripInterop reads hostile shapes safely and keeps its CJS-mirror law', () => {
  // The classic CJS artifact: marker plus a default that mirrors the named exports.
  const policy = { feeBps: 100 };
  assert.deepEqual(
    stripInterop({ __esModule: true, policy, default: { policy } }),
    { policy },
  );
  // A partial mirror is an authored default and stays one.
  const kept = stripInterop({
    __esModule: true,
    policy,
    default: { other: 1 },
  });
  assert.deepEqual(Object.keys(kept).sort(), ['default', 'policy']);
  // A throwing getter refuses with the export named, even through stripInterop directly.
  assert.throws(
    () =>
      stripInterop(
        throwingGetter('worker', new TypeError('boom'), {
          authenticate: false,
        }),
        'hostile.app.ts',
      ),
    /SEAM_SHAPE.*hostile\.app\.ts.*worker/s,
  );
});

test('Symbol-keyed and prototype-chain exports are not exports — dropped, never resolved', () => {
  const sym = Object.assign(Object.create({ policy: { feeBps: 9_999 } }), {
    authenticate: false,
    [Symbol('sneaky')]: 'payload',
  }) as Record<string, unknown>;
  const mod = resolveEconomyModule(sym, 'economy.app.ts');
  assert.deepEqual([...mod.exports], ['authenticate'], 'own string keys only');
  assert.equal(
    mod.policy,
    undefined,
    'a prototype-chain export never rides in',
  );
  assert.equal(
    Object.getOwnPropertySymbols(mod).length,
    0,
    'no symbol smuggling',
  );
});

test('frozen and sealed namespaces resolve like plain ones', () => {
  for (const harden of [Object.freeze, Object.seal]) {
    const mod = resolveEconomyModule(
      harden({ authenticate: false, worker: { intervalMs: 5_000 } }),
      'economy.app.ts',
    );
    assert.deepEqual([...mod.exports], ['authenticate', 'worker']);
  }
});

test('an authored default refuses with the rename fix; default: null counts as authored', () => {
  for (const dflt of [() => {}, null, 'text']) {
    assert.throws(
      () => resolveEconomyModule({ default: dflt, authenticate: false }),
      /DEFAULT_EXPORT.*named exports only/s,
    );
  }
});

test('a lazy getter that answers is an ordinary export', () => {
  const lazy: Record<string, unknown> = {};
  let reads = 0;
  Object.defineProperty(lazy, 'authenticate', {
    get() {
      reads += 1;
      return false;
    },
    enumerable: true,
  });
  const mod = resolveEconomyModule(lazy, 'economy.app.ts');
  assert.equal(mod.authenticate, false);
  assert.ok(reads >= 1, 'the getter was read once, at resolve time');
});
