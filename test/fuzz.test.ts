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
 * The cross-backend differential, one test per case. `npm run fuzz` is the `fuzz` step of
 * `scripts/check.ts`, which runs this file; it signalled by exit code until it moved here, so
 * nothing counted its cases.
 *
 * For each seed, builds one fixed operation sequence and replays it against every reachable adapter
 * (memory, postgres, mysql, http) on its own fresh isolated store. Memory is the reference; every
 * other adapter must finish with the same per-account balance, the same hash-chain head per account,
 * and the same integrity report. A mismatch fails as `adapter <X> diverged from memory at <detail>`.
 * An adapter whose database is unreachable is skipped (logged, not failed).
 *
 * Every adapter must hash the same way for the comparison to be valid, so each store comes from
 * `adapterMatrix()` wired with the same seeded hash function and fixed clock. The chain hash is
 * computed inside the store, so identical sequences produce identical hashes, heads, and balances on
 * every backend.
 *
 * The SQL adapters run few seeds and a short sequence, because each operation is a round trip to a
 * real database. The cheap memory adapter carries the long deep loop. The four adversarial cases
 * below run through the same comparison.
 *
 * Fully fixed (no randomness), so the run is reproducible on Node, Bun, and Deno.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for what
 * the integrity report each adapter must reproduce actually asserts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import '#test/support/dist-guard.ts';

import { makeEconomy, seededStore } from '#test/support/economy.ts';
import {
  topUp,
  grantPromo,
  spend,
  credit as creditAmount,
} from '#test/support/builders.ts';
import { adapterMatrix } from '#test/support/adapters.ts';
import { seededProgram } from '#test/support/seeded-program.ts';
import { recutLeg } from '#test/support/tamper.ts';
import {
  fixedRates,
  seededDigest,
  seededSigner,
} from '#test/support/capabilities.ts';
import { proveEconomy } from '#src/integrity.ts';
import { spendable, promo } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';

import type { Economy, Operation, ProveReport } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { Store } from '#src/ports.ts';

// Seeds the economy's hash function, fixed at 1 for every adapter and case. Each store in the matrix
// is also built with seededDigest(1), and the chain hash is computed inside the store. The economy
// and the store must share a seed for the economy's reported hashes to match the store's recorded
// ones. With the seed fixed, a seed value produces the same operation sequence on every adapter.
const ECONOMY_SEED = 1;

// What the thorough prover needs, built from the same seeded values `makeEconomy` wires into every
// economy in this file — a prover holding a different digest reports a broken chain on correct
// data. The store is the only part that changes per adapter.
const PROVE_DEPS = {
  rates: fixedRates(),
  digest: seededDigest(ECONOMY_SEED),
  signer: seededSigner(ECONOMY_SEED),
};

// This is the one capture of process.env. The adapter matrix resolves its database URLs from it.
const env = process.env;

// Throws with the given message when the condition is false. The runner catches it and reports the
// message as the reason a case diverged.
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// --- The differential core --------------------------------------------------------------

// One adapter's end state after replaying a sequence. It holds each touched account's balance as a
// stable encoded string, each account's latest hash-chain entry, the integrity report, and the step
// index plus error code of any throw. Two adapters fed the same sequence must produce equal
// snapshots, errors included, with memory as the reference. Recording the error instead of aborting
// lets a case whose operation is meant to throw, such as recipient shares that add up wrong, be
// compared itself: every adapter must throw the same code at the same step and leave the same
// balances.
type Snapshot = {
  balances: Map<AccountRef, string>;

  // Each account's latest hash-chain entry, its "head", as raw hex. A bug that posts the same lines
  // in the wrong order leaves balances equal yet head hashes different. The balance map alone would
  // miss that bug; this map catches it.
  heads: Map<AccountRef, string>;

  // The thorough prover's report, not `read.health()`'s. The light one answers `chainIntact` by
  // testing each head's shape, which is a function of the head map above — so comparing it across
  // backends could never say anything the head loop had not already said. The replay opens every
  // link, which is the one difference this comparison can see on its own.
  report: ProveReport;

  fault: { at: number; code: string } | null;
};

