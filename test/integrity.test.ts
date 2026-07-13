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

import { allInvariantsHold, proveEconomy } from '#src/integrity.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import { fixedRates, seededDigest } from '#test/support/capabilities.ts';
import { credit, usd } from '#test/support/builders.ts';
import { zero } from '#src/money.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { Digest, Leg, Posting, Store } from '#src/ports.ts';

// --- Fixtures ---------------------------------------------------------------------

// Harness that lets a test break the book in ways normal code can't: `post` records through
// validation; `appendRaw` skips it; `tamper` edits stored lines without updating the hash;
// `seedBalance` plants a cached balance row with no posting behind it. The prover must reuse
// `digest` so its re-hash matches the bytes the store wrote.
type Recorder = {
  store: Store;
  digest: Digest;
  post: (legs: Leg[], meta?: Record<string, unknown>) => Promise<void>;
  appendRaw: (legs: Leg[], meta?: Record<string, unknown>) => Promise<void>;
  tamper: (txnId: string, mutate: (legs: Leg[]) => void) => void;
  seedBalance: (account: AccountRef, amount: Amount) => void;
};

function ctx(rec: Recorder): {
  rates: ReturnType<typeof fixedRates>;
  digest: Digest;
} {
  return { rates: fixedRates(), digest: rec.digest };
}

function recorder(): Recorder {
  const digest = seededDigest(1);
  const store = memoryStore({ digest });
  let id = 0;

  async function record(
    legs: Leg[],
    meta: Record<string, unknown>,
    via: 'post' | 'raw',
  ): Promise<void> {
    id += 1;
    const posting: Posting = { txnId: `txn_${id}`, legs, meta };
    if (via === 'post') {
      await postEntry(store.ledger, posting);
    } else {
      await store.ledger.append(posting);
    }
  }

  return {
    store,
    digest,
    post: (legs, meta = {}) => record(legs, meta, 'post'),
    appendRaw: (legs, meta = {}) => record(legs, meta, 'raw'),
    tamper: (txnId, mutate) =>
      (store.ledger as MemoryLedger).__tamper(txnId, mutate),
    seedBalance: (account, amount) =>
      (store.ledger as MemoryLedger).__seedBalance(account, amount),
  };
}

// A real top-up's two linked transactions: the credits handed out, then the USD that backs them.
async function topUp(
  rec: Recorder,
  userId: string,
  dollars: string,
): Promise<void> {
  const amount = credit(dollars);
  const cash = usd(dollars);
  await rec.post(
    [debit(SYSTEM.REVENUE, amount), creditLeg(spendable(userId), amount)],
    {
      kind: 'topUp',
    },
  );
  await rec.post(
    [debit(SYSTEM.TRUST_CASH, cash), creditLeg(SYSTEM.USD_CLEARING, cash)],
    {
      kind: 'topUp.cash',
    },
  );
}

// --- proveEconomy: the healthy book ------------------------------------------------

