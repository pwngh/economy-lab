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

import { allInvariantsHold, findByHash, proveEconomy } from '#src/integrity.ts';
import { GENESIS_HEX } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { credit as creditLeg, debit, postEntry } from '#src/ledger.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import { fixedRates, seededDigest } from '#test/support/capabilities.ts';
import { credit, usd } from '#test/support/builders.ts';
import { toAmount, zero } from '#src/money.ts';

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
  store: Store;
  rates: ReturnType<typeof fixedRates>;
  digest: Digest;
} {
  return { store: rec.store, rates: fixedRates(), digest: rec.digest };
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

// A real top-up's two linked transactions: the credits handed out, then the USD that backs them
// at the file's $0.01-per-credit buy rate (credit minor / 100 = USD minor).
async function topUp(
  rec: Recorder,
  userId: string,
  credits: string,
): Promise<void> {
  const amount = credit(credits);
  // Whole credits only: the division below would silently floor a fractional purchase's backing.
  assert.equal(amount.minor % 100n, 0n);
  const cash = toAmount('USD', amount.minor / 100n);
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

    const report = await proveEconomy(ctx(rec));

    assert.equal(allInvariantsHold(report), true);
    assert.deepEqual(report.shortfall, zero('USD'));
  });

  test('reports conserved, backed, and no overdraft after a topUp', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '1000.00');

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
    assert.equal(report.noOverdraft, true);
    assert.deepEqual(report.shortfall, usd('0.00'));
  });

  test('conserves per currency across an N-way credit distribution', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '1200.00');
    await rec.post([
      debit(spendable('usr_buyer'), credit('1200.00')),
      creditLeg(earned('usr_a'), credit('700.00')),
      creditLeg(earned('usr_b'), credit('500.00')),
    ]);

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });

  test('sums the debit and credit lines, not just the stored balance', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '400.00');
    await rec.post([
      debit(spendable('usr_buyer'), credit('400.00')),
      creditLeg(earned('usr_seller'), credit('400.00')),
    ]);

    const report = await proveEconomy(ctx(rec));

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

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.conserved, false);
  });

  test('flags an overdrawn user account as an overdraft', async () => {
    const rec = recorder();
    await rec.appendRaw([
      debit(spendable('usr_buyer'), credit('5.00')),
      creditLeg(SYSTEM.REVENUE, credit('5.00')),
    ]);

    const report = await proveEconomy(ctx(rec));

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

    const report = await proveEconomy(ctx(rec));

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

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.backed, true);
    assert.deepEqual(report.shortfall, usd('0.00'));
  });
});

// --- consistent / drift -----------------------------------------------------------

describe('proveEconomy Drift Detection', () => {
  test('reports consistent with empty drift on a clean book', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '1000.00');

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.consistent, true);
    assert.deepEqual(report.drift, []);
    assert.equal(allInvariantsHold(report), true);
  });

  test('flags an account whose stored balance drifted from its debit and credit lines', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '1000.00'); // txn_1 credits the buyer's spendable
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = creditLeg(spendable('usr_buyer'), credit('300.00'));
    });

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.consistent, false);
    const drifted = report.drift.find(
      (row) => row.account === spendable('usr_buyer'),
    );
    assert.ok(drifted, 'the buyer account is listed in drift');
    assert.deepEqual(drifted!.materialized, credit('1000.00'));
    assert.deepEqual(drifted!.derived, credit('300.00'));
    assert.equal(allInvariantsHold(report), false);
  });

  test('flags a stored balance row with no posting behind it', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '1000.00');
    const phantom = earned('usr_ghost');
    rec.seedBalance(phantom, credit('5.00'));

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.consistent, false);
    const drifted = report.drift.find((row) => row.account === phantom);
    assert.ok(drifted, 'the phantom account is listed in drift');
    assert.deepEqual(drifted!.materialized, credit('5.00'));
    assert.deepEqual(drifted!.derived, credit('0.00')); // legs say it should not exist
    assert.equal(allInvariantsHold(report), false);
  });

  test('detects drift independently of conservation', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '600.00');
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

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.consistent, false);
    assert.equal(report.conserved, true);
    assert.ok(report.drift.length >= 1, 'at least one account drifted');
  });
});

