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

// Re-export, never redefine — Amount brands, `EconomyError.is`, and rejection narrowing survive
// the package boundary.
const REEXPORTED = [
  'topUp',
  'spend',
  'refund',
  'clawback',
  'requestPayout',
  'subscribe',
  'cancelSubscription',
  'grantEntitlement',
  'revokeEntitlement',
  'grantPromo',
  'adjust',
  'reverse',
  'reversePayout',
  'settlePayout',
  'idempotencyKey',
  'isRejection',
  'requireSuccess',
  'EconomyError',
  'spendable',
];

test('every lab symbol on ./ops is === identical to the lab', async () => {
  const ops = (await import('../src/ops.js')) as Record<string, unknown>;
  const lab = (await import('@pwngh/economy-lab')) as Record<string, unknown>;
  for (const name of REEXPORTED) {
    assert.strictEqual(
      ops[name],
      lab[name],
      `${name} was redefined, not re-exported`,
    );
  }
});
