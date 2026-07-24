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

/**
 * The capacity report (read.capacity): the load-bearing gauges behind the scale knobs, read
 * live, with advisories as stated facts against CAPACITY_THRESHOLDS. The signal layer decides
 * nothing — it measures, and a missing gauge reads as unknown, never as zero.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CAPACITY_THRESHOLDS } from '#src/contract.ts';
import { createEconomy } from '#src/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  makePorts,
  fixedClock,
  seededDigest,
} from '#test/support/capabilities.ts';
import { economyWithStore } from '#test/support/economy.ts';
import { topUp, credit } from '#test/support/builders.ts';

describe('Capacity report', () => {
  test('reads the gauges live and reports absent surfaces as unknown', async () => {
    const { economy } = economyWithStore();
    await economy.submit(
      topUp({ userId: 'usr_cap1', amount: credit('10.00') }),
    );

    const report = await economy.read.capacity();
    // The fused topUp wrote its posting pair; history counts postings, not operations.
    assert.equal(report.historySize, 2);
    // No rotation, no seal yet: unknown, not zero — and unknown raises no advisory.
    assert.deepEqual(report.reproof, { rotatedAt: null, ageMs: null });
    assert.deepEqual(report.checkpoint, { at: null, count: null, ageMs: null });
    assert.equal(report.accruals.pendingMinor, '0');
    assert.deepEqual(report.sessions, { count: 0, capped: false });
    assert.deepEqual(report.reservations, { accounts: 0, capped: false });
    // The memory store gauges its tables: one idempotency row and one outbox event per submit.
    assert.deepEqual(report.tables, {
      movements: 0,
      idempotency: 1,
      sales: 0,
      outbox: 1,
      sagas: 0,
      accruals: 0,
    });
    assert.deepEqual(report.advisories, []);
  });

  test('states facts when a gauge crosses its documented threshold', async () => {
    const digest = seededDigest(1);
    const past = 0;
    const now = CAPACITY_THRESHOLDS.reproofMaxAgeMs + 60_000;
    const store = memoryStore({ digest, clock: fixedClock(past) });
    const economy = createEconomy(makePorts(store, { clock: fixedClock(now) }));
    await store.checkpoints.putReproof!({ cursor: null, rotatedAt: past });

    const report = await economy.read.capacity();
    assert.equal(report.reproof.rotatedAt, past);
    assert.equal(report.reproof.ageMs, now);
    assert.equal(report.advisories.length, 1);
    assert.match(report.advisories[0]!, /re-proof watermark/);
    assert.match(report.advisories[0]!, /lags the coverage story/);
  });

  test('table gauges read unknown without the store surface and state facts past the row threshold', async () => {
    const digest = seededDigest(1);
    const store = memoryStore({ digest, clock: fixedClock(0) });
    const { tableSizes, ...bare } = store;
    assert.notEqual(tableSizes, undefined);
    const blind = createEconomy(makePorts(bare));
    const unknown = await blind.read.capacity();
    assert.deepEqual(unknown.tables, {
      movements: null,
      idempotency: null,
      sales: null,
      outbox: null,
      sagas: null,
      accruals: null,
    });
    assert.deepEqual(unknown.advisories, []);

    const big = {
      ...store,
      tableSizes: async () => ({
        movements: 0,
        idempotency: CAPACITY_THRESHOLDS.tableRows,
        sales: 0,
        outbox: 0,
        sagas: 0,
        accruals: 0,
      }),
    };
    const economy = createEconomy(makePorts(big));
    const report = await economy.read.capacity();
    assert.equal(report.tables.idempotency, CAPACITY_THRESHOLDS.tableRows);
    assert.equal(report.advisories.length, 1);
    assert.match(report.advisories[0]!, /`idempotency` holds/);
    assert.match(report.advisories[0]!, /retention sweep/);
  });
});
