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

// A small harness that records transactions into one in-memory ledger and lets a test
// break that ledger in ways normal code never could.
//
// `digest` is the hashing function the store uses to chain its entries; the prover must be
// given this same one so it re-hashes the exact same bytes the store hashed when it wrote.
//
// `post` records a transaction the normal way, through validation. `appendRaw` skips
// validation and writes straight to the ledger, so a test can plant a broken transaction the
// real handlers would have rejected. `tamper` edits an already-stored transaction's lines in
// place without updating its hash, mimicking an attacker who edits the database directly.
//
// `seedBalance` plants a cached per-account balance row directly, with no posting behind it (and
// so no entry in that account's hash chain) — a phantom or stale row a direct DB edit or a
// half-applied write could leave behind. The store keeps each account's running balance as a
// cache; the recorded debit and credit lines are the real source of truth, and this row has none.
// `heads()` (which walks accounts that have at least one posting) never visits it; only
// `balanceAccounts()` (which lists every cached balance row) does. That is the case the prover has
// to catch by comparing such a row against a derived balance of zero.
type Recorder = {
  store: Store;
  digest: Digest;
  post: (legs: Leg[], meta?: Record<string, unknown>) => Promise<void>;
  appendRaw: (legs: Leg[], meta?: Record<string, unknown>) => Promise<void>;
  tamper: (txnId: string, mutate: (legs: Leg[]) => void) => void;
  seedBalance: (account: AccountRef, amount: Amount) => void;
};

// Builds the bundle the prover needs: the exchange rates plus the recorder's own hashing
// function. Reusing the recorder's hashing function is what lets the prover's re-hash match
// the hashes the store already wrote.
function ctx(rec: Recorder): {
  rates: ReturnType<typeof fixedRates>;
  digest: Digest;
} {
  return { rates: fixedRates(), digest: rec.digest };
}

