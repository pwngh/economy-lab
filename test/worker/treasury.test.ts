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

import { sweepTreasury, sweepFees, realizeFees } from '#src/worker/treasury.ts';
import { runSweeps } from '#src/worker/index.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { fault } from '#src/errors.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';
import { credit, usd } from '#test/support/builders.ts';
import {
  fixedClock,
  noopMeter,
  sequentialIds,
  seededDigest,
  seededSigner,
  fakeProcessor,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { Config } from '#src/config.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Logger, Meter, Rates, Store, Unit } from '#src/ports.ts';

// These tests pin a par rate of $0.01 per credit (shared `fixedRates()` uses $0.005), so
// the surplus/shortfall assertions stay round. The fee sweep reads par from `rates` and works at any
// value; the peg is just a fixture.
function treasuryRates(): Rates {
  let credCons = (kind: string, rate: bigint, scale: number) => ({
    rate,
    scale,
    rateId: `${kind}:CREDIT->USD:${rate}/${scale}`,
  });
  let identity = (kind: string, c: Currency) => ({
    rate: 1n,
    scale: 0,
    rateId: `${kind}:${c}->USD:1`,
  });
  return {
    payout: async (from, to) =>
      from === 'CREDIT' && to === 'USD'
        ? credCons('payout', 5n, 3)
        : identity('payout', from),
    par: (c) => (c === 'CREDIT' ? credCons('par', 1n, 2) : identity('par', c)),
    buy: (c) => (c === 'CREDIT' ? credCons('buy', 1n, 2) : identity('buy', c)),
  };
}

// Capability bundle the sweep runs with. The sweep uses `rates` (to value credits in USD at the
// peg) and `logger`/`meter` (to report a shortfall); the rest are present for completeness. Pass
// `overrides` to swap in an inspectable logger or meter.
function workerCtx(overrides?: {
  logger?: Logger;
  meter?: Meter;
  config?: Config;
}): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: treasuryRates(),
    logger: overrides?.logger ?? testLogger(),
    meter: overrides?.meter ?? noopMeter(),
    config: overrides?.config ?? testConfig(),
  };
}

// Fully-backed starting state. Two balanced entries: issue `amount` spendable credits to the user,
// move `cash` of USD into trust. At the $0.01 peg, pass `cash` equal to par value (credits × $0.01)
// for an exactly-backed state.
async function seedBacked(
  unit: Unit,
  userId: string,
  amount: Amount,
  cash: Amount,
): Promise<void> {
  await postEntry(unit.ledger, {
    txnId: 'txn_seed_credit',
    legs: [
      debit(SYSTEM.STORED_VALUE, amount),
      creditLeg(spendable(userId), amount),
    ],
    meta: { kind: 'test.seed.issue' },
  });
  await postEntry(unit.ledger, {
    txnId: 'txn_seed_cash',
    legs: [
      debit(SYSTEM.TRUST_CASH, cash),
      creditLeg(SYSTEM.USD_CLEARING, cash),
    ],
    meta: { kind: 'test.seed.cash' },
  });
}

// Under-backed starting state: issue `amount` spendable credits but move no USD into trust. Credits
// owed exceed cash held, so the backing check finds a shortfall.
async function seedUnbacked(
  unit: Unit,
  userId: string,
  amount: Amount,
): Promise<void> {
  await postEntry(unit.ledger, {
    txnId: 'txn_seed_unbacked',
    legs: [
      debit(SYSTEM.STORED_VALUE, amount),
      creditLeg(spendable(userId), amount),
    ],
    meta: { kind: 'test.seed.issue' },
  });
}