// Replays one sequence against a single store and captures its end state. The store is built fresh
// and isolated by `adapterMatrix()`, wired with the shared seeded hash function and fixed clock. The
// economy is built over it with the matching seed. The store always closes, even on throw, so a
// thrown error cannot leak a database connection or throwaway schema.
async function replay(
  store: Store,
  operations: ReadonlyArray<Operation>,
): Promise<Snapshot> {
  const economy = makeEconomy(ECONOMY_SEED, store);
  try {
    let fault: { at: number; code: string } | null = null;
    for (let i = 0; i < operations.length; i += 1) {
      // A 'rejected' outcome moved no money, and the final-state comparison captures it. An
      // operation that fails outright throws instead. Catch the first throw, record its step and
      // code, and stop submitting. The throw is then compared across adapters by code, step, and
      // leftover balances, rather than aborting the run.
      try {
        await economy.submit(operations[i]!);
      } catch (error) {
        fault = { at: i, code: (error as { code?: string }).code ?? 'UNKNOWN' };
        break;
      }
    }
    return await snapshot(economy, store, fault);
  } finally {
    await economy.close();
  }
}

// Reads the end state out of a running economy. It returns the balance of every account the ledger
// has a head for, which is every account any posting touched, plus each account's head, the
// integrity report, and any error the replay caught.
async function snapshot(
  economy: Economy,
  store: Store,
  fault: { at: number; code: string } | null,
): Promise<Snapshot> {
  const balances = new Map<AccountRef, string>();
  const heads = new Map<AccountRef, string>();
  for await (const [account, head] of store.ledger.heads()) {
    balances.set(account, encodeAmount(await economy.read.balance(account)));
    heads.set(account, head);
  }
  const report = await proveEconomy({ store, ...PROVE_DEPS });
  return { balances, heads, report, fault };
}

// Compares a candidate snapshot against the memory reference. Returns the first difference as a
// readable detail, or null when the two are byte-for-byte equal. The account set, the per-account
// balances, the per-account head hashes, and every integrity-report flag must all match. The
// shortfall amount, which is how much USD backing is missing, must match too.
function diverge(reference: Snapshot, candidate: Snapshot): string | null {
  const accounts = new Set<AccountRef>([
    ...reference.balances.keys(),
    ...candidate.balances.keys(),
  ]);
  for (const account of accounts) {
    const want = reference.balances.get(account) ?? '<absent>';
    const got = candidate.balances.get(account) ?? '<absent>';
    if (want !== got) {
      return `balance[${account}] memory=${want} adapter=${got}`;
    }
  }

  // Every account's head hash must match memory's byte for byte. This catches wrong-order posting
  // bugs that leave balances equal. The detail is worded so the caller's `adapter <X> diverged from
  // memory at <detail>` reads as `adapter <X> head diverged at <account>`.
  const headAccounts = new Set<AccountRef>([
    ...reference.heads.keys(),
    ...candidate.heads.keys(),
  ]);
  for (const account of headAccounts) {
    const want = reference.heads.get(account) ?? '<absent>';
    const got = candidate.heads.get(account) ?? '<absent>';
    if (want !== got) {
      return `head diverged at ${account} (memory=${want} adapter=${got})`;
    }
  }

  // Four of these five are re-derived from legs the loops above have already agreed on, so they
  // are a cheap second reading rather than a second question. `chainIntact` is the one that asks
  // something new: the prover re-hashes every stored link, so an engine whose legs no longer
  // produce the head it wrote diverges here having matched every head and every balance. That
  // state is what `test/support/tamper.ts` `recutLeg` builds, and the case at the end of this file
  // drives it through this function.
  const want = reference.report;
  const got = candidate.report;
  for (const flag of [
    'conserved',
    'backed',
    'noOverdraft',
    'chainIntact',
    'consistent',
  ] as const) {
    if (want[flag] !== got[flag]) {
      return `prove.${flag} memory=${want[flag]} adapter=${got[flag]}`;
    }
  }
  if (encodeAmount(want.shortfall) !== encodeAmount(got.shortfall)) {
    return `prove.shortfall memory=${encodeAmount(want.shortfall)} adapter=${encodeAmount(got.shortfall)}`;
  }

  const wantFault = reference.fault
    ? `${reference.fault.code}@${reference.fault.at}`
    : '<none>';
  const gotFault = candidate.fault
    ? `${candidate.fault.code}@${candidate.fault.at}`
    : '<none>';
  if (wantFault !== gotFault) {
    return `fault memory=${wantFault} adapter=${gotFault}`;
  }
  return null;
}

