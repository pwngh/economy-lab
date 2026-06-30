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

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  immatureBalance,
  isMatured,
  lotMaturesAt,
  maturedAtLeast,
  maturedBalance,
  maturedBalanceFullScan,
  maturityHorizonMs,
} from '#src/maturity.ts';
import type { MaturityOptions } from '#src/maturity.ts';
import { credit } from '#test/support/builders.ts';
import {
  fixedClock,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  makeIsolatedMysqlStore,
  makeIsolatedPostgresStore,
} from '#test/support/adapters.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Config } from '#src/config.ts';
import { toAmount } from '#src/money.ts';
import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Clock, Ledger, Lot, Store } from '#src/ports.ts';

const DAY = 24 * 60 * 60_000;

// Gives each funding source a distinct wait time so a test can tell which wait was applied.
// `default` is the fallback for unrecognized sources, and it matches the longer card wait
// here. The separate testConfig() sets every wait to 0 and is reused by the zero-wait test.
function horizonConfig(): Config {
  return {
    ...testConfig(),
    maturityHorizonMs: { card: 7 * DAY, crypto: 1 * DAY, default: 7 * DAY },
  };
}

// Credits a user, which the ledger records as one lot. The source ('card', 'crypto', ...)
// goes in the posting meta the way the real top-up handler does, because the maturity wait
// is chosen from it. The clock time at posting becomes the lot's top-up time.
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

// Spends from a user's spendable balance. A spend creates no lot, because only
// balance-increasing postings do; it just lowers the balance. The maturity code treats that
// drop as FIFO consumption of the oldest lots first.
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

    // A top-up with no source gets the literal 'unknown' from the in-memory ledger. The
    // config has no 'unknown' entry, so the lookup falls back to the default.
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
      maturesAt: 1_000, // the lot's own stored value, which the function ignores and recomputes
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

    // At day 3 the crypto lot would have matured, but the spend already consumed it; the
    // remaining card lot doesn't mature until day 9, so nothing is cashable yet.
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

// Deterministic small LCG so the differential test is reproducible across runs (no seed flakiness).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// The differential matrix always runs on memory, and runs on postgres/mysql when they are
// reachable. The subtest skips otherwise, mirroring the conformance suites' connect-or-skip
// pattern. Each store is wired to a shared advancing clock, so a posting's lot maturity is
// stamped at the time we choose, and to the seeded digest, so the SQL engines' hash chain is
// deterministic.
type DiffBackend = 'memory' | 'postgres' | 'mysql';

// Builds a Postgres store on one throwaway schema (the shared isolated provisioning, the same the
// conformance matrix and the bench harness use), with the seeded digest and this test's advancing
// clock so the run is deterministic and the test controls each top-up time.
function postgresDiffStore(clock: Clock): Promise<Store> {
  const url =
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    'postgres://economy:economy@localhost:5432/economy_lab';
  return makeIsolatedPostgresStore({ url, digest: seededDigest(1), clock });
}

// Builds a MySQL store on its own throwaway database (the same shared isolated provisioning), with
// the seeded digest and this test's advancing clock.
async function mysqlDiffStore(clock: Clock): Promise<Store> {
  const url = process.env.MYSQL_TEST_URL;
  if (!url) {
    throw new Error('MYSQL_TEST_URL not set');
  }
  return makeIsolatedMysqlStore({ url, digest: seededDigest(1), clock });
}

// One step in the randomized timeline. A top-up records a lot tagged with its funding source,
// from which the maturity wait is chosen. A spend records no lot; the maturity code reads the
// balance drop as FIFO consumption of the oldest lots. Each step supplies its own `txnId` for a
// unique id.
type Step =
  | {
      kind: 'topUp';
      userId: string;
      amount: Amount;
      source: string;
      txnId: string;
    }
  | { kind: 'spend'; userId: string; amount: Amount; txnId: string };

// Posts one timeline step's balanced legs inside a store transaction, so the same call works on
// memory and on the SQL engines, which require post_entry to run in a transaction. The clock time
// at posting becomes a top-up lot's top-up time.
function postStep(store: Store, step: Step): Promise<unknown> {
  let userPart =
    step.kind === 'topUp'
      ? creditLeg(spendable(step.userId), step.amount)
      : debit(spendable(step.userId), step.amount);
  let systemPart =
    step.kind === 'topUp'
      ? debit(SYSTEM.REVENUE, step.amount)
      : creditLeg(SYSTEM.REVENUE, step.amount);
  let meta =
    step.kind === 'topUp'
      ? { kind: 'topUp', source: step.source }
      : { kind: 'spend' };
  return store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: step.txnId,
      legs: [systemPart, userPart],
      meta,
    }),
  );
}

// One differential scenario. It names the store and clock to drive, the user to act as, the
// maturity options, the seeded RNG, how many postings to emit, and the spend bias that shapes
// the timeline. These are bundled into one object to keep runDifferential under the
// param-count limit.
type Scenario = {
  store: Store;
  clock: Clock & { advance: (ms: number) => number };
  userId: string;
  options: MaturityOptions;
  rand: () => number;
  postings: number;
  // A low bias keeps top-ups dominant, which is accumulate-heavy with a long open tail. A high
  // bias drives the balance down toward zero between top-ups, which is consume-heavy with a short
  // tail that the FIFO drain repeatedly splits mid-lot.
  spendBias: number;
};

