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
import { topUp, spend, adjust, credit } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';

// The pause declines end-user discretionary writes only: settlement and operator fixes are never
// blocked (provider webhooks arrive as actor 'system'), and reads stay open.
describe('economy pause window', () => {
  // This window brackets the fixed clock's `now` (0), so the economy is paused.
  const ACTIVE = { pauseStartMs: 0, pauseEndMs: 60 * 60_000 };
  const PAST = { pauseStartMs: -2 * 60 * 60_000, pauseEndMs: -60 * 60_000 };

  test('a user spend during the window is rejected with ECONOMY_PAUSED', async () => {
    const economy = makeEconomy(1, undefined, ACTIVE);
    try {
      // Fund via an operator adjust so the pause, not a shortfall, is the only possible decline.
      const funded = await economy.submit(
        adjust({
          account: spendable('usr_pause_buyer'),
          amount: credit('100.00'),
          reason: 'fund buyer for pause test',
        }),
      );
      assert.equal(funded.status, 'committed', 'operator fix is not paused');

      const out = await economy.submit(
        spend({
          buyerId: 'usr_pause_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: 'usr_pause_seller', shareBps: 10_000 }],
        }),
      );

      assert.equal(out.status, 'rejected');
      if (out.status !== 'rejected') throw new Error('unreachable');
      assert.equal(out.detail.reason, 'ECONOMY_PAUSED');
      if (out.detail.reason !== 'ECONOMY_PAUSED')
        throw new Error('unreachable');
      assert.equal(
        out.detail.resumesAt,
        ACTIVE.pauseEndMs,
        'the decline reports when writes resume',
      );
    } finally {
      await economy.close();
    }
  });

  test('a system topUp during the window commits (settlement is not blocked)', async () => {
    const economy = makeEconomy(1, undefined, ACTIVE);
    try {
      const out = await economy.submit(
        topUp({
          userId: 'usr_pause_settle',
          amount: credit('25.00'),
          source: 'card',
        }),
      );
      assert.equal(
        out.status,
        'committed',
        'a settlement webhook still settles',
      );
    } finally {
      await economy.close();
    }
  });

  test('an operator adjust during the window commits', async () => {
    const economy = makeEconomy(1, undefined, ACTIVE);
    try {
      const out = await economy.submit(
        adjust({
          account: spendable('usr_pause_fix'),
          amount: credit('10.00'),
          reason: 'operator correction during maintenance',
        }),
      );
      assert.equal(out.status, 'committed', 'an operator fix is never paused');
    } finally {
      await economy.close();
    }
  });

  test('reads stay open during the window and status.maintenanceActive is true', async () => {
    const economy = makeEconomy(1, undefined, ACTIVE);
    try {
      await economy.submit(
        topUp({
          userId: 'usr_pause_read',
          amount: credit('25.00'),
          source: 'card',
        }),
      );

      const balance = await economy.read.balance(spendable('usr_pause_read'));
      assert.equal(balance.minor, credit('25.00').minor, 'read.balance works');

      const report = await economy.read.health();
      assert.equal(report.conserved, true, 'read.health works');

      const status = economy.read.status();
      assert.equal(status.maintenanceActive, true);
      assert.equal(status.pauseStart, ACTIVE.pauseStartMs);
      assert.equal(status.pauseEnd, ACTIVE.pauseEndMs);
      assert.equal(
        status.resumesAt,
        ACTIVE.pauseEndMs,
        'resumesAt is the end while paused',
      );
    } finally {
      await economy.close();
    }
  });

  test('outside the window a user op commits and status.maintenanceActive is false', async () => {
    const economy = makeEconomy(1, undefined, PAST);
    try {
      const funded = await economy.submit(
        adjust({
          account: spendable('usr_open_buyer'),
          amount: credit('100.00'),
          reason: 'fund buyer outside the window',
        }),
      );
      assert.equal(funded.status, 'committed');

      const out = await economy.submit(
        spend({
          buyerId: 'usr_open_buyer',
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: 'usr_open_seller', shareBps: 10_000 }],
        }),
      );
      assert.equal(
        out.status,
        'committed',
        'a user op commits when not paused',
      );

      const status = economy.read.status();
      assert.equal(status.maintenanceActive, false);
      assert.equal(status.resumesAt, null, 'resumesAt is null when not paused');
      assert.equal(
        status.pauseStart,
        PAST.pauseStartMs,
        'bounds still reported',
      );
      assert.equal(status.pauseEnd, PAST.pauseEndMs);
    } finally {
      await economy.close();
    }
  });
});
