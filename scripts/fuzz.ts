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
 * CLI script: sets a process exit code (non-zero on first divergence, zero when every adapter
 * agrees).
 *
 * Checks the SQL storage adapters against the in-memory reference. For each seed, builds one fixed
 * operation sequence and replays it against every reachable adapter (memory, postgres, mysql, http)
 * on its own fresh isolated store. Memory is the reference; every other adapter must finish with the
 * same per-account balance, the same latest hash-chain entry ("head") per account, and the same
 * integrity report (`prove` re-derives balances from the entries and reports conserved, fully backed
 * by USD, never overdrawn, chains intact). A mismatch fails as `adapter <X> diverged from memory at
 * <detail>`. An adapter whose database is unreachable is skipped (logged, not failed).
 *
 * Every adapter must hash the same way for the comparison to be valid, so each store comes from
 * `adapterMatrix()` wired with the same seeded hash function and fixed clock. The chain hash is
 * computed inside the store, so identical sequences produce identical hashes, heads, and balances on
 * every backend.
 *
 * SQL adapters run few seeds and a short sequence (each op is a round trip to a real database); the
 * cheap memory adapter carries the long deep loop. The four adversarial cases below run through the
 * same comparison.
 *
 * Fully fixed (no randomness), so the run is reproducible on Node, Bun, and Deno.
 */

import process from 'node:process';

import { makeEconomy } from '#test/support/economy.ts';
import {
  topUp,
  grantPromo,
  spend,
  credit as creditAmount,
} from '#test/support/builders.ts';
import { adapterMatrix } from '#test/support/adapters.ts';
import { spendable, promo } from '#src/accounts.ts';
import { encodeAmount, decodeAmount } from '#src/money.ts';

import type { Economy, Operation, ProveReport } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Store } from '#src/ports.ts';

// Seeds the economy's hash function, fixed at 1 for every adapter and case. Each store in the matrix
// is also built with seededDigest(1), and the chain hash is computed inside the store, so they must
// share a seed for the economy's reported hashes to match the store's recorded ones. With that
// fixed, a seed produces the same operation sequence on every adapter.
const ECONOMY_SEED = 1;

// Throws with the given message when the condition is false. The runner catches it and reports the
// message as the reason a case diverged.
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// --- The differential core --------------------------------------------------------------

// One adapter's end state after replaying a sequence: each touched account's balance (stable encoded
// string), each account's latest hash-chain entry, the integrity report, and the step index plus
// error code of any throw. Two adapters fed the same sequence must produce equal snapshots, errors
// included; memory is the reference. Recording the error instead of aborting means a case whose
// operation is meant to throw (e.g. recipient shares that add up wrong) is itself compared: every
// adapter must throw the same code at the same step and leave the same balances.
type Snapshot = {
  balances: Map<AccountRef, string>;

  // Each account's latest hash-chain entry (its "head", most recent hash) as raw hex. The chain
  // makes after-the-fact tampering detectable. A bug that merged an account's debit/credit lines into
  // the right balance but linked them in the wrong order leaves balances equal yet head hashes
  // different; the balance map alone would miss it, this map catches it.
  heads: Map<AccountRef, string>;

  report: ProveReport;

  fault: { at: number; code: string } | null;
};