describe('proveEconomy', () => {
  test('reports every invariant holding on a fresh empty economy', async () => {
    const rec = recorder();

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(allInvariantsHold(report), true);
    assert.deepEqual(report.shortfall, zero('USD'));
  });

  test('reports conserved, backed, and no overdraft after a topUp', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00');

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
    assert.equal(report.noOverdraft, true);
    assert.deepEqual(report.shortfall, usd('0.00'));
  });

  test('conserves per currency across an N-way credit distribution', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '12.00');
    await rec.post([
      debit(spendable('usr_buyer'), credit('12.00')),
      creditLeg(earned('usr_a'), credit('7.00')),
      creditLeg(earned('usr_b'), credit('5.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });

  test('sums the debit and credit lines, not just the stored balance', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '4.00');
    await rec.post([
      debit(spendable('usr_buyer'), credit('4.00')),
      creditLeg(earned('usr_seller'), credit('4.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, true);
  });
});

// --- proveEconomy: the broken book -------------------------------------------------

describe('proveEconomy On A Broken Book', () => {
  test('flags an unbalanced posting as not conserved', async () => {
    const rec = recorder();
    await rec.appendRaw([
      debit(spendable('usr_buyer'), credit('5.00')),
      creditLeg(earned('usr_seller'), credit('3.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, false);
  });

  test('flags an overdrawn user account as an overdraft', async () => {
    const rec = recorder();
    await rec.appendRaw([
      debit(spendable('usr_buyer'), credit('5.00')),
      creditLeg(SYSTEM.REVENUE, credit('5.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.noOverdraft, false);
    assert.equal(report.conserved, true); // the debit and credit still cancel, so the books balance
  });

  test('reports the USD shortfall when credits owed to users lack backing', async () => {
    const rec = recorder();
    // No backing USD is brought in: at the $0.005 par rate, 8.00 credits need $0.04, so the book
    // is exactly $0.04 short.
    await rec.post([
      debit(SYSTEM.REVENUE, credit('8.00')),
      creditLeg(spendable('usr_buyer'), credit('8.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.backed, false);
    assert.deepEqual(report.shortfall, usd('0.04'));
    assert.equal(report.conserved, true);
  });

  test('excludes earned, promo, and payout reserve from the backing requirement', async () => {
    const rec = recorder();
    await rec.post([
      debit(SYSTEM.REVENUE, credit('20.00')),
      creditLeg(earned('usr_seller'), credit('20.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.backed, true);
    assert.deepEqual(report.shortfall, usd('0.00'));
  });
});

// --- consistent / drift -----------------------------------------------------------

describe('proveEconomy Drift Detection', () => {
  test('reports consistent with empty drift on a clean book', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00');

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, true);
    assert.deepEqual(report.drift, []);
    assert.equal(allInvariantsHold(report), true);
  });

  test('flags an account whose stored balance drifted from its debit and credit lines', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00'); // txn_1 credits the buyer's spendable
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = creditLeg(spendable('usr_buyer'), credit('3.00'));
    });

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, false);
    const drifted = report.drift.find(
      (row) => row.account === spendable('usr_buyer'),
    );
    assert.ok(drifted, 'the buyer account is listed in drift');
    assert.deepEqual(drifted!.materialized, credit('10.00'));
    assert.deepEqual(drifted!.derived, credit('3.00'));
    assert.equal(allInvariantsHold(report), false);
  });

  test('flags a stored balance row with no posting behind it', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00');
    const phantom = earned('usr_ghost');
    rec.seedBalance(phantom, credit('5.00'));

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, false);
    const drifted = report.drift.find((row) => row.account === phantom);
    assert.ok(drifted, 'the phantom account is listed in drift');
    assert.deepEqual(drifted!.materialized, credit('5.00'));
    assert.deepEqual(drifted!.derived, credit('0.00')); // legs say it should not exist
    assert.equal(allInvariantsHold(report), false);
  });

  test('detects drift independently of conservation', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[0] = {
        account: legs[0]!.account,
        amount: nudge(legs[0]!.amount, 1n),
      };
      legs[1] = {
        account: legs[1]!.account,
        amount: nudge(legs[1]!.amount, -1n),
      };
    });

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, false);
    assert.equal(report.conserved, true);
    assert.ok(report.drift.length >= 1, 'at least one account drifted');
  });
});

// --- chainIntact ------------------------------------------------------------------

describe('proveEconomy Chain Verification', () => {
  test('recomputes every account chain and reports a clean book intact', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    // A second posting so the recompute walks real chains, not single entries.
    await rec.post([
      debit(spendable('usr_buyer'), credit('6.00')),
      creditLeg(earned('usr_seller'), credit('6.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, true);
  });

  test('detects a tampered line on a committed posting', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00'); // txn_1 hands out the credits, txn_2 brings in the USD
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = { account: legs[1]!.account, amount: credit('999.00') };
    });

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, false);
  });

  test('a tampered line fails the chain check while the books still balance', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[0] = {
        account: legs[0]!.account,
        amount: nudge(legs[0]!.amount, 1n),
      };
      legs[1] = {
        account: legs[1]!.account,
        amount: nudge(legs[1]!.amount, -1n),
      };
    });

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, false);
    assert.equal(report.conserved, true); // the two edits cancel, so the books still balance
  });
});

// Shifting two legs by equal and opposite amounts breaks the hash chain while keeping the posting
// balanced.
function nudge(amount: Amount, delta: bigint): Amount {
  return { ...amount, minor: amount.minor + delta };
}

// --- The all-checks roll-up --------------------------------------------------------

describe('The All-Checks Roll-Up', () => {
  test('allInvariantsHold is true exactly when every report field is', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '3.00');

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(
      allInvariantsHold(report),
      report.conserved &&
        report.backed &&
        report.noOverdraft &&
        report.chainIntact &&
        report.consistent,
    );
  });
});