// Seed a house surplus plus accrued revenue, the precondition a fee sweep realizes. Issue
// `spendableCredit` to a user (a custodial balance: owed to the user, must be backed by USD), move
// `trustCash` of USD into custody, accrue `revenue` of platform fees into REVENUE. At the $0.01 peg
// the surplus is trust cash valued in credits beyond what users are owed (e.g. $1.30 trust = 130
// credits, minus 100 owed = 30). A sweep moves at most min(surplus, matured revenue) where matured
// means past the refund window.
async function seedSurplus(
  unit: Unit,
  amounts: { spendableCredit: Amount; trustCash: Amount; revenue: Amount },
): Promise<void> {
  await postEntry(unit.ledger, {
    txnId: 'txn_seed_spendable',
    legs: [
      debit(SYSTEM.STORED_VALUE, amounts.spendableCredit),
      creditLeg(spendable('usr_seed'), amounts.spendableCredit),
    ],
    meta: { kind: 'test.seed.issue' },
  });
  await postEntry(unit.ledger, {
    txnId: 'txn_seed_trust',
    legs: [
      debit(SYSTEM.TRUST_CASH, amounts.trustCash),
      creditLeg(SYSTEM.USD_CLEARING, amounts.trustCash),
    ],
    meta: { kind: 'test.seed.cash' },
  });
  await postEntry(unit.ledger, {
    txnId: 'txn_seed_revenue',
    legs: [
      debit(SYSTEM.STORED_VALUE, amounts.revenue),
      creditLeg(SYSTEM.REVENUE, amounts.revenue),
    ],
    meta: { kind: 'test.seed.revenue' },
  });
}

// Logger that keeps every line, so a test can check the shortfall was logged at `error` level.
function capturingLogger(): Logger & {
  lines: Array<{ level: string; event: string }>;
} {
  let lines: Array<{ level: string; event: string }> = [];
  return {
    lines,
    log: (level, event) => {
      lines.push({ level, event });
    },
  };
}

// Copy of the store whose `ledger.heads` (lists every account) throws `error`. The sweep totals
// balances through `heads`, so this forces a failure mid-check to test error classification (retry
// vs. give up).
function poisonHeads(store: Store, error: Error): Store {
  return {
    ...store,
    ledger: {
      ...store.ledger,
      heads: () => {
        throw error;
      },
    },
  };
}

describe('sweepTreasury', () => {
  test('reports a fully backed position when custody cash matches the credits owed to users', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedBacked(unit, 'usr_backed', credit('100.00'), usd('1.00')),
    );

    let summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.equal(summary.position?.backed, true);
    assert.deepEqual(summary.position?.shortfall, usd('0.00'));
    assert.deepEqual(summary.breaches, []);
  });

  test('measures the credits owed to users excluding earned, promo, and the reserve', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedBacked(unit, 'usr_backed', credit('40.00'), usd('0.40')),
    );

    let summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.deepEqual(summary.position?.custodialCredit, credit('40.00'));
    assert.deepEqual(summary.position?.required, usd('0.40'));
    assert.deepEqual(summary.position?.trustCash, usd('0.40'));
  });

  test('raises a breach when spendable is issued without matching custody cash', async () => {
    let store = memoryStore();
    let logger = capturingLogger();
    await store.transaction((unit) =>
      seedUnbacked(unit, 'usr_short', credit('75.00')),
    );

    let summary = await sweepTreasury(store, workerCtx({ logger }), { now: 0 });

    assert.equal(summary.position?.backed, false);
    assert.deepEqual(summary.position?.shortfall, usd('0.75'));
    assert.deepEqual(summary.breaches, [
      { shortfall: 'USD:0.75', required: 'USD:0.75', held: 'USD:0.00' },
    ]);
    assert.ok(
      logger.lines.some(
        (line) =>
          line.level === 'error' &&
          line.event === 'economy.treasury.under_backed',
      ),
    );
  });

  test('books no posting for a breach, leaving the ledger untouched', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedUnbacked(unit, 'usr_short', credit('30.00')),
    );

    await sweepTreasury(store, workerCtx(), { now: 0 });
    let spendableAfter = await store.ledger.balance(spendable('usr_short'));

    assert.deepEqual(spendableAfter, credit('30.00'));
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.RECEIVABLE),
      credit('0.00'),
    );
  });

  test('leaves the position for the next sweep on a retryable store failure', async () => {
    let store = poisonHeads(
      memoryStore(),
      fault('STORE.FAILURE', 'transient read failure', { retryable: true }),
    );

    let summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.equal(summary.position, null);
    assert.deepEqual(summary.retrying, [{ code: 'STORE.FAILURE' }]);
    assert.deepEqual(summary.failed, []);
  });

  test('records a terminal fault without throwing out of the worker loop', async () => {
    let store = poisonHeads(
      memoryStore(),
      fault('LEDGER.UNKNOWN_ACCOUNT', 'terminal read fault', {
        retryable: false,
      }),
    );

    let summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.equal(summary.position, null);
    assert.deepEqual(summary.failed, [{ code: 'LEDGER.UNKNOWN_ACCOUNT' }]);
    assert.deepEqual(summary.retrying, []);
  });
});

