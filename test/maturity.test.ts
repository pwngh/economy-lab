/// <reference types="node" />
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

import {
  immatureBalance,
  isMatured,
  lotMaturesAt,
  maturedBalance,
  maturityHorizonMs,
} from '#src/maturity.ts';
import type { MaturityOptions } from '#src/maturity.ts';
import { credit } from '#test/support/builders.ts';
import { testConfig } from '#test/support/capabilities.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Config } from '#src/config.ts';
import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Clock, Ledger, Lot } from '#src/ports.ts';

const DAY = 24 * 60 * 60_000;

// A config whose funding sources have different wait times, so a test can tell which
// source's wait was applied. The `default` entry is the wait an unrecognized source
// falls back to; here it matches the card wait (the cautious, longer one). The shared
// testConfig() instead sets every wait to 0, which the zero-wait test reuses to drive
// the same code with no waiting at all.
function horizonConfig(): Config {
  return {
    ...testConfig(),
    maturityHorizonMs: { card: 7 * DAY, crypto: 1 * DAY, default: 7 * DAY },
  };
}

// A clock that only moves forward when `advance` is called. The ledger stamps each
// top-up with the current clock time, so this lets a test set exactly when a batch of
// credits (a "lot") was topped up rather than depending on real wall-clock time.
function fixedClock(start = 0): Clock & { advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

// Add credits to a user, which the ledger records as one settlement batch (a "lot").
// The funding source (such as 'card' or 'crypto') is attached in the posting's metadata,
// the same way the real top-up handler attaches it, because the maturity wait is chosen
// from that source. The clock time when this posts becomes the lot's top-up time.
async function topUpLot(
  ledger: Ledger,
  userId: string,
  amount: Amount,
  source: string,
): Promise<void> {
  await postEntry(ledger, {
    txnId: `txn_${userId}_${source}_${amount.minor}`,
    legs: [debit(SYSTEM.REVENUE, amount), creditLeg(spendable(userId), amount)],
    meta: { kind: 'topUp', source },
  });
}

// Take credits out of a user's spendable balance. Spending creates no new lot (only
// balance-increasing postings do), it just lowers the balance. The maturity code treats
// that drop as consuming the oldest lots first, so spending eats into the earliest
// top-ups before the later ones.
async function spendSpendable(
  ledger: Ledger,
  userId: string,
  amount: Amount,
): Promise<void> {
  await postEntry(ledger, {
    txnId: `txn_${userId}_spend_${amount.minor}`,
    legs: [debit(spendable(userId), amount), creditLeg(SYSTEM.REVENUE, amount)],
    meta: { kind: 'spend' },
  });
}

describe('maturityHorizonMs', () => {
  test('reads the configured horizon for a known funding source', () => {
    const config = horizonConfig();

    const cases = [
      { source: 'card', horizonMs: 7 * DAY },
      { source: 'crypto', horizonMs: 1 * DAY },
    ];

    for (const { source, horizonMs } of cases) {
      assert.equal(maturityHorizonMs(source, config), horizonMs);
    }
  });

  test('falls back to the conservative default for an unknown source', () => {
    const config = horizonConfig();

    const horizonMs = maturityHorizonMs('wire_transfer', config);

    assert.equal(horizonMs, config.maturityHorizonMs.default);
  });

  test('treats the in-memory default source marker as unknown', () => {
    const config = horizonConfig();

    // When a top-up records no funding source, the in-memory ledger fills in the literal
    // string 'unknown'. The config has no entry named 'unknown', so the lookup must fall
    // back to the default wait instead of failing.
    const horizonMs = maturityHorizonMs('unknown', config);

    assert.equal(horizonMs, config.maturityHorizonMs.default);
  });
});

describe('lotMaturesAt', () => {
  test('matures a lot at its top-up time plus its source horizon', () => {
    const config = horizonConfig();
    const lot: Lot = {
      txnId: 'txn_1',
      amount: credit('10.00'),
      source: 'card',
      toppedUpAt: 1_000,
      maturesAt: 1_000, // the lot's own stored value; the function ignores it and recomputes
    };

    const maturesAt = lotMaturesAt(lot, config);

    assert.equal(maturesAt, 1_000 + 7 * DAY);
  });

  test('derives maturity from the source, not the lot maturesAt field', () => {
    const config = horizonConfig();
    const lot: Lot = {
      txnId: 'txn_1',
      amount: credit('10.00'),
      source: 'crypto',
      toppedUpAt: 0,
      maturesAt: 999_999_999, // a deliberately wrong stored value the function must ignore
    };

    const maturesAt = lotMaturesAt(lot, config);

    assert.equal(maturesAt, 1 * DAY);
  });
});

describe('isMatured', () => {
  test('is inclusive at the maturity boundary', () => {
    const config = horizonConfig();
    const lot: Lot = {
      txnId: 'txn_1',
      amount: credit('10.00'),
      source: 'crypto',
      toppedUpAt: 0,
      maturesAt: 0,
    };

    const cases = [
      { now: 1 * DAY - 1, matured: false },
      { now: 1 * DAY, matured: true },
      { now: 1 * DAY + 1, matured: true },
    ];

    for (const { now, matured } of cases) {
      assert.equal(isMatured(lot, now, config), matured);
    }
  });
});

describe('maturedBalance', () => {
  test('counts no balance as matured before the horizon elapses', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('10.00'), 'card');
    const options: MaturityOptions = { config: horizonConfig() };

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      7 * DAY - 1,
      options,
    );

    assert.deepEqual(matured, credit('0.00'));
  });

  test('counts the balance as matured once the horizon elapses', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('10.00'), 'card');
    const options: MaturityOptions = { config: horizonConfig() };

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      7 * DAY,
      options,
    );

    assert.deepEqual(matured, credit('10.00'));
  });

  test('matures faster-settling sources on their own horizon', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('4.00'), 'crypto');
    const options: MaturityOptions = { config: horizonConfig() };

    // At one day the crypto lot has matured but a card lot would not have.
    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      1 * DAY,
      options,
    );

    assert.deepEqual(matured, credit('4.00'));
  });

  test('counts only the matured lots across a mixed-source timeline', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('4.00'), 'crypto'); // matures at 1 day
    await topUpLot(store.ledger, 'usr_a', credit('6.00'), 'card'); // matures at 7 days
    const options: MaturityOptions = { config: horizonConfig() };

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      1 * DAY,
      options,
    );

    assert.deepEqual(matured, credit('4.00'));
  });
});

