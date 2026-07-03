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

// Harness that records transactions into one in-memory ledger and lets a test break it in ways
// normal code can't.
//
// `digest` is the store's chaining hash function; the prover must get the same one so it re-hashes
// the exact bytes the store wrote.
//
// `post` records through validation. `appendRaw` skips validation and writes straight to the
// ledger, planting a broken transaction the real handlers would reject. `tamper` edits a stored
// transaction's lines in place without updating its hash (attacker editing the DB directly).
//
// `seedBalance` plants a cached per-account balance row with no posting behind it, so it has no
// hash-chain entry. A direct DB edit or a half-applied write could leave such a phantom or stale row.
// Balances are a cache, and the debit and credit lines are the source of truth, but this row has no
// lines. `heads()` only walks accounts with a posting, so it never visits this row. Only
// `balanceAccounts()` lists every cached balance row, so only it reaches the row. The prover catches
// the row by comparing it against a derived balance of zero.
type Recorder = {
  store: Store;
  digest: Digest;
  post: (legs: Leg[], meta?: Record<string, unknown>) => Promise<void>;
  appendRaw: (legs: Leg[], meta?: Record<string, unknown>) => Promise<void>;
  tamper: (txnId: string, mutate: (legs: Leg[]) => void) => void;
  seedBalance: (account: AccountRef, amount: Amount) => void;
};

// The prover's context: exchange rates plus the recorder's hash function. Reusing the recorder's
// hash function is what lets the prover's re-hash match the hashes the store already wrote.
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

// A user buying credits, as a real top-up does: two linked transactions. The first hands the user
// spendable credits; the second brings in the USD that backs them (the cash held so the user can
// cash out). Test rates are 1:1, so credits owed and dollars held rise by the same amount.
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
    // Move 12.00 out of the buyer, split between two sellers (7.00 and 5.00). The balance check
    // sums every account's lines, not one running total, so it must hold when a single transaction
    // touches more than two accounts.
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
    // Buyer gets 4.00 then spends all 4.00, so its stored balance ends at 0. The balance check
    // should still sum the two lines (+4.00 in, -4.00 out) to 0 on its own, confirming it sums
    // recorded transactions rather than reading the stored balance.
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
    // Write straight to the ledger to skip the debits-equal-credits check: 5.00 leaves the buyer
    // but only 3.00 reaches the seller.
    await rec.appendRaw([
      debit(spendable('usr_buyer'), credit('5.00')),
      creditLeg(earned('usr_seller'), credit('3.00')),
    ]);

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, false);
  });

  test('flags an overdrawn user account as an overdraft', async () => {
    const rec = recorder();
    // Write straight to the ledger to skip the no-negative-balance check: take 5.00 out of a buyer
    // who has nothing, with the platform's revenue account as the matching side.
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
    // Hand the buyer 8.00 spendable credits but skip the step that brings in the backing USD. At
    // the $0.005 par rate, 8.00 credits (800 minor) need floor(800 × $0.005) = $0.04 of backing,
    // and none is held, so the platform is $0.04 short.
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
    // Give a seller 20.00 of earnings with no USD held. The backing check only counts credits a
    // user can spend or cash out now; earned balances (like promo grants and pending-payout
    // reserves) aren't in that group, so the book is still fully backed.
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
// Each account caches a running balance the store reads in constant time. That cache should equal
// the sum of the account's debit and credit lines. `consistent` is true only when no account's
// cache has drifted from its line sum. `__tamper` edits a stored posting's lines but never updates
// the cache, so after a tamper the two disagree. The second kind of drift is a cached balance row
// with no posting behind it, a phantom or stale row. The prover finds those rows by listing every
// cached balance row via `balanceAccounts()` and comparing each against a derived balance of zero.

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
    // Edit the buyer's leg downward after it committed. The cached (materialized) balance was
    // written at commit and left untouched, so it still reads 10.00 while the lines now sum to
    // 3.00. The cache has drifted from the lines, which are the source of truth.
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
    // Plant a cached balance into the store's balance table with no posting behind it, the way a
    // direct DB edit or half-applied write could leave a row in `account_balances` that no line
    // supports. `heads()` only visits accounts with a posting, so this row is reachable only via
    // `balanceAccounts()`; with no lines behind it the prover derives 0, and the non-zero stored
    // figure no longer matches. That is drift.
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
    // Nudge txn_1's two legs by equal and opposite amounts. Materialized balances stay at their
    // committed values, but each account's legs now sum to a different figure, so both accounts
    // drift. The nudges cancel, so per-currency conservation still folds to zero, showing the
    // drift check isn't just re-reading the conservation total.
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
// Each stored transaction carries a hash over the previous one plus its own contents, a
// tamper-evident chain. `chainIntact` re-derives every hash from the first transaction onward using
// the same hashing the store used. Rebuilding the hashes (rather than glancing at the latest) is
// what catches a transaction edited after it was written.

describe('proveEconomy Chain Verification', () => {
  test('recomputes every account chain and reports a clean book intact', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    // Spend too, so a few accounts have more than one transaction and the recompute walks real
    // chains, not single entries.
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
    // Change an amount on a stored transaction but leave its saved hash untouched. The prover's
    // re-hash no longer matches the saved hash, which is how it spots the edit.
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = { account: legs[1]!.account, amount: credit('999.00') };
    });

    const report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, false);
  });

  test('a tampered line fails the chain check while the books still balance', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    // Edit both lines by the smallest step, one up and one down, so the transaction still cancels
    // to zero and the balance check passes. Any edit changes the hashed bytes, so the chain check
    // fails, showing it re-hashes stored transactions rather than rereading account balances.
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

// Copy of an amount with its minor unit shifted by `delta` (positive or negative). Even a one-unit
// change alters the hashed bytes, breaking the chain; shifting two sides by equal and opposite
// amounts breaks the chain while keeping the transaction balanced.
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