describe('sweepFees', () => {
  test('realizes revenue as cash: REVENUE and TRUST_CASH each drop by the swept amount', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let result = await sweepFees(store, workerCtx(), {
      amount: credit('30.00'),
    });

    assert.equal(result.duplicate, false);
    assert.deepEqual(result.swept, credit('30.00'));
    // The CREDIT leg retired REVENUE; the paired USD leg lowered custody cash by the same
    // peg-valued amount. The user's spendable balance is untouched.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('1.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_seed')),
      credit('100.00'),
    );
  });

  test('throws COMMINGLING and posts nothing when the draw exceeds the sweepable surplus', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('50.00'),
      }),
    );

    // $1.30 trust = 130 credits at $0.01 par; minus 100 owed, surplus is 30, so a 31-credit sweep
    // dips into custodial cash.
    await assert.rejects(
      () => sweepFees(store, workerCtx(), { amount: credit('31.00') }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'LEDGER.COMMINGLING',
    );

    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('50.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('1.30'),
    );
  });
});

describe('sweepFees: Caps, Idempotency & Validation', () => {
  test('caps the sweep at matured REVENUE so a fee inside its refund window cannot be swept', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    // Revenue is sweepable only once matured: past the window in which the original charge could be
    // refunded. The window length comes from the funding source; this revenue was posted at time 0
    // with no source, so it uses the card window (1000ms below). Clock still at 0, so nothing has
    // matured and the sweepable ceiling is 0 even though surplus is 30.
    let config: Config = {
      ...testConfig(),
      maturityHorizonMs: { card: 1000, default: 1000 },
    };

    await assert.rejects(
      () => sweepFees(store, workerCtx({ config }), { amount: credit('1.00') }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'LEDGER.COMMINGLING',
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('30.00'),
    );
  });

  test('a replayed sweep key is a no-op: it posts and realizes nothing the second time', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let ctx = workerCtx();
    let first = await sweepFees(store, ctx, {
      amount: credit('10.00'),
      key: '2026-06',
    });
    let second = await sweepFees(store, ctx, {
      amount: credit('10.00'),
      key: '2026-06',
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.swept, credit('0.00'));
    // Only the first sweep moved money: REVENUE fell once, from 30 to 20.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('20.00'),
    );
  });

  test('rejects a non-positive sweep amount as INVALID_AMOUNT', async () => {
    let store = memoryStore();

    await assert.rejects(
      () => sweepFees(store, workerCtx(), { amount: credit('0.00') }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'MONEY.INVALID_AMOUNT',
    );
  });
});

describe('sweepFees: Event Emission', () => {
  test('emits exactly one internal economy.fees.swept co-committed with the posting', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let result = await sweepFees(store, workerCtx(), {
      amount: credit('30.00'),
    });
    assert.equal(result.duplicate, false);

    let queued = await store.outbox.claimBatch(10);
    let swept = queued.filter((m) => m.event.type === 'economy.fees.swept');
    assert.equal(swept.length, 1);
    assert.equal(swept[0].event.audience, 'internal');
    // Subject is the realizing CREDIT posting's txn id so a consumer can tie the two together.
    assert.equal(
      swept[0].event.subject,
      (result as { transaction: { id: string } }).transaction.id,
    );
    assert.deepEqual(swept[0].event.data, { swept: 'CREDIT:30.00' });
  });

  test('a replayed sweep key emits no second economy.fees.swept', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let ctx = workerCtx();
    await sweepFees(store, ctx, { amount: credit('10.00'), key: '2026-06' });
    await sweepFees(store, ctx, { amount: credit('10.00'), key: '2026-06' });

    let queued = await store.outbox.claimBatch(10);
    let swept = queued.filter((m) => m.event.type === 'economy.fees.swept');
    assert.equal(swept.length, 1);
  });
});

