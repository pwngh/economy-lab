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
  testMysqlUrl,
  testPostgresUrl,
} from '#test/support/adapters.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Config } from '#src/config.ts';
import { toAmount } from '#src/money.ts';
import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Clock, Ledger, Lot, Store } from '#src/ports.ts';

const DAY = 24 * 60 * 60_000;

// Distinct waits per source, so a test can tell which one was applied.
function horizonConfig(): Config {
  return {
    ...testConfig(),
    maturityHorizonMs: { card: 7 * DAY, crypto: 1 * DAY, default: 7 * DAY },
  };
}

// One posted lot: the source in the meta picks the maturity wait, and the posting time becomes
// the lot's top-up time.
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

// A spend creates no lot; the maturity code reads the balance drop as FIFO consumption of the
// oldest lots.
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

    // The in-memory ledger stores a missing source as the literal 'unknown', which has no
    // config entry, so the lookup falls back to the default.
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
    // Spend 4.00 exactly drains the crypto lot.
    await spendSpendable(store.ledger, 'usr_a', credit('4.00'));
    const options: MaturityOptions = { config: horizonConfig() };

    // At day 3 the crypto lot would have matured, but the spend already consumed it; the
    // remaining card lot doesn't mature until day 9, so nothing is matured yet.
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

// Memory always runs; postgres/mysql run when reachable and skip otherwise — the conformance
// suites' connect-or-skip pattern.
type DiffBackend = 'memory' | 'postgres' | 'mysql';

function postgresDiffStore(clock: Clock): Promise<Store> {
  return makeIsolatedPostgresStore({
    url: testPostgresUrl(process.env),
    digest: seededDigest(1),
    clock,
  });
}

async function mysqlDiffStore(clock: Clock): Promise<Store> {
  const url = testMysqlUrl(process.env);
  if (url === null) {
    throw new Error('no MySQL URL configured');
  }
  return makeIsolatedMysqlStore({ url, digest: seededDigest(1), clock });
}

type Step =
  | {
      kind: 'topUp';
      userId: string;
      amount: Amount;
      source: string;
      txnId: string;
    }
  | { kind: 'spend'; userId: string; amount: Amount; txnId: string };

// Wrapped in store.transaction because the SQL engines require post_entry to run inside one.
function postStep(store: Store, step: Step): Promise<unknown> {
  const userPart =
    step.kind === 'topUp'
      ? creditLeg(spendable(step.userId), step.amount)
      : debit(spendable(step.userId), step.amount);
  const systemPart =
    step.kind === 'topUp'
      ? debit(SYSTEM.REVENUE, step.amount)
      : creditLeg(SYSTEM.REVENUE, step.amount);
  const meta =
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

type Scenario = {
  store: Store;
  clock: Clock & { advance: (ms: number) => number };
  userId: string;
  options: MaturityOptions;
  rand: () => number;
  postings: number;
  // Low bias: accumulate-heavy, long open tail. High bias: consume-heavy, a short tail the FIFO
  // drain keeps splitting mid-lot.
  spendBias: number;
};

// Random timeline, then: bounded maturedBalance must equal the full-scan oracle, and
// maturedAtLeast(x) must equal (oracle >= x), at several `now` cuts.
async function runDifferential(scenario: Scenario): Promise<void> {
  const { store, clock, userId, options, rand, postings, spendBias } = scenario;
  // 'wire' is unrecognized on purpose, exercising the default-wait fallback.
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
      // Never spend more than the live balance — a user account can't go negative.
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
  // maturedBalanceFullScan is kept as the oracle: the bounded reads must agree with it exactly on
  // every input — the optimization changed cost, not results.
  const backends: DiffBackend[] = ['memory', 'postgres', 'mysql'];

  for (const backend of backends) {
    describe(backend, () => {
      let store: Store | null = null;
      // The stores hold this clock by reference, so advancing it moves the time the ledger stamps
      // on each posting.
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
