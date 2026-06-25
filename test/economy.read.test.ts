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
import { topUp, credit, grantEntitlement } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';

// economy.read.posting / read.saga / read.accounts expose a committed posting, a payout saga by id,
// and the set of accounts — so a reader (e.g. the console) resolves and enumerates them through the
// read surface instead of reaching into the raw Store. Each delegates to a store method covered by
// the conformance suite; this pins the read-surface wiring.
describe('economy.read.posting / read.saga / read.accounts', () => {
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

  test('read.accounts enumerates accounts that have a balance', async () => {
    const economy = makeEconomy(1);
    try {
      await economy.submit(
        topUp({
          userId: 'usr_acct_1',
          amount: credit('10.00'),
          source: 'card',
        }),
      );
      const accounts: string[] = [];
      for await (const account of economy.read.accounts()) {
        accounts.push(account);
      }
      assert.ok(
        accounts.includes(spendable('usr_acct_1')),
        'includes the funded user account',
      );
    } finally {
      await economy.close();
    }
  });

  test('read.entitled reports ownership a grant created, false otherwise', async () => {
    const economy = makeEconomy(1);
    try {
      assert.equal(
        await economy.read.entitled('usr_ent_1', 'wrld_pass'),
        false,
        'unknown ownership reads false',
      );

      await economy.submit(
        grantEntitlement({ userId: 'usr_ent_1', sku: 'wrld_pass' }),
      );

      assert.equal(
        await economy.read.entitled('usr_ent_1', 'wrld_pass'),
        true,
        'reads true once granted',
      );
      assert.equal(
        await economy.read.entitled('usr_ent_1', 'wrld_other'),
        false,
        'a SKU they were not granted reads false',
      );
    } finally {
      await economy.close();
    }
  });
});