describe('realizeFees: The Per-Cycle Policy', () => {
  test('sweeps the full available surplus and emits one economy.fees.swept', async () => {
    let store = memoryStore();
    // $1.30 trust = 130 credits at par; minus 100 owed, surplus is 30, and matured REVENUE is 30, so
    // the cycle sweeps the full 30.
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let summary = await realizeFees(store, workerCtx(), { now: 1_000 });

    assert.equal(summary.skipped, false);
    assert.equal(summary.duplicate, false);
    assert.equal(summary.swept, 'CREDIT:30.00');
    // REVENUE fully retired; custody cash dropped by the peg-valued amount.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('1.00'),
    );

    let queued = await store.outbox.claimBatch(10);
    let swept = queued.filter((m) => m.event.type === 'economy.fees.swept');
    assert.equal(swept.length, 1);
    assert.equal(swept[0].event.audience, 'internal');
  });

  test('caps the cycle sweep at the lesser of surplus and matured revenue', async () => {
    let store = memoryStore();
    // Surplus is 30 ($1.30 trust = 130 credits at par, minus 100 owed) but REVENUE is only 20, so the
    // matured-revenue cap binds: the cycle realizes 20, not 30.
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('20.00'),
      }),
    );

    let summary = await realizeFees(store, workerCtx(), { now: 1_000 });

    assert.equal(summary.skipped, false);
    assert.equal(summary.swept, 'CREDIT:20.00');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
  });
});

describe('realizeFees: Skip And Idempotency', () => {
  test('skips with no posting or event when the available surplus is zero', async () => {
    let store = memoryStore();
    // Fully backed and no accrued revenue: surplus is 0, so there is nothing to realize.
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.00'),
        revenue: credit('0.00'),
      }),
    );

    let summary = await realizeFees(store, workerCtx(), { now: 1_000 });

    assert.equal(summary.skipped, true);
    assert.equal(summary.duplicate, false);
    assert.equal(summary.swept, 'CREDIT:0.00');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('1.00'),
    );

    let queued = await store.outbox.claimBatch(10);
    assert.deepEqual(
      queued.filter((m) => m.event.type === 'economy.fees.swept'),
      [],
    );
  });

  test('a repeated cycle (same now) is idempotent: the second sweep is a no-op', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let ctx = workerCtx();
    let first = await realizeFees(store, ctx, { now: 1_000 });
    // Each cycle derives a dedup key from its time, so the same time gives the same key, and a sweep
    // already run under a key is not re-applied. This test never reaches that check: the first run
    // realized all 30, so the second sees surplus 0 and short-circuits to skip.
    let second = await realizeFees(store, ctx, { now: 1_000 });

    assert.equal(first.swept, 'CREDIT:30.00');
    assert.equal(second.skipped, true);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
  });
});

describe('runSweeps: Fee Realization Is Wired Into The Worker Cycle', () => {
  // A full cycle runs several jobs; only the fee sweep matters here. The reconcile job needs a feed
  // (empty below), and with no event dispatcher the event-relay step no-ops. The fee-sweep job needs
  // neither, so this bare input drives one cycle.
  function cycleInput(now: number) {
    return {
      now,
      limit: 10,
      feed: { pull: async () => ({ processor: [], ledger: [] }) },
      windows: [],
    };
  }

  test('a cycle with realized surplus posts one fee sweep and one economy.fees.swept', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    let batch = await runSweeps(store, workerCtx(), cycleInput(1_000));

    assert.equal(batch.feeSweep.ok, true);
    assert.equal(
      (batch.feeSweep as { summary: { swept: string } }).summary.swept,
      'CREDIT:30.00',
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );

    let queued = await store.outbox.claimBatch(10);
    assert.equal(
      queued.filter((m) => m.event.type === 'economy.fees.swept').length,
      1,
    );
  });

  test('a cycle with zero surplus posts and emits nothing for the fee sweep', async () => {
    let store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.00'),
        revenue: credit('0.00'),
      }),
    );

    let batch = await runSweeps(store, workerCtx(), cycleInput(1_000));

    assert.equal(batch.feeSweep.ok, true);
    assert.equal(
      (batch.feeSweep as { summary: { skipped: boolean } }).summary.skipped,
      true,
    );
    let queued = await store.outbox.claimBatch(10);
    assert.deepEqual(
      queued.filter((m) => m.event.type === 'economy.fees.swept'),
      [],
    );
  });
});
