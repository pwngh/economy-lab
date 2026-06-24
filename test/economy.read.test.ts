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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { topUp, credit } from '#test/support/builders.ts';

// economy.read.posting / read.saga expose a committed posting and a payout saga by id, so a reader
// (e.g. the console) resolves them through the read surface instead of reaching into the raw Store.
// Both delegate to the store's ledger.posting / sagas.load — those are covered by the conformance
// suite; this pins the read-surface wiring (right method, and a clean null for an unknown id).
describe('economy.read.posting / read.saga', () => {
  test('read.posting resolves a committed posting by id, null for an unknown id', async () => {
    const economy = makeEconomy(1);
    try {
      const out = await economy.submit(
        topUp({
          userId: 'usr_read_1',
          amount: credit('25.00'),
          source: 'card',
        }),
      );
      assert.equal(out.status, 'committed');
      if (out.status !== 'committed') throw new Error('unreachable');

      const posting = await economy.read.posting(out.transaction.id);
      assert.ok(
        posting,
        'read.posting should resolve the committed transaction',
      );
      assert.equal(await economy.read.posting('txn_does_not_exist'), null);
    } finally {
      await economy.close();
    }
  });

  test('read.saga returns null for an unknown payout id', async () => {
    const economy = makeEconomy(1);
    try {
      assert.equal(await economy.read.saga('pay_does_not_exist'), null);
    } finally {
      await economy.close();
    }
  });
});