// --- chainIntact ------------------------------------------------------------------

describe('proveEconomy Chain Verification', () => {
  test('recomputes every account chain and reports a clean book intact', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '600.00');
    // A second posting so the recompute walks real chains, not single entries.
    await rec.post([
      debit(spendable('usr_buyer'), credit('600.00')),
      creditLeg(earned('usr_seller'), credit('600.00')),
    ]);

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.chainIntact, true);
  });

  test('detects a tampered line on a committed posting', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '600.00'); // txn_1 hands out the credits, txn_2 brings in the USD
    rec.tamper('txn_1', (legs: Leg[]) => {
      legs[1] = { account: legs[1]!.account, amount: credit('999.00') };
    });

    const report = await proveEconomy(ctx(rec));

    assert.equal(report.chainIntact, false);
  });

  test('a tampered line fails the chain check while the books still balance', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '600.00');
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

    const report = await proveEconomy(ctx(rec));

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
    await topUp(rec, 'usr_buyer', '300.00');

    const report = await proveEconomy(ctx(rec));

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

// The forensic lookup over the public read surface: exact match, genesis excluded, scan bounded.
describe('findByHash', () => {
  function readOf(rec: Recorder) {
    return {
      accounts: () => rec.store.ledger.balanceAccounts(),
      lineage: (account: AccountRef) => rec.store.ledger.lineage(account),
    };
  }

  async function firstLink(rec: Recorder) {
    for await (const account of rec.store.ledger.balanceAccounts()) {
      for await (const link of rec.store.ledger.lineage(account)) {
        return { account, link };
      }
    }
    throw new Error('no links recorded');
  }

  test('locates the link carrying a hash, case-insensitively', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_find', '1000.00');
    const { link } = await firstLink(rec);

    const hit = await findByHash(readOf(rec), link.hash.toUpperCase());

    assert.notEqual(hit, null);
    assert.equal(hit!.link.hash, link.hash);
    assert.equal(hit!.field, 'hash');
  });

  test('a chained prevHash resolves via the prior link that carries it as hash', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_find', '1000.00');
    await topUp(rec, 'usr_find', '500.00');
    let second: string | null = null;
    for await (const link of rec.store.ledger.lineage(spendable('usr_find'))) {
      if (link.prevHash !== GENESIS_HEX) {
        second = link.prevHash;
        break;
      }
    }

    const hit = await findByHash(readOf(rec), second!);

    // A well-formed chain carries every non-genesis prevHash as the prior link's hash, and
    // lineage streams oldest-first, so the walk lands on the prior link.
    assert.notEqual(hit, null);
    assert.equal(hit!.field, 'hash');
    assert.equal(hit!.link.hash, second);
  });

  test('a dangling prevHash (no link carries it as hash) reports the prevHash field', async () => {
    const orphan: import('#src/ports.ts').StoredLink = {
      txnId: 'txn_orphan',
      legs: [],
      meta: {},
      prevHash: 'ab'.repeat(32),
      hash: 'cd'.repeat(32),
    };
    const read = {
      accounts: async function* () {
        yield 'usr_x:spendable' as AccountRef;
      },
      lineage: async function* () {
        yield orphan;
      },
    };

    const hit = await findByHash(read, 'AB'.repeat(32));

    assert.notEqual(hit, null);
    assert.equal(hit!.field, 'prevHash');
    assert.equal(hit!.link.txnId, 'txn_orphan');
  });

  test('the genesis prevHash never matches', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_find', '1000.00');

    assert.equal(await findByHash(readOf(rec), GENESIS_HEX), null);
  });

  test('an unknown hash misses, and scanMax bounds the walk', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_find', '1000.00');
    const { link } = await firstLink(rec);

    assert.equal(await findByHash(readOf(rec), 'f'.repeat(64)), null);
    // A one-link budget cannot reach anything beyond the first link scanned.
    assert.equal(
      await findByHash(readOf(rec), link.hash, { scanMax: 0 }),
      null,
    );
  });
});
