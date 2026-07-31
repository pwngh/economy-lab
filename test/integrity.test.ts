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
import { makeEconomy } from '#test/support/economy.ts';
import { recutLeg } from '#test/support/tamper.ts';
import { credit, usd } from '#test/support/builders.ts';
import { toAmount, zero } from '#src/money.ts';

import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Amount } from '#src/money.ts';
import type { ProveReport } from '#src/contract.ts';
import type { Digest, Leg, Posting, StoredLink, Store } from '#src/ports.ts';

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

// Re-cuts the REVENUE debit of a recorded topUp. The construction and why it breaks the chain
// and nothing else live in `recutLeg`; test/prove.test.ts breaks its book the same way.
function recutHouseLeg(rec: Recorder, txnId: string): void {
  recutLeg(rec.store.ledger as MemoryLedger, txnId, SYSTEM.REVENUE);
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

// The five properties the roll-up folds, as a roster this file owns. The last test holds it
// against the booleans a live report carries, so a sixth property added to ProveReport lands
// here as a decision rather than as a silently unfolded flag.
const CONJUNCTS = [
  'conserved',
  'backed',
  'noOverdraft',
  'chainIntact',
  'consistent',
] as const;

type Conjunct = (typeof CONJUNCTS)[number];

const ALL_HOLD: Record<Conjunct, boolean> = {
  conserved: true,
  backed: true,
  noOverdraft: true,
  chainIntact: true,
  consistent: true,
};

// Every boolean-valued key a report carries, sorted. `flagsOf` projects a fixed five, so a sixth
// flag on either prover is invisible to it; this is what keeps that projection honest.
function booleanKeys(report: ProveReport): string[] {
  return Object.entries(report)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([name]) => name)
    .sort();
}

function flagsOf(report: ProveReport): Record<Conjunct, boolean> {
  return {
    conserved: report.conserved,
    backed: report.backed,
    noOverdraft: report.noOverdraft,
    chainIntact: report.chainIntact,
    consistent: report.consistent,
  };
}

// One book per property, each broken so that exactly that property fails and the other four
// still hold. The expected verdict below is written as a literal from ALL_HOLD; it is never
// re-derived from the roll-up, because a roll-up compared to a copy of its own body passes
// however many conjuncts are deleted from it.
const BREAKS: ReadonlyArray<{
  property: Conjunct;
  book: string;
  build: (rec: Recorder) => Promise<void>;
}> = [
  {
    property: 'conserved',
    book: 'a posting whose debit and credit lines do not cancel',
    // Both accounts are house accounts, so nothing here is custodial, no wallet can go
    // negative, and the raw sums miss zero by 2.00 credits.
    build: (rec) =>
      rec.appendRaw([
        debit(SYSTEM.STORED_VALUE, credit('5.00')),
        creditLeg(SYSTEM.REVENUE, credit('3.00')),
      ]),
  },
  {
    property: 'backed',
    book: 'credits handed to a user with no USD brought in behind them',
    // At the $0.005 par rate 8.00 credits need $0.04 of trust cash, and none was posted.
    build: (rec) =>
      rec.post([
        debit(SYSTEM.REVENUE, credit('8.00')),
        creditLeg(spendable('usr_buyer'), credit('8.00')),
      ]),
  },
  {
    property: 'noOverdraft',
    book: 'a wallet spent below zero',
    // Raw, so the ledger's own overdraft guard never sees it. The pair still cancels, and a
    // negative custodial balance lowers the backing requirement rather than raising it.
    build: (rec) =>
      rec.appendRaw([
        debit(spendable('usr_buyer'), credit('5.00')),
        creditLeg(SYSTEM.REVENUE, credit('5.00')),
      ]),
  },
  {
    property: 'chainIntact',
    book: 'a stored posting whose lines were re-cut after it was recorded',
    // One house leg split into two that add to the same figure: every balance, every derived
    // sum and the conservation total are untouched, and only the link preimage differs.
    build: async (rec) => {
      await topUp(rec, 'usr_buyer', '300.00');
      recutHouseLeg(rec, 'txn_1');
    },
  },
  {
    property: 'consistent',
    book: 'a cached balance row with no posting behind it',
    // An earned account, so it is outside the backing requirement and its positive balance is
    // no overdraft; it has no chain and no legs, so conservation and the chain never see it.
    build: async (rec) => {
      await topUp(rec, 'usr_buyer', '300.00');
      rec.seedBalance(earned('usr_ghost'), credit('5.00'));
    },
  },
];