describe('maturedBalance FIFO Consumption', () => {
  test('FIFO-drains the oldest lots first when a spend lowers the balance', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('4.00'), 'crypto'); // topped up at day 0, crypto waits 1 day -> matures day 1
    clock.advance(2 * DAY);
    await topUpLot(store.ledger, 'usr_a', credit('6.00'), 'card'); // topped up at day 2, card waits 7 days -> matures day 9
    // Spend 4.00 exactly drains the crypto lot, leaving only the card lot.
    await spendSpendable(store.ledger, 'usr_a', credit('4.00'));
    const options: MaturityOptions = { config: horizonConfig() };

    // At day 3 the crypto lot would have matured, but the spend already consumed it, and
    // the card lot that remains does not mature until day 9 — so nothing is cashable yet.
    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      3 * DAY,
      options,
    );

    assert.deepEqual(matured, credit('0.00'));
  });

  test('splits the lot a partial spend lands inside, keeping the matured remainder', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('10.00'), 'crypto'); // matures at 1 day
    // Partial spend drains part of the single lot; the 7.00 remainder stays matured.
    await spendSpendable(store.ledger, 'usr_a', credit('3.00'));
    const options: MaturityOptions = { config: horizonConfig() };

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      1 * DAY,
      options,
    );

    assert.deepEqual(matured, credit('7.00'));
  });

  test('matures everything immediately under a zero-horizon config', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('10.00'), 'card');
    const options: MaturityOptions = { config: testConfig() }; // every source's wait is 0

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      0,
      options,
    );

    assert.deepEqual(matured, credit('10.00'));
  });

  test('returns zero for an account that was never topped up', async () => {
    const store = memoryStore();
    const options: MaturityOptions = { config: horizonConfig() };

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_empty') as AccountRef,
      Number.MAX_SAFE_INTEGER,
      options,
    );

    assert.deepEqual(matured, credit('0.00'));
  });
});

describe('immatureBalance', () => {
  test('reports the still-settling remainder so the two halves sum to the balance', async () => {
    const clock = fixedClock(0);
    const store = memoryStore({ clock });
    await topUpLot(store.ledger, 'usr_a', credit('4.00'), 'crypto'); // matures at 1 day
    await topUpLot(store.ledger, 'usr_a', credit('6.00'), 'card'); // matures at 7 days
    const options: MaturityOptions = { config: horizonConfig() };

    const matured = await maturedBalance(
      store.ledger,
      spendable('usr_a'),
      1 * DAY,
      options,
    );
    const immature = await immatureBalance(
      store.ledger,
      spendable('usr_a'),
      1 * DAY,
      options,
    );

    assert.deepEqual(matured, credit('4.00'));
    assert.deepEqual(immature, credit('6.00'));
  });
});