// Replay one sequence against a single store and capture its end state. The store is built fresh and
// isolated by `adapterMatrix()`, wired with the shared seeded hash function and fixed clock; the
// economy is built over it with the matching seed. Always closed, even on throw, so a thrown error
// can't leak a database connection or throwaway schema.
async function replay(
  store: Store,
  operations: ReadonlyArray<Operation>,
): Promise<Snapshot> {
  let economy = makeEconomy(ECONOMY_SEED, store);
  try {
    let fault: { at: number; code: string } | null = null;
    for (let i = 0; i < operations.length; i += 1) {
      // A 'rejected' outcome moved no money; the final-state comparison captures it. An operation
      // that fails outright throws instead; catch the first throw, record its step and code, and
      // stop submitting, so the throw is itself compared across adapters (same code, step, leftover
      // balances) rather than aborting the run.
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

// Read the end state out of a running economy: the balance of every account the ledger has a head
// for (every account any posting touched), each account's head, the integrity report, and any
// error the replay caught.
async function snapshot(
  economy: Economy,
  store: Store,
  fault: { at: number; code: string } | null,
): Promise<Snapshot> {
  let balances = new Map<AccountRef, string>();
  let heads = new Map<AccountRef, string>();
  for await (let [account, head] of store.ledger.heads()) {
    balances.set(account, encodeAmount(await economy.read.balance(account)));
    heads.set(account, head);
  }
  return { balances, heads, report: await economy.read.prove(), fault };
}

// Compare a candidate snapshot against the memory reference, returning the first difference as a
// readable detail or null when byte-for-byte equal. The account set, per-account balances,
// per-account head hashes, and every integrity-report flag (plus the shortfall amount, how much USD
// backing is missing) must all match.
function diverge(reference: Snapshot, candidate: Snapshot): string | null {
  let accounts = new Set<AccountRef>([
    ...reference.balances.keys(),
    ...candidate.balances.keys(),
  ]);
  for (let account of accounts) {
    let want = reference.balances.get(account) ?? '<absent>';
    let got = candidate.balances.get(account) ?? '<absent>';
    if (want !== got) {
      return `balance[${account}] memory=${want} adapter=${got}`;
    }
  }

  // Every account's head hash must match memory's byte for byte. A bug that merged an account's
  // debit/credit lines into the right balance but in a different order leaves balances equal while
  // shifting the head hash; only this comparison catches it. Detail worded so the caller's `adapter
  // <X> diverged from memory at <detail>` reads as `adapter <X> head diverged at <account>`.
  let headAccounts = new Set<AccountRef>([
    ...reference.heads.keys(),
    ...candidate.heads.keys(),
  ]);
  for (let account of headAccounts) {
    let want = reference.heads.get(account) ?? '<absent>';
    let got = candidate.heads.get(account) ?? '<absent>';
    if (want !== got) {
      return `head diverged at ${account} (memory=${want} adapter=${got})`;
    }
  }

  let want = reference.report;
  let got = candidate.report;
  for (let flag of [
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

  let wantFault = reference.fault
    ? `${reference.fault.code}@${reference.fault.at}`
    : '<none>';
  let gotFault = candidate.fault
    ? `${candidate.fault.code}@${candidate.fault.at}`
    : '<none>';
  if (wantFault !== gotFault) {
    return `fault memory=${wantFault} adapter=${gotFault}`;
  }
  return null;
}

// Outcome of running one case across the matrix: which adapters took part (memory plus every
// reachable backend) and which were skipped because their backend was down.
type CaseResult = { compared: string[]; skipped: string[] };

/**
 * Run one sequence against a set of matrix adapters and assert they all agree.
 *
 * Memory is the reference and always available. For each other adapter, try to build a fresh store;
 * if that throws, the backend is unreachable and the adapter is skipped (recorded, not failed). A
 * reachable adapter whose end state differs from memory's throws `adapter <X> diverged from memory
 * at <detail>`, which the caller reports before exiting non-zero.
 *
 * `include` selects which adapter names take part; memory is always forced in. Keeps the
 * real-database operation count small: deep seeds pass an `include` naming only the no-database
 * adapters (memory, http), so the SQL databases run only on the short bounded seeds.
 */
async function runDifferential(
  label: string,
  operations: ReadonlyArray<Operation>,
  include: ReadonlySet<string>,
): Promise<CaseResult> {
  let matrix = adapterMatrix().filter(
    (adapter) => adapter.name === 'memory' || include.has(adapter.name),
  );
  let reference: Snapshot | null = null;
  let compared: string[] = [];
  let skipped: string[] = [];

  for (let adapter of matrix) {
    let store: Store;
    try {
      store = await adapter.makeStore();
    } catch {
      // memory must never be unreachable; if it is, that is a real failure, not a skip.
      if (adapter.name === 'memory') {
        throw new Error(`memory store failed to build for "${label}"`);
      }
      skipped.push(adapter.name);
      continue;
    }

    let result = await replay(store, operations);
    if (adapter.name === 'memory') {
      reference = result;
      compared.push(adapter.name);
      continue;
    }

    check(
      reference !== null,
      'memory reference must run before any other adapter',
    );
    let detail = diverge(reference!, result);
    check(
      detail === null,
      `adapter ${adapter.name} diverged from memory at ${detail} [${label}]`,
    );
    compared.push(adapter.name);
  }

  return { compared, skipped };
}

// --- Seeded operation generator (bounded for SQL, deep for memory) ----------------------

// mulberry32 PRNG, identical to the one in scripts/prove.ts. Returns a function yielding the next
// number in [0, 1) each call. Fixed math, so a seed produces the same sequence on every JS runtime,
// which is what makes a seed the same op sequence on every adapter.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Running tally of one user's two spendable sources, in minor units (cents), so the generator only
// produces affordable spends, exercising the path where money moves rather than a declined spend.
type Wallet = { spendable: bigint; promo: bigint };

// Format a count of minor units (cents) as a two-decimal string like "12.34", the text form
// `decodeAmount` expects.
function dollars(minor: bigint): string {
  let whole = minor / 100n;
  let frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

function creditMinor(minor: bigint) {
  return decodeAmount(dollars(minor), 'CREDIT');
}

function walletOf(wallets: Map<string, Wallet>, userId: string): Wallet {
  let wallet = wallets.get(userId);
  if (!wallet) {
    wallet = { spendable: 0n, promo: 0n };
    wallets.set(userId, wallet);
  }
  return wallet;
}

// Build an affordable spend and subtract it from the local tally, promo first, matching the real
// spend handler (charges promo credit before spendable). Order matters: if the tally fell out of
// step with the handler, we'd start generating spends the user can't afford.
function spendOperation(
  next: () => number,
  step: number,
  userId: string,
  wallet: Wallet,
): Operation {
  let available = wallet.spendable + wallet.promo;
  let priceMinor =
    BigInt(1 + Math.floor(next() * Number(available / 100n))) * 100n;
  if (priceMinor > available) {
    priceMinor = available;
  }
  let fromPromo = wallet.promo < priceMinor ? wallet.promo : priceMinor;
  wallet.promo -= fromPromo;
  wallet.spendable -= priceMinor - fromPromo;
  return op('spend', step, {
    // Deterministic per-step order id. The SQL adapters record every sale in a `sales` table whose
    // `order_id` is non-null, so a generated spend must carry one (memory has no such table and would
    // mask the omission). Derived from the step to stay byte-identical per adapter.
    orderId: `ord_f_${step}`,
    buyerId: userId,
    sku: 'wrld_pass',
    price: creditMinor(priceMinor),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
}

// What a generated sequence may contain. `promo` stays a toggle because a promo-credit spend posts
// more than one debit/credit line to a single account, the shape that once broke the SQL adapters
// (which inserted those lines one at a time). That bug is fixed (every adapter handles the repeated
// (account, previous-hash) pair), so both the deep memory/http loop and the bounded SQL seeds run
// with `promo: true`, exercising every operation kind on every backend.
type ProgramOptions = { promo: boolean };

// Pick one valid operation for the next step and update the local tally so the next step stays valid
// too. The idempotency key and all ids come only from the step number, so the sequence is
// byte-identical on every replay, hence on every adapter.
function nextOperation(
  next: () => number,
  step: number,
  wallets: Map<string, Wallet>,
  options: ProgramOptions,
): Operation {
  let userId = `usr_f${1 + Math.floor(next() * 3)}`;
  let wallet = walletOf(wallets, userId);
  let roll = next();

  if (roll < 0.45 || wallet.spendable + wallet.promo < 100n) {
    let minor = BigInt(1 + Math.floor(next() * 50)) * 100n;
    wallet.spendable += minor;
    return op('topUp', step, {
      userId,
      amount: creditMinor(minor),
      source: 'card',
    });
  }
  if (options.promo && roll < 0.6) {
    let minor = BigInt(1 + Math.floor(next() * 20)) * 100n;
    wallet.promo += minor;
    return op('grantPromo', step, {
      userId,
      amount: creditMinor(minor),
      expiresAt: 86_400_000,
    });
  }
  return spendOperation(next, step, userId, wallet);
}

// Assemble an Operation, stamping in the per-step idempotency key and a fixed system actor. This
// check is about whether accounting comes out the same on every backend, not authorization, so it
// runs as the system and skips permission checks.
function op(
  kind: Operation['kind'],
  step: number,
  fields: Record<string, unknown>,
): Operation {
  return {
    kind,
    idempotencyKey: `idem_f_${step}`,
    actor: { kind: 'system', service: 'fuzz' },
    ...fields,
  } as Operation;
}

// Build the full fixed operation sequence for one seed.
function program(
  seed: number,
  length: number,
  options: ProgramOptions,
): Operation[] {
  let next = rng(seed);
  let wallets = new Map<string, Wallet>();
  let operations: Operation[] = [];
  for (let step = 0; step < length; step += 1) {
    operations.push(nextOperation(next, step, wallets, options));
  }
  return operations;
}

// --- Adversarial fixtures (preserved, run through the differential) ---------------------

// The four adversarial cases, each a fixed operation sequence rather than an assertion against a
// single in-memory economy. Each sequence is replayed across the whole matrix; comparing every
// reachable adapter against memory covers what the old single-backend assertions did. The builders
// generate fresh idempotency keys at module load, identically on every adapter, so a sequence is the
// same on every backend.
function adversarialFixtures(): Array<{
  name: string;
  operations: Operation[];
  // Optional: restrict a fixture to the no-database adapters (memory, http) instead of the full
  // matrix. No fixture needs it today (the bug that once forced the promo-draw fixture to skip the
  // SQL backends is fixed), but kept for a future fixture that can't reach a real database.
  inProcessOnly?: boolean;
}> {
  let duplicatePurchase = spend({
    buyerId: 'usr_d',
    sku: 'wrld_pass',
    price: creditAmount('4.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });

  return [
    {
      // Submitting the same purchase twice charges the buyer once: the first commits, the second
      // returns as a duplicate without taking more money. Every adapter must agree on the single
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
      // credit, and the platform's promo accounting still balances afterward. Posts two debit/credit
      // lines to one account; with the multi-line write bug fixed, every adapter stores it, so it
      // runs across the full matrix.
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

// Check the promo fixture's exact balances on the memory reference. Cross-adapter comparison can't
// catch a change that broke spend ordering the same way on every adapter at once; pinning the
// expected numbers here does. Run after the adapter comparison.
async function assertReferenceBalances(): Promise<void> {
  let promoEconomy = makeEconomy(ECONOMY_SEED);
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

// --- Runner ------------------------------------------------------------------------------

async function main(): Promise<void> {
  // Track which non-memory adapters were actually compared, so the success line says memory matched
  // postgres rather than claiming a comparison a down database skipped.
  let comparedAdapters = new Set<string>();
  let skippedAdapters = new Set<string>();

  let note = (result: CaseResult): void => {
    for (let name of result.compared) {
      if (name !== 'memory') {
        comparedAdapters.add(name);
      }
    }
    for (let name of result.skipped) {
      skippedAdapters.add(name);
    }
  };

  // Full matrix (SQL included) runs the small bounded cases; the no-database set (memory plus http,
  // both always available) carries the long deep loop, keeping the real-database operation count
  // small. (runDifferential always forces memory in, so naming only http here still compares memory
  // against http.)
  let fullMatrix = new Set(adapterMatrix().map((adapter) => adapter.name));
  let inProcess = new Set(['http']);

  try {
    // Adversarial cases: small, hand-built. Each runs across the whole matrix unless it sets
    // inProcessOnly (no-database adapters only); no case sets that flag today.
    let fixtures = adversarialFixtures();
    for (let fixture of fixtures) {
      note(
        await runDifferential(
          `fixture: ${fixture.name}`,
          fixture.operations,
          fixture.inProcessOnly ? inProcess : fullMatrix,
        ),
      );
    }
    await assertReferenceBalances();

    // Generated seeds. memory carries the deep loop (many seeds, each a long sequence) alongside
    // http (no database, cheap); the SQL databases run few seeds and a short sequence, since each op
    // is a round trip to a live database.
    let deepSeeds = Array.from({ length: 12 }, (_, i) => 0xf00 + i);
    let deepLength = 80;
    let sqlSeeds = 3; // run the SQL backends on only the first few seeds
    let sqlLength = 16; // and only a short sequence per seed

    for (let i = 0; i < deepSeeds.length; i += 1) {
      let seed = deepSeeds[i]!;
      if (i < sqlSeeds) {
        // Full matrix (SQL backends too) on a short sequence, promos included. With the multi-line
        // write bug fixed, the SQL adapters store promo-draw spends (two lines to one account) too,
        // so memory and postgres compare cleanly on the full set of operation kinds.
        note(
          await runDifferential(
            `seed 0x${seed.toString(16)} (sql-bounded)`,
            program(seed, sqlLength, { promo: true }),
            fullMatrix,
          ),
        );
      } else {
        // memory and http only, on a long sequence, promos included. No SQL round trips, but the
        // richer promo-draw path is still exercised against the no-database adapters.
        note(
          await runDifferential(
            `seed 0x${seed.toString(16)} (deep)`,
            program(seed, deepLength, { promo: true }),
            inProcess,
          ),
        );
      }
    }

    let fixtureCount = fixtures.length;
    let seedCount = deepSeeds.length;
    let matched = [...comparedAdapters].sort();
    let skipped = [...skippedAdapters].sort();

    if (matched.length === 0) {
      console.warn(
        `fuzz: ${fixtureCount} fixtures + ${seedCount} seeds — memory held; ` +
          `no other adapter reachable (skipped: ${skipped.join(', ') || 'none'}).`,
      );
    } else {
      console.warn(
        `fuzz: ${fixtureCount} fixtures + ${seedCount} seeds — memory matched ` +
          `${matched.join(', ')} (skipped: ${skipped.join(', ') || 'none'}). ` +
          `All adapters produced identical balances, chain heads, and prove reports.`,
      );
    }
  } catch (error) {
    console.error('fuzz:', (error as Error).message);
    process.exitCode = 1;
  }
}

await main();