describe('The All-Checks Roll-Up', () => {
  // The positive control. Without it "every conjunct fires" is satisfiable by an auditor that
  // reports nothing holding.
  test('a healthy book reports all five properties holding', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '300.00');

    const report = await proveEconomy(ctx(rec));

    assert.deepEqual(flagsOf(report), ALL_HOLD);
    assert.equal(allInvariantsHold(report), true);
  });

  for (const broken of BREAKS) {
    test(`${broken.book} fails ${broken.property} alone, and the roll-up with it`, async () => {
      const rec = recorder();
      await broken.build(rec);

      const report = await proveEconomy(ctx(rec));

      assert.deepEqual(flagsOf(report), {
        ...ALL_HOLD,
        [broken.property]: false,
      });
      assert.equal(
        allInvariantsHold(report),
        false,
        `${broken.property} is not folded into allInvariantsHold`,
      );
    });
  }

  test('every boolean the report carries is one of the five, and each has a book', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '300.00');

    const report = await proveEconomy(ctx(rec));

    const carried = booleanKeys(report);
    assert.deepEqual(carried, [...CONJUNCTS].sort());
    assert.deepEqual(BREAKS.map((row) => row.property).sort(), carried);
    assert.equal(BREAKS.length, 5);
  });
});

// --- The two provers, on one book --------------------------------------------------

