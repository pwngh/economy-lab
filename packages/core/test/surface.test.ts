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

// The root export map is pinned to an exact list. What stays is the pair an application file
// actually calls; everything else answers at ./module, ./ops, or a sibling.
const EXPECTED = ['createApp', 'withDev'].sort();
// The ops vocabulary: the fourteen constructors and the outcome reads — ./ops, exactly. The
// actor constructors left for economy-auth; credits and usd left for economy-money.
const OPS_EXPECTED = [
  'EconomyError',
  'adjust',
  'cancelSubscription',
  'clawback',
  'grantEntitlement',
  'grantPromo',
  'idempotencyKey',
  'isRejection',
  'refund',
  'requestPayout',
  'requireSuccess',
  'reverse',
  'reversePayout',
  'revokeEntitlement',
  'settlePayout',
  'spend',
  'spendable',
  'subscribe',
  'topUp',
].sort();
// The assembly verbs never cross the boundary — reaching them is the escape hatch.
const FORBIDDEN = [
  'boot',
  'openPorts',
  'memoryPorts',
  'createEconomy',
  'createServer',
  'createWorker',
  'handleWebhook',
];

test('the root export map is exact, and carries no assembly verb', async () => {
  const core = await import('../src/index.js');
  assert.deepEqual(Object.keys(core).sort(), EXPECTED);
  for (const verb of FORBIDDEN)
    assert.ok(!(verb in core), `${verb} escaped through the door`);
});

test('./ops is pinned: the operations vocabulary, exactly', async () => {
  const ops = await import('../src/ops.js');
  assert.deepEqual(Object.keys(ops).sort(), OPS_EXPECTED);
  for (const verb of FORBIDDEN)
    assert.ok(!(verb in ops), `${verb} escaped through ./ops`);
});

// ./module is the contract subpath: the seam types, the resolver, and the boot errors —
// nothing that constructs or serves. An exact runtime pin, like the root's.
test('./module is pinned: the contract only', async () => {
  const contract = await import('../src/module.js');
  assert.deepEqual(Object.keys(contract).sort(), [
    'EconomyModuleError',
    'KNOWN_EXPORTS',
    'MODULE_ERROR_CODES',
    'OUTCOME_READS',
    'OWN_SUBJECT',
    'compileEconomy',
    // Every posture the CLI can boot, so `check` reports the boot rather than one of them.
    'compilePostures',
    'effectivePolicy',
    // What a knob admits and how to say so — the one rule the flag path, the environment path
    // and the worker seam all read.
    'knobRule',
    'readKnobOrNull',
    'resolveEconomyModule',
    'stripInterop',
    'withDev',
  ]);
  for (const verb of FORBIDDEN)
    assert.ok(!(verb in contract), `${verb} escaped through ./module`);
});

// ./internal moves with the sibling packages, but the same laws hold there: an exact list
// (every name has a named consumer in cli/adapters/testing), no assembly verbs, and
// nothing contract-shaped — the contract lives on ./module. economy-cli owns the render/report
// set (explainReport, the four renderers, toJson); seedDemo stays, because the golden-desugar
// identity test seeds both sides with it.
test('./internal is pinned: exact list, every export consumed by a sibling', async () => {
  const internal = await import('../src/internal.js');
  assert.deepEqual(Object.keys(internal).sort(), [
    'capabilitiesReport',
    'posture',
    'seedDemo',
    'toRequest',
    'writeResponse',
  ]);
  for (const verb of FORBIDDEN)
    assert.ok(!(verb in internal), `${verb} escaped through ./internal`);
});

// The seam-count tripwire: a module file's export roster is the whole contract surface.
// Growing it is a deliberate event — edit this pin in the same change, never to pass.
test('seam-count tripwire: KNOWN_EXPORTS pinned exactly', async () => {
  const { KNOWN_EXPORTS } = await import('../src/module.js');
  assert.deepEqual(
    [...KNOWN_EXPORTS],
    [
      'policy',
      'catalog',
      'authenticate',
      'providers',
      'worker',
      'ports',
      'instances',
      'flags',
      'after',
      'routes',
    ],
  );
});

// No LOC budget here. A package-wide line count is a proxy: it caps the total without saying
// what is wrong, and it is satisfied by writing denser lines or moving code to an exempt file.
// `max-lines-per-function` and `complexity` in eslint.config.ts bound the thing that actually
// makes code hard to read, and they bound it everywhere rather than in one file group.

// The money-loop map: total over the operation roster (the Record type refuses a missing
// or extra kind at compile time), every value drawn from the four watchable reads.
test('OUTCOME_READS pins the fourteen kinds to the four reads', async () => {
  const { OUTCOME_READS } = await import('../src/module.js');
  assert.deepEqual(Object.keys(OUTCOME_READS).sort(), [
    'adjust',
    'cancelSubscription',
    'clawback',
    'grantEntitlement',
    'grantPromo',
    'refund',
    'requestPayout',
    'reverse',
    'reversePayout',
    'revokeEntitlement',
    'settlePayout',
    'spend',
    'subscribe',
    'topUp',
  ]);
  const READS = ['wallet', 'entitlements', 'subscriptions', 'payouts'];
  for (const [kind, keys] of Object.entries(OUTCOME_READS)) {
    assert.ok(keys.length >= 1, `${kind} maps to at least one read`);
    for (const k of keys)
      assert.ok(READS.includes(k), `${kind} → ${k} is a watchable read`);
  }
});
