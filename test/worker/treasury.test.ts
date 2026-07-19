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
  makePorts,
  makeWorkerCtx,
  testConfig,
} from '#test/support/capabilities.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { Config } from '#src/config.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Logger, Meter, Rates, Store, Unit } from '#src/ports.ts';

// Pins par at $0.01 per credit so figures stay round; the shared fixedRates() $0.005 would give
// fractions. The peg is only a test fixture.
function treasuryRates(): Rates {
  const credCons = (kind: string, rate: bigint, scale: number) => ({
    rate,
    scale,
    rateId: `${kind}:CREDIT->USD:${rate}/${scale}`,
  });
  const identity = (kind: string, c: Currency) => ({
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

// The shared defaults plus the $0.01-peg treasuryRates() this suite depends on.
function workerCtx(overrides?: {
  logger?: Logger;
  meter?: Meter;
  config?: Config;
}): WorkerCtx {
  return makeWorkerCtx({ rates: treasuryRates(), ...overrides });
}

// For an exactly backed state at the $0.01 peg, pass `cash` equal to the credits' par value.
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

// The surplus is trust cash valued in credits at the $0.01 peg beyond what users are owed:
// $1.30 of trust is 130 credits, minus 100 owed, a surplus of 30. A sweep moves at most the
// smaller of the surplus and matured revenue.
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

function capturingLogger(): Logger & {
  lines: Array<{ level: string; event: string }>;
} {
  const lines: Array<{ level: string; event: string }> = [];
  return {
    lines,
    log: (level, event) => {
      lines.push({ level, event });
    },
  };
}

// The sweep totals balances through `ledger.heads`, so throwing there forces a failure mid-check.
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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedBacked(unit, 'usr_backed', credit('100.00'), usd('1.00')),
    );

    const summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.equal(summary.position?.backed, true);
    assert.deepEqual(summary.position?.shortfall, usd('0.00'));
    assert.deepEqual(summary.breaches, []);
  });

  test('measures the credits owed to users excluding earned, promo, and the reserve', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedBacked(unit, 'usr_backed', credit('40.00'), usd('0.40')),
    );

    const summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.deepEqual(summary.position?.custodialCredit, credit('40.00'));
    assert.deepEqual(summary.position?.required, usd('0.40'));
    assert.deepEqual(summary.position?.trustCash, usd('0.40'));
  });

  test('raises a breach when spendable is issued without matching custody cash', async () => {
    const store = memoryStore();
    const logger = capturingLogger();
    await store.transaction((unit) =>
      seedUnbacked(unit, 'usr_short', credit('75.00')),
    );

    const summary = await sweepTreasury(store, workerCtx({ logger }), {
      now: 0,
    });

    assert.equal(summary.position?.backed, false);
    assert.deepEqual(summary.position?.shortfall, usd('0.75'));
    assert.deepEqual(summary.breaches, [
      { shortfall: 'USD:0.75', required: 'USD:0.75', held: 'USD:0.00' },
    ]);
    assert.ok(
      logger.lines.some(
        (line) =>
          line.level === 'error' &&
          line.event === 'worker.treasury.under_backed',
      ),
    );
  });

  test('books no posting for a breach, leaving the ledger untouched', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedUnbacked(unit, 'usr_short', credit('30.00')),
    );

    await sweepTreasury(store, workerCtx(), { now: 0 });
    const spendableAfter = await store.ledger.balance(spendable('usr_short'));

    assert.deepEqual(spendableAfter, credit('30.00'));
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.RECEIVABLE),
      credit('0.00'),
    );
  });

  test('leaves the position for the next sweep on a retryable store failure', async () => {
    const store = poisonHeads(
      memoryStore(),
      fault('STORE.FAILURE', 'transient read failure', { retryable: true }),
    );

    const summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.equal(summary.position, null);
    assert.deepEqual(summary.retrying, [{ code: 'STORE.FAILURE' }]);
    assert.deepEqual(summary.failed, []);
  });

  test('records a terminal fault without throwing out of the worker loop', async () => {
    const store = poisonHeads(
      memoryStore(),
      fault('LEDGER.UNKNOWN_ACCOUNT', 'terminal read fault', {
        retryable: false,
      }),
    );

    const summary = await sweepTreasury(store, workerCtx(), { now: 0 });

    assert.equal(summary.position, null);
    assert.deepEqual(summary.failed, [{ code: 'LEDGER.UNKNOWN_ACCOUNT' }]);
    assert.deepEqual(summary.retrying, []);
  });
});

