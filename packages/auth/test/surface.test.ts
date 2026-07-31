/**
 * @pwngh/economy-auth
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

// The whole package is one question — who is calling, and by what credential — so the
// export list is pinned exactly: four resolvers, the composer, and the three identities
// they answer with. Growing it is a deliberate event; edit this pin in the same change.
const EXPECTED = [
  'authApiKeys',
  'authJwks',
  'bearerStack',
  'devAuthenticate',
  'devTokens',
  'operatorActor',
  'systemActor',
  'userActor',
].sort();

// Re-export, never redefine: a Principal this package builds and a Principal the ledger
// authorizes against are the same value, or authorization splits across the boundary.
const REEXPORTED = ['userActor', 'systemActor', 'operatorActor'];

test('the export list is pinned exactly', async () => {
  const auth = await import('../src/index.js');
  assert.deepEqual(Object.keys(auth).sort(), EXPECTED);
});

test('every lab symbol here is === identical to the lab', async () => {
  const auth = (await import('../src/index.js')) as Record<string, unknown>;
  const lab = (await import('@pwngh/economy-lab')) as Record<string, unknown>;
  for (const name of REEXPORTED) {
    assert.strictEqual(
      auth[name],
      lab[name],
      `${name} was redefined, not re-exported`,
    );
  }
});

// The bearer grammar is package-internal: every resolver shares it, nobody imports it.
test('bearerOf never reaches the door', async () => {
  const auth = (await import('../src/index.js')) as Record<string, unknown>;
  assert.ok(!('bearerOf' in auth), 'the grammar helper stays inside');
});