// Drives one user through a long randomized timeline of mixed-source top-ups and interleaved
// partial spends, then asserts that the bounded reads equal the full-scan oracle at several
// `now` cuts:
//   - maturedBalance equals maturedBalanceFullScan (the total), and
//   - maturedAtLeast(x) equals (oracle >= x) for several thresholds x (the early-terminating gate).
async function runDifferential(scenario: Scenario): Promise<void> {
  const { store, clock, userId, options, rand, postings, spendBias } = scenario;
  // Mixed funding sources span a 0-wait ('instant'), a 1-day ('crypto'), and a 7-day ('card')
  // horizon, plus an unrecognized one ('wire') that falls back to the default 7-day wait.
  const sources = ['instant', 'crypto', 'card', 'wire'];
  const account = spendable(userId);
  let posted = 0n;
  let seq = 0;

  for (let i = 0; i < postings; i += 1) {
    // Advance 0..3 days between postings, including 0 so several lots can share a top-up time.
    clock.advance(Math.floor(rand() * 4) * DAY);
    seq += 1;
    const txnId = `txn_${userId}_${seq}`;
    if (posted === 0n || rand() >= spendBias) {
      const cents = BigInt(1 + Math.floor(rand() * 5000));
      const source = sources[Math.floor(rand() * sources.length)]!;
      await postStep(store, {
        kind: 'topUp',
        userId,
        amount: toAmount('CREDIT', cents),
        source,
        txnId,
      });
      posted += cents;
    } else {
      // Spend a slice of the live balance, often most of it so the FIFO drain splits a lot
      // mid-way, but never more, because a user account can't go negative.
      const spend = BigInt(1 + Math.floor(rand() * Number(posted)));
      await postStep(store, {
        kind: 'spend',
        userId,
        amount: toAmount('CREDIT', spend),
        txnId,
      });
      posted -= spend;
    }
  }

  for (const now of [
    0,
    1 * DAY,
    3 * DAY,
    7 * DAY,
    30 * DAY,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const bounded = await maturedBalance(store.ledger, account, now, options);
    const oracle = await maturedBalanceFullScan(
      store.ledger,
      account,
      now,
      options,
    );
    assert.deepEqual(
      bounded,
      oracle,
      `${userId} now ${now}: bounded ${bounded.minor} != oracle ${oracle.minor}`,
    );

    // maturedAtLeast(x) must equal (oracle >= x) for every threshold: at, just under, and just over
    // the matured total, plus the boundaries (0, the whole live balance, and beyond it).
    const live = await store.ledger.balance(account);
    const thresholds = [
      0n,
      1n,
      oracle.minor,
      oracle.minor + 1n,
      oracle.minor > 0n ? oracle.minor - 1n : 0n,
      live.minor,
      live.minor + 1n,
    ];
    for (const x of thresholds) {
      const atLeast = await maturedAtLeast(store.ledger, account, now, {
        ...options,
        amount: toAmount('CREDIT', x),
      });
      assert.equal(
        atLeast,
        oracle.minor >= x,
        `${userId} now ${now}: maturedAtLeast(${x}) ${atLeast} != (oracle ${oracle.minor} >= ${x})`,
      );
    }
  }
}

describe('maturity bounded reads vs full-scan oracle', () => {
  // The bounded newest-first reads must be byte-identical to the original full-history scan for
  // every input. Those reads are maturedBalance (the total) and maturedAtLeast (the
  // early-terminating threshold gate that requestPayout and spend use), and the original scan is
  // kept as maturedBalanceFullScan. Each backend runs through thousands of postings with mixed
  // funding sources and horizons (0, 1-day, 7-day) and interleaved partial spends, in both an
  // accumulate-heavy and a consume-heavy shape, and the test asserts exact agreement at several
  // `now` cuts. Memory always runs; postgres and mysql run when reachable and skip otherwise.
  // Agreement at every cut means the optimization changed cost, not results.
  const backends: DiffBackend[] = ['memory', 'postgres', 'mysql'];

  for (const backend of backends) {
    describe(backend, () => {
      let store: Store | null = null;
      // Each store is built around its own advancing clock. Hold a reference so the timeline
      // driver can advance it. memoryStore, postgresStore, and mysqlStore copy the clock
      // reference, so advancing this same object moves the time the ledger stamps onto each
      // posting.
      let clock: Clock & { advance: (ms: number) => number };

      before(async () => {
        clock = fixedClock(0);
        try {
          store =
            backend === 'memory'
              ? memoryStore({ clock, digest: seededDigest(1) })
              : backend === 'postgres'
                ? await postgresDiffStore(clock)
                : await mysqlDiffStore(clock);
        } catch {
          store = null;
        }
      });
      after(async () => {
        if (store) {
          await store.close();
        }
      });

      const config: Config = {
        ...testConfig(),
        maturityHorizonMs: {
          instant: 0,
          crypto: 1 * DAY,
          card: 7 * DAY,
          default: 7 * DAY,
        },
      };
      const options: MaturityOptions = { config };

      test('accumulate-heavy timeline (long open tail) agrees exactly', async (t) => {
        if (!store) {
          t.skip(`${backend} unreachable`);
          return;
        }
        await runDifferential({
          store,
          clock,
          userId: 'usr_accum',
          options,
          rand: lcg(0xacc01),
          postings: 2000,
          spendBias: 0.25,
        });
      });

      test('consume-heavy timeline (short, frequently-drained tail) agrees exactly', async (t) => {
        if (!store) {
          t.skip(`${backend} unreachable`);
          return;
        }
        await runDifferential({
          store,
          clock,
          userId: 'usr_consume',
          options,
          rand: lcg(0xc05e),
          postings: 2000,
          spendBias: 0.7,
        });
      });
    });
  }
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