// Outcome of running one case across the matrix. It records which adapters took part, meaning memory
// plus every reachable backend, and which were skipped because their backend was down.
type CaseResult = { compared: string[]; skipped: string[] };

// Adapters whose skip reason has already been printed, so a 16-case run says it once each.
const announcedSkips = new Set<string>();

/**
 * Runs one sequence against a set of matrix adapters and asserts they all agree.
 *
 * Memory is the reference and is always available. For each other adapter, this tries to build a
 * fresh store. If that throws, the backend is unreachable, so the adapter is skipped: recorded, not
 * failed. A reachable adapter whose end state differs from memory's throws `adapter <X> diverged
 * from memory at <detail>`, which the caller reports before exiting non-zero.
 *
 * `include` selects which adapter names take part, and memory is always forced in. This keeps the
 * real-database operation count small. Deep seeds pass an `include` naming only the no-database
 * adapters (memory and http), so the SQL databases run only on the short bounded seeds.
 */
async function runDifferential(
  label: string,
  operations: ReadonlyArray<Operation>,
  include: ReadonlySet<string>,
): Promise<CaseResult> {
  const matrix = adapterMatrix(env).filter(
    (adapter) => adapter.name === 'memory' || include.has(adapter.name),
  );
  let reference: Snapshot | null = null;
  const compared: string[] = [];
  const skipped: string[] = [];

  for (const adapter of matrix) {
    let store: Store;
    try {
      store = await adapter.makeStore();
    } catch (error) {
      // memory must never be unreachable. If it is, that is a real failure, not a skip.
      if (adapter.name === 'memory') {
        throw new Error(`memory store failed to build for "${label}"`);
      }
      // This warning says why the skip happened, once per adapter. "Database down" and
      // "reachable but wrong schema version" both land here. The second is a coverage loss a
      // silent skip would disguise as the first.
      if (!announcedSkips.has(adapter.name)) {
        announcedSkips.add(adapter.name);
        console.warn(
          `fuzz: SKIP ${adapter.name} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      skipped.push(adapter.name);
      continue;
    }

    const result = await replay(store, operations);
    if (adapter.name === 'memory') {
      reference = result;
      compared.push(adapter.name);
      continue;
    }

    check(
      reference !== null,
      'memory reference must run before any other adapter',
    );
    const detail = diverge(reference!, result);
    check(
      detail === null,
      `adapter ${adapter.name} diverged from memory at ${detail} [${label}]`,
    );
    compared.push(adapter.name);
  }

  return { compared, skipped };
}

// --- Adversarial fixtures (preserved, run through the differential) ---------------------

// The four adversarial cases. Each is a fixed operation sequence rather than an assertion against a
// single in-memory economy. Each sequence is replayed across the whole matrix, and comparing every
// reachable adapter against memory covers what the old single-backend assertions did. The builders
// generate fresh idempotency keys at module load, identically on every adapter, so a sequence is the
// same on every backend.
function adversarialFixtures(): Array<{
  name: string;
  operations: Operation[];
}> {
  const duplicatePurchase = spend({
    buyerId: 'usr_d',
    sku: 'wrld_pass',
    price: creditAmount('4.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });

  return [
    {
      // Submitting the same purchase twice charges the buyer once. The first commits, and the
      // second returns as a duplicate without taking more money. Every adapter must agree on the single
      // resulting balance.
      name: 'double-submit is exactly-once',
      operations: [
        topUp({ userId: 'usr_d', amount: creditAmount('10.00') }),
        duplicatePurchase,
        duplicatePurchase,
      ],
    },
    {
      // Over-spend is an ordinary returned rejection that moves no money. Every adapter must end
      // with the buyer's balance untouched.
      name: 'over-spend is a returned rejection',
      operations: [
        topUp({ userId: 'usr_o', amount: creditAmount('3.00') }),
        spend({
          buyerId: 'usr_o',
          sku: 'wrld_pass',
          price: creditAmount('4.00'),
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
        }),
      ],
    },
    {
      // Recipient shares summing past 100% are malformed input the economy throws on, before
      // recording the key or posting anything. The thrown fault propagates identically on every
      // adapter (replay re-throws), and no money moves.
      name: 'shares over 10000 is a thrown fault',
      operations: [
        topUp({ userId: 'usr_s', amount: creditAmount('20.00') }),
        spend({
          buyerId: 'usr_s',
          sku: 'wrld_bundle',
          price: creditAmount('12.00'),
          recipients: [
            { sellerId: 'usr_a', shareBps: 7_000 },
            { sellerId: 'usr_b', shareBps: 4_000 },
          ],
        }),
      ],
    },
    {
      // A spend covered by promo credit draws the promo balance down before the user's spendable
      // credit, and the platform's promo accounting still balances afterward. It posts two
      // debit/credit lines to one account, and it runs across the full matrix.
      name: 'promo spend conserves the float',
      operations: [
        topUp({ userId: 'usr_pr', amount: creditAmount('2.00') }),
        grantPromo({
          userId: 'usr_pr',
          amount: creditAmount('5.00'),
          expiresAt: 1,
        }),
        spend({
          buyerId: 'usr_pr',
          sku: 'wrld_pass',
          price: creditAmount('4.00'),
          recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
        }),
      ],
    },
  ];
}

// Checks the promo fixture's exact balances on the memory reference. The cross-adapter comparison
// cannot catch a change that broke spend ordering the same way on every adapter at once. Pinning the
// expected numbers here does catch it. Runs after the adapter comparison.
async function assertReferenceBalances(): Promise<void> {
  const promoEconomy = makeEconomy(ECONOMY_SEED);
  await promoEconomy.submit(
    topUp({ userId: 'usr_pr', amount: creditAmount('2.00') }),
  );
  await promoEconomy.submit(
    grantPromo({
      userId: 'usr_pr',
      amount: creditAmount('5.00'),
      expiresAt: 1,
    }),
  );
  await promoEconomy.submit(
    spend({
      buyerId: 'usr_pr',
      sku: 'wrld_pass',
      price: creditAmount('4.00'),
      recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    }),
  );
  check(
    encodeAmount(await promoEconomy.read.balance(promo('usr_pr'))) ===
      'CREDIT:1.00',
    'promo should be drawn before spendable',
  );
  check(
    encodeAmount(await promoEconomy.read.balance(spendable('usr_pr'))) ===
      'CREDIT:2.00',
    'spendable should be untouched while promo covers the price',
  );
  await promoEconomy.close();
}

// --- The cases, as tests ------------------------------------------------------------------

/**
 * One differential case. The SQL legs of a bounded case are three fresh isolated stores and
 * sixteen round trips each; the deep cases have no database in them at all. The bound is per test,
 * so a wedged engine names its case instead of taking the file's 600s backstop with it.
 */
const CASE_BOUND_MS = 120_000;

/**
 * The full matrix runs the small bounded cases. The no-database set of memory plus http, both
 * always available, carries the long deep loop, which keeps the real-database operation count
 * small. (`runDifferential` always forces memory in, so naming only http here still compares
 * memory against http.)
 */
const fullMatrix = new Set(adapterMatrix(env).map((adapter) => adapter.name));
const inProcess = new Set(['http']);

/** Memory carries the deep loop; the SQL backends run the first few seeds on a short sequence. */
const DEEP_SEEDS = Array.from({ length: 12 }, (_, i) => 0xf00 + i);
const DEEP_LENGTH = 80;
const SQL_SEEDS = 3;
const SQL_LENGTH = 16;

const fixtures = adversarialFixtures();

// Every adapter that any case actually compared against memory, filled in as the cases run and
// asserted at the end. A run where every backend was skipped compares memory against http and
// nothing else, and that is a coverage loss the per-case tests cannot see.
const comparedAdapters = new Set<string>();

test('the differential declares the matrix and the cases it will run', () => {
  // A matrix or a fixture list that resolved to nothing would leave the tests below undeclared
  // and the file green having compared nothing.
  assert.deepEqual(
    [...fullMatrix],
    ['memory', 'postgres', 'mysql', 'http'],
    'the adapter matrix is not the four this differential is written against',
  );
  assert.equal(fixtures.length, 4, 'the adversarial fixture roster moved');
  assert.equal(DEEP_SEEDS.length, 12);
});

for (const fixture of fixtures) {
  test(
    `fixture ${fixture.name}: every reachable adapter agrees with memory`,
    { timeout: CASE_BOUND_MS },
    async () => {
      const result = await runDifferential(
        `fixture: ${fixture.name}`,
        fixture.operations,
        fullMatrix,
      );
      for (const name of result.compared) comparedAdapters.add(name);
      assert.ok(
        result.compared.includes('memory'),
        'the reference adapter did not run, so nothing was compared',
      );
    },
  );
}

test('the promo fixture draws promo before spendable, at the pinned amounts', async () => {
  await assertReferenceBalances();
});

for (let i = 0; i < DEEP_SEEDS.length; i += 1) {
  const seed = DEEP_SEEDS[i]!;
  const bounded = i < SQL_SEEDS;
  const length = bounded ? SQL_LENGTH : DEEP_LENGTH;
  // The bounded seeds run the whole matrix on a short sequence with promos, so memory and the SQL
  // engines compare on the full set of operation kinds — promo-draw spends included. The rest run
  // memory against http on a long sequence, where there are no round trips to pay for.
  const include = bounded ? fullMatrix : inProcess;
  test(
    `seed 0x${seed.toString(16)} (${bounded ? 'sql-bounded' : 'deep'}): every reachable adapter agrees with memory`,
    { timeout: CASE_BOUND_MS },
    async () => {
      const result = await runDifferential(
        `seed 0x${seed.toString(16)}`,
        seededProgram(seed, length, {
          prefix: 'f',
          service: 'fuzz',
          promo: true,
        }),
        include,
      );
      for (const name of result.compared) comparedAdapters.add(name);
      assert.ok(
        result.compared.includes('memory'),
        'the reference adapter did not run, so nothing was compared',
      );
    },
  );
}

/**
 * The comparison is handed five flags after every head has been compared byte for byte and every
 * balance before that. Four of the five re-read what those loops settled — and `chainIntact` was
 * the fifth until this landing, because the light prover answers it by testing each head's shape,
 * which is a function of the head map itself. `prove.chainIntact memory=… adapter=…` was a line
 * that could not print.
 *
 * The state only a replay sees is an engine whose stored legs no longer hash to the head it wrote:
 * the same heads, the same balances, and a chain that does not re-derive. Both sides here are the
 * memory adapter, because what is under test is the comparison and not any backend, and
 * `test/support/tamper.ts` `recutLeg` is the one edit that builds that state.
 */
test('the report comparison catches a re-cut leg that the head and balance loops both pass', async () => {
  const operations = [
    topUp({ userId: 'usr_recut', amount: creditAmount('20.00') }),
    topUp({ userId: 'usr_recut', amount: creditAmount('30.00') }),
  ];
  const referenceStore = seededStore(ECONOMY_SEED);
  const candidateStore = seededStore(ECONOMY_SEED);
  const reference = makeEconomy(ECONOMY_SEED, referenceStore);
  const candidate = makeEconomy(ECONOMY_SEED, candidateStore);
  try {
    let edited: string | null = null;
    for (const operation of operations) {
      const mirrored = await reference.submit(operation);
      const outcome = await candidate.submit(operation);
      assert.equal(mirrored.status, 'committed');
      assert.equal(outcome.status, 'committed');
      // The older of the two postings, so the edit lands behind the wallet's newest link.
      if (edited === null && outcome.status === 'committed') {
        edited = outcome.transaction.id;
      }
    }
    assert.notEqual(
      edited,
      null,
      'nothing committed, so nothing can be edited',
    );

    // The positive control. Without it the detail below is satisfiable by two economies that never
    // agreed in the first place.
    const before = await snapshot(reference, referenceStore, null);
    assert.equal(
      diverge(before, await snapshot(candidate, candidateStore, null)),
      null,
    );

    recutLeg(
      candidateStore.ledger as MemoryLedger,
      edited!,
      spendable('usr_recut'),
    );

    // That the detail is the flag and not `head diverged at …` or `balance[…]` is the whole
    // finding: both of those loops run first and return on the first difference, so reaching this
    // one means they each passed the edited ledger.
    assert.equal(
      diverge(before, await snapshot(candidate, candidateStore, null)),
      'prove.chainIntact memory=true adapter=false',
    );
  } finally {
    await reference.close();
    await candidate.close();
  }
});

// Declared last so every case above has run. `node:test` runs a file's top-level tests in
// declaration order, which is what lets this read what they filled in.
test('the run says which adapters it actually compared, not which it declared', () => {
  const compared = [...comparedAdapters].sort();
  assert.ok(
    compared.length > 1,
    `memory was compared against nothing (${compared.join(', ') || 'no adapter ran'})`,
  );
  assert.ok(
    compared.includes('http'),
    'http needs no database and must always be compared',
  );
});