// `read.health()` and `proveEconomy` derive four of the five flags the same way. The fifth is not:
// the full prover re-hashes every link, while `read.health()` only checks that each account's
// latest head is 64 lowercase hex characters. The book below is the smallest one that tells them
// apart, so the boundary between them is gated rather than described in a comment that goes stale.
// `test/support/harness.ts` `proveGate` prints a verdict off the light prover, and this is the
// difference its label has to name.
describe('read.health Against proveEconomy', () => {
  // One account's chain as the store holds it, oldest first. Read before an edit, it is the
  // independent source for what the prover's break has to name.
  async function linksOf(
    rec: Recorder,
    account: AccountRef,
  ): Promise<StoredLink[]> {
    const links: StoredLink[] = [];
    for await (const link of rec.store.ledger.lineage(account)) {
      links.push(link);
    }
    return links;
  }

  // Every key a ChainBreak carries, so one added to it arrives here as a decision rather than as
  // a field nothing below pins.
  const BREAK_KEYS = ['account', 'actual', 'expected', 'reason', 'txnId'];

  // The economy reads the same store the recorder wrote, under the same seeded digest.
  const lightProver = (rec: Recorder): Promise<ProveReport> =>
    makeEconomy(1, rec.store).read.health();

  test('both provers carry the same five booleans', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '300.00');

    const full = await proveEconomy(ctx(rec));
    const light = await lightProver(rec);

    assert.deepEqual(booleanKeys(full), [...CONJUNCTS].sort());
    assert.deepEqual(booleanKeys(light), [...CONJUNCTS].sort());
  });

  // The positive control. Without it the differential below is satisfiable by a light prover that
  // reports a broken chain on every book. A healthy book must also name NO link, which is what
  // stops the field being satisfiable by a prover that always points somewhere.
  test('a healthy book reports all five holding on both provers, and names no link', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '300.00');
    await topUp(rec, 'usr_buyer', '300.00');

    const full = await proveEconomy(ctx(rec));
    const light = await lightProver(rec);

    assert.deepEqual(flagsOf(full), ALL_HOLD);
    assert.deepEqual(flagsOf(light), ALL_HOLD);
    assert.equal(full.firstBreak, null);
    assert.equal(light.firstBreak, null);
  });

  test('an edit behind an account head is caught by the full prover alone', async () => {
    const rec = recorder();
    await topUp(rec, 'usr_buyer', '300.00');
    await topUp(rec, 'usr_buyer', '300.00');
    // Two links, and the one about to be edited is the older. With a single link the edit would
    // land on the head and the two provers would part for a different reason than this test names.
    const links = await linksOf(rec, SYSTEM.REVENUE);
    assert.deepEqual(
      links.map((link) => link.txnId),
      ['txn_1', 'txn_3'],
    );

    recutHouseLeg(rec, 'txn_1');

    const full = await proveEconomy(ctx(rec));
    const light = await lightProver(rec);

    assert.deepEqual(flagsOf(full), { ...ALL_HOLD, chainIntact: false });
    // Not an oversight being pinned as correct: `read.health()` is the cheap read, and its
    // `chainIntact` is the one flag that answers a weaker question than the same-named flag on the
    // full prover. Anything printing this report has to say so.
    assert.deepEqual(flagsOf(light), ALL_HOLD);

    // Each report names the prover that filled it, so a copy of it in an audit trail, a trace or a
    // bench artifact carries the answer to "which chainIntact is this?" with it.
    assert.deepEqual(
      [full.prover, light.prover],
      ['proveEconomy', 'read.health'],
    );

    // The light prover opens no link, so it has none to name however its `chainIntact` reads.
    // That is the half of the differential the type states and this asserts on a live report.
    assert.equal(light.firstBreak, null);

    // The roll-up `test/support/harness.ts` `proveGate` prints. Running the audit is what makes a
    // green gate mean the chain was replayed; the light read passes this book.
    assert.equal(allInvariantsHold(full), false);
    assert.equal(allInvariantsHold(light), true);
  });

  // Which link the report names has to follow the edit. A `firstBreak` wired to the chain's
  // oldest link, or to its newest, passes one row here and fails the other — so the pair is what
  // makes this an assertion about the named link rather than about a name being present.
  for (const at of [0, 1] as const) {
    test(`the report names the ${at === 0 ? 'older' : 'newer'} link when that is the one edited`, async () => {
      const rec = recorder();
      await topUp(rec, 'usr_buyer', '300.00');
      await topUp(rec, 'usr_buyer', '300.00');
      const links = await linksOf(rec, SYSTEM.REVENUE);
      assert.deepEqual(
        links.map((link) => link.txnId),
        ['txn_1', 'txn_3'],
      );
      const edited = links[at]!;

      recutHouseLeg(rec, edited.txnId);
      const report = await proveEconomy(ctx(rec));
      const broken = report.firstBreak;

      // The chain broke and nothing else, so the break below is this edit's and not a second
      // property's wreckage.
      assert.deepEqual(flagsOf(report), { ...ALL_HOLD, chainIntact: false });
      if (broken === null) {
        assert.fail('the chain broke and the report named no link');
      }
      assert.deepEqual(Object.keys(broken).sort(), BREAK_KEYS);
      assert.deepEqual(
        {
          account: broken.account,
          txnId: broken.txnId,
          reason: broken.reason,
          actual: broken.actual,
        },
        {
          account: SYSTEM.REVENUE,
          txnId: edited.txnId,
          reason: 'tampered-hash',
          actual: edited.hash,
        },
        'the named link is not the one the edit landed on',
      );
      // The recomputed hash is the one figure no literal can pin: it is the hash of content that
      // did not exist until the edit. What it must not be is the hash the store still holds,
      // because that is the whole disagreement.
      assert.match(broken.expected, /^[0-9a-f]{64}$/);
      assert.notEqual(broken.expected, edited.hash);
    });
  }
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