function recorder(): Recorder {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });
  let id = 0;

  async function record(
    legs: Leg[],
    meta: Record<string, unknown>,
    via: 'post' | 'raw',
  ): Promise<void> {
    id += 1;
    let posting: Posting = { txnId: `txn_${id}`, legs, meta };
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

// Records a user buying credits, the way a real top-up does: two linked transactions.
// The first hands the user spendable credits. The second brings in the real USD that backs
// those credits — the cash the platform must hold so the user can later cash out. The test
// rates are 1:1 (one credit is worth one dollar), so the two amounts match: the credits the
// platform owes the user and the dollars it holds against them rise by the same amount.
async function topUp(
  rec: Recorder,
  userId: string,
  dollars: string,
): Promise<void> {
  let amount = credit(dollars);
  let cash = usd(dollars);
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
    let rec = recorder();

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(allInvariantsHold(report), true);
    assert.deepEqual(report.shortfall, zero('USD'));
  });

  test('reports conserved, backed, and no overdraft after a topUp', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00');

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
    assert.equal(report.noOverdraft, true);
    assert.deepEqual(report.shortfall, usd('0.00'));
  });

  test('conserves per currency across an N-way credit distribution', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '12.00');
    // Move 12.00 out of the buyer and split it between two sellers (7.00 and 5.00). The
    // balance check adds up every account's lines, not just one running total, so it must
    // still come out even when a single transaction touches more than two accounts.
    await rec.post([
      debit(spendable('usr_buyer'), credit('12.00')),
      creditLeg(earned('usr_a'), credit('7.00')),
      creditLeg(earned('usr_b'), credit('5.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });

  test('sums the debit and credit lines, not just the stored balance', async () => {
    let rec = recorder();
    // The buyer gets 4.00, then spends all 4.00, so its stored balance ends at 0. The balance
    // check should still add up the two transaction lines (a +4.00 in, a -4.00 out) and get 0
    // on its own — confirming it sums the recorded transactions rather than just reading the
    // account's stored balance.
    await topUp(rec, 'usr_buyer', '4.00');
    await rec.post([
      debit(spendable('usr_buyer'), credit('4.00')),
      creditLeg(earned('usr_seller'), credit('4.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, true);
  });
});

// --- proveEconomy: the broken book -------------------------------------------------

describe('proveEconomy On A Broken Book', () => {
  test('flags an unbalanced posting as not conserved', async () => {
    let rec = recorder();
    // Write straight to the ledger so we skip the check that a transaction's debits and
    // credits cancel out: here 5.00 leaves the buyer but only 3.00 reaches the seller.
    await rec.appendRaw([
      debit(spendable('usr_buyer'), credit('5.00')),
      creditLeg(earned('usr_seller'), credit('3.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.conserved, false);
  });

  test('flags an overdrawn user account as an overdraft', async () => {
    let rec = recorder();
    // Write straight to the ledger so we skip the check that stops a user's balance going
    // negative: take 5.00 out of a buyer who has nothing, with the platform's revenue account
    // as the matching side.
    await rec.appendRaw([
      debit(spendable('usr_buyer'), credit('5.00')),
      creditLeg(SYSTEM.REVENUE, credit('5.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.noOverdraft, false);
    assert.equal(report.conserved, true); // the debit and credit still cancel, so the books balance
  });

  test('reports the USD shortfall when credits owed to users lack backing', async () => {
    let rec = recorder();
    // Hand the buyer 8.00 of spendable credits but skip the matching step that brings in the
    // real USD to back them. Now the platform owes more than the cash it holds: at the $0.005 par
    // rate, 8.00 credits (800 minor) must be backed by floor(800 × $0.005) = $0.04, and none is
    // held, so the platform is $0.04 short of covering what users could cash out.
    await rec.post([
      debit(SYSTEM.REVENUE, credit('8.00')),
      creditLeg(spendable('usr_buyer'), credit('8.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.backed, false);
    assert.deepEqual(report.shortfall, usd('0.04'));
    assert.equal(report.conserved, true);
  });

  test('excludes earned, promo, and payout reserve from the backing requirement', async () => {
    let rec = recorder();
    // Give a seller 20.00 of earnings with no USD held against them. The backing check only
    // counts credits a user can spend or cash out right now; a seller's earned balance (like
    // promo grants and amounts set aside for a pending payout) is not in that group, so the
    // book is still considered fully backed.
    await rec.post([
      debit(SYSTEM.REVENUE, credit('20.00')),
      creditLeg(earned('usr_seller'), credit('20.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.backed, true);
    assert.deepEqual(report.shortfall, usd('0.00'));
  });
});

// --- consistent / drift -----------------------------------------------------------
// Each account keeps a running balance the store can read in constant time (it does not get slower
// as the ledger grows). That cached balance is meant to equal the balance you would get by adding
// up the account's individual debit and credit lines. `consistent` is true only when no account's
// cached figure has drifted from what its lines sum to. `__tamper` edits a stored posting's lines
// in place but never updates the cached balance, so after a tamper the two disagree — exactly the
// drift this check is meant to surface. There is a second way to drift: a cached balance row with
// NO posting behind it at all (a phantom or stale row). The prover finds those by listing every
// cached balance row via `balanceAccounts()` and comparing each against a derived balance of zero.

describe('proveEconomy Drift Detection', () => {
  test('reports consistent with empty drift on a clean book', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00');

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, true);
    assert.deepEqual(report.drift, []);
    assert.equal(allInvariantsHold(report), true);
  });

  test('flags an account whose stored balance drifted from its debit and credit lines', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00'); // txn_1 credits the buyer's spendable
    // Edit the buyer's leg downward AFTER it committed. The cached running balance the store keeps
    // for the account (its "materialized" balance) was written at commit and is left untouched, so
    // it still reads 10.00 while the account's debit and credit lines now sum to 3.00 — the cached
    // figure has drifted from the lines, which are the real source of truth.
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = creditLeg(spendable('usr_buyer'), credit('3.00'));
    });

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, false);
    let drifted = report.drift.find(
      (row) => row.account === spendable('usr_buyer'),
    );
    assert.ok(drifted, 'the buyer account is listed in drift');
    assert.deepEqual(drifted!.materialized, credit('10.00'));
    assert.deepEqual(drifted!.derived, credit('3.00'));
    assert.equal(allInvariantsHold(report), false);
  });

  test('flags a stored balance row with no posting behind it', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '10.00');
    // Plant a cached balance straight into the store's balance table with no posting behind it,
    // the way a direct DB edit or a half-applied write could leave a row in `account_balances`
    // that no debit or credit line supports. `heads()` only visits accounts that have a posting,
    // so this row is reachable only via `balanceAccounts()`; with no lines behind it the prover
    // derives its balance as 0, and the non-zero stored figure no longer matches — that is drift.
    let phantom = earned('usr_ghost');
    rec.seedBalance(phantom, credit('5.00'));

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, false);
    let drifted = report.drift.find((row) => row.account === phantom);
    assert.ok(drifted, 'the phantom account is listed in drift');
    assert.deepEqual(drifted!.materialized, credit('5.00'));
    assert.deepEqual(drifted!.derived, credit('0.00')); // legs say it should not exist
    assert.equal(allInvariantsHold(report), false);
  });

  test('detects drift independently of conservation', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    // Nudge the two legs of txn_1 by equal and opposite amounts. Both legs' materialized balances
    // stay at their committed values, but each account's legs now sum to a different figure, so
    // both accounts drift. The two nudges cancel, so per-currency conservation still folds to
    // zero — proving the drift check is not just re-reading the conservation total.
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

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.consistent, false);
    assert.equal(report.conserved, true);
    assert.ok(report.drift.length >= 1, 'at least one account drifted');
  });
});

// --- chainIntact ------------------------------------------------------------------
// Each stored transaction carries a hash computed from the one before it plus its own
// contents, forming a tamper-evident chain. The `chainIntact` result comes from re-deriving
// every one of those hashes from the very first transaction onward, using the same hashing
// the store used. Because it rebuilds the hashes rather than just glancing at the latest one,
// it notices when a transaction's contents were edited after it was written.

describe('proveEconomy Chain Verification', () => {
  test('recomputes every account chain and reports a clean book intact', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    // Spend as well, so a few accounts have more than one transaction in their history and the
    // recompute has real chains to walk, not just single entries.
    await rec.post([
      debit(spendable('usr_buyer'), credit('6.00')),
      creditLeg(earned('usr_seller'), credit('6.00')),
    ]);

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, true);
  });

  test('detects a tampered line on a committed posting', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00'); // txn_1 hands out the credits, txn_2 brings in the USD
    // Change an amount on an already-stored transaction but leave its saved hash untouched.
    // When the prover re-hashes the edited transaction, the result no longer matches the saved
    // hash, which is how it spots the edit.
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = { account: legs[1]!.account, amount: credit('999.00') };
    });

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, false);
  });

  test('a tampered line fails the chain check while the books still balance', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '6.00');
    // Edit both lines by the smallest step, one up and one down, so the transaction still
    // cancels to zero and the balance check stays happy. But any edit changes the bytes that
    // were hashed, so the chain check fails — showing it really re-hashes the stored
    // transactions rather than just rereading account balances.
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

    let report = await proveEconomy(rec.store, ctx(rec));

    assert.equal(report.chainIntact, false);
    assert.equal(report.conserved, true); // the two edits cancel, so the books still balance
  });
});

// Returns a copy of an amount with its smallest unit (the integer count of cents-equivalent
// units) shifted by `delta`, which may be positive or negative. Even a one-unit change alters
// the bytes that get hashed, so it breaks the chain; a test can shift two sides by equal and
// opposite amounts to break the chain while keeping the transaction balanced.
function nudge(amount: Amount, delta: bigint): Amount {
  return { ...amount, minor: amount.minor + delta };
}

// --- The all-checks roll-up --------------------------------------------------------

describe('The All-Checks Roll-Up', () => {
  test('allInvariantsHold is true exactly when every report field is', async () => {
    let rec = recorder();
    await topUp(rec, 'usr_buyer', '3.00');

    let report = await proveEconomy(rec.store, ctx(rec));

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