describe('sweepFees', () => {
  test('realizes revenue as cash: REVENUE and TRUST_CASH each drop by the swept amount', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const result = await sweepFees(store, workerCtx(), {
      amount: credit('30.00'),
    });

    assert.equal(result.duplicate, false);
    assert.deepEqual(result.swept, credit('30.00'));
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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('50.00'),
      }),
    );

    // The surplus is 30 (see seedSurplus), so a 31-credit sweep dips into custodial cash.
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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    // The seed revenue, posted at 0 with no source, takes the 1000ms window set below; at now 0
    // nothing has matured, so the sweepable ceiling is 0 despite the surplus of 30.
    const config: Config = {
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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const ctx = workerCtx();
    const first = await sweepFees(store, ctx, {
      amount: credit('10.00'),
      key: '2026-06',
    });
    const second = await sweepFees(store, ctx, {
      amount: credit('10.00'),
      key: '2026-06',
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.swept, credit('0.00'));
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('20.00'),
    );
  });

  test('rejects a non-positive sweep amount as INVALID_AMOUNT', async () => {
    const store = memoryStore();

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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const result = await sweepFees(store, workerCtx(), {
      amount: credit('30.00'),
    });
    assert.equal(result.duplicate, false);

    const queued = await store.outbox.claimBatch(10);
    const swept = queued.filter((m) => m.event.type === 'economy.fees.swept');
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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const ctx = workerCtx();
    await sweepFees(store, ctx, { amount: credit('10.00'), key: '2026-06' });
    await sweepFees(store, ctx, { amount: credit('10.00'), key: '2026-06' });

    const queued = await store.outbox.claimBatch(10);
    const swept = queued.filter((m) => m.event.type === 'economy.fees.swept');
    assert.equal(swept.length, 1);
  });
});

describe('realizeFees: The Per-Cycle Policy', () => {
  test('sweeps the full available surplus and emits one economy.fees.swept', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const summary = await realizeFees(store, workerCtx(), { now: 1_000 });

    assert.equal(summary.skipped, false);
    assert.equal(summary.duplicate, false);
    assert.equal(summary.swept, 'CREDIT:30.00');
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      usd('1.00'),
    );

    const queued = await store.outbox.claimBatch(10);
    const swept = queued.filter((m) => m.event.type === 'economy.fees.swept');
    assert.equal(swept.length, 1);
    assert.equal(swept[0].event.audience, 'internal');
  });

  test('caps the cycle sweep at the lesser of surplus and matured revenue', async () => {
    const store = memoryStore();
    // REVENUE (20) is below the surplus (30), so the matured-revenue cap binds.
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('20.00'),
      }),
    );

    const summary = await realizeFees(store, workerCtx(), { now: 1_000 });

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
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.00'),
        revenue: credit('0.00'),
      }),
    );

    const summary = await realizeFees(store, workerCtx(), { now: 1_000 });

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

    const queued = await store.outbox.claimBatch(10);
    assert.deepEqual(
      queued.filter((m) => m.event.type === 'economy.fees.swept'),
      [],
    );
  });

  test('a repeated cycle (same now) is idempotent: the second sweep is a no-op', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const ctx = workerCtx();
    const first = await realizeFees(store, ctx, { now: 1_000 });
    // The same `now` derives the same dedup key, but this test never reaches that check: the
    // second sweep sees surplus 0 and short-circuits to skip.
    const second = await realizeFees(store, ctx, { now: 1_000 });

    assert.equal(first.swept, 'CREDIT:30.00');
    assert.equal(second.skipped, true);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );
  });
});

describe('runSweeps: Fee Realization Is Wired Into The Worker Cycle', () => {
  // The bare input that drives one cycle: an empty feed for reconcile, no dispatcher so relay skips.
  function cycleInput(now: number) {
    return {
      now,
      limit: 10,
      feed: { pull: async () => ({ processor: [], ledger: [] }) },
      windows: [],
    };
  }

  test('a cycle with realized surplus posts one fee sweep and one economy.fees.swept', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.30'),
        revenue: credit('30.00'),
      }),
    );

    const batch = await runSweeps(
      store,
      makePorts(store, { rates: treasuryRates() }),
      cycleInput(1_000),
    );

    assert.equal(batch.feeSweep.ok, true);
    assert.equal(
      (batch.feeSweep as { summary: { swept: string } }).summary.swept,
      'CREDIT:30.00',
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      credit('0.00'),
    );

    const queued = await store.outbox.claimBatch(10);
    assert.equal(
      queued.filter((m) => m.event.type === 'economy.fees.swept').length,
      1,
    );
  });

  test('a cycle with zero surplus posts and emits nothing for the fee sweep', async () => {
    const store = memoryStore();
    await store.transaction((unit) =>
      seedSurplus(unit, {
        spendableCredit: credit('100.00'),
        trustCash: usd('1.00'),
        revenue: credit('0.00'),
      }),
    );

    const batch = await runSweeps(
      store,
      makePorts(store, { rates: treasuryRates() }),
      cycleInput(1_000),
    );

    assert.equal(batch.feeSweep.ok, true);
    assert.equal(
      (batch.feeSweep as { summary: { skipped: boolean } }).summary.skipped,
      true,
    );
    const queued = await store.outbox.claimBatch(10);
    assert.deepEqual(
      queued.filter((m) => m.event.type === 'economy.fees.swept'),
      [],
    );
  });
});
