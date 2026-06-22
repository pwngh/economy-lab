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
 * A runnable command-line script (not part of the library core), which is why it is allowed
 * to set a process exit code: it exits non-zero on the first divergence and zero when every
 * adapter agrees.
 *
 * This checks that the SQL storage adapters behave exactly like the in-memory reference adapter.
 * For each starting number (a "seed") it builds one fixed sequence of operations and replays that
 * same sequence against every storage adapter that is reachable — memory, postgres, mysql, http —
 * each on its own fresh, isolated store. The memory adapter is the reference; every other adapter
 * must finish with the same balance for every account, the same latest hash-chain entry (the most
 * recent hash, which we call the account's "head") for every account, and the same integrity
 * report (the economy's `prove` check re-derives every balance from the entries and reports
 * whether money is conserved, fully backed by USD, never overdrawn, and the hash chains intact).
 * A mismatch fails loudly as
 * `adapter <X> diverged from memory at <detail>`. An adapter whose database is unreachable is
 * skipped (logged, not failed) — convenient for local work without every database running.
 *
 * For the comparison to be valid every adapter must compute hashes the same way, so each store
 * comes from `adapterMatrix()`, which wires every backend with the same seeded hash function and
 * the same fixed clock. The chain hash is computed inside the store, so identical operation
 * sequences then produce identical hashes, heads, and balances on every backend.
 *
 * The SQL adapters run only a small number of seeds and a short operation sequence on purpose,
 * because each operation is a round trip to a real database; the memory adapter, which is cheap,
 * carries the long, deep loop. The four hand-built adversarial cases below run through the same
 * comparison.
 *
 * Every case is fully fixed (no randomness), so the run produces the same result every time,
 * on Node, Bun, and Deno alike.
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

// The number that seeds the economy's hash function, fixed at 1 for every adapter and every case.
// Each store in the matrix is also built with seededDigest(1), and the chain hash is computed
// inside the store, so the economy's hash function must use the same seed for the hashes the
// economy reports to line up with the ones the store records. With that fixed, a given seed
// produces the same operation sequence on every adapter, comparable down to the last hash.
const ECONOMY_SEED = 1;

// Throws an error with the given message when the condition is false. The runner catches it and
// reports the message as the reason a case diverged.
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// --- The differential core --------------------------------------------------------------

// One adapter's end state after replaying an operation sequence: the balance of every account it
// touched (as a stable encoded string), every account's latest hash-chain entry, its integrity
// report, and — if an operation threw an error — the step index and error code of that throw. Two
// adapters fed the same sequence must produce equal snapshots, errors included; memory is the
// reference. Recording the error instead of letting it abort the run means a case whose operation
// is SUPPOSED to throw (for example, recipient shares that add up wrong) is itself compared across
// adapters: every adapter must throw the same code at the same step and leave the same balances.
type Snapshot = {
  balances: Map<AccountRef, string>;

  // Each account's latest hash-chain entry (its "head", the most recent hash), as raw hex. The
  // chain makes any after-the-fact tampering detectable. Two adapters fed the same sequence must
  // produce a byte-identical account-to-head map. A bug that merged an account's debit/credit
  // lines into the right balance but linked them in the wrong order would leave the balances equal
  // yet the head hashes different — this map catches that, and the balance map alone would not.
  heads: Map<AccountRef, string>;

  report: ProveReport;

  fault: { at: number; code: string } | null;
};

// Replay one operation sequence against a single store and capture its end state. The store is
// built fresh and isolated by `adapterMatrix()`, wired with the shared seeded hash function and
// fixed clock; the economy is built over it with the matching seed. The store is always closed,
// even when an operation throws, so a thrown error can't leak a database connection or a
// throwaway schema.
async function replay(
  store: Store,
  operations: ReadonlyArray<Operation>,
): Promise<Snapshot> {
  let economy = makeEconomy(ECONOMY_SEED, store);
  try {
    let fault: { at: number; code: string } | null = null;
    for (let i = 0; i < operations.length; i += 1) {
      // An operation that returns a 'rejected' outcome moved no money; that is ordinary data the
      // final-state comparison already captures. An operation that fails outright instead THROWS;
      // we catch the first throw, record its step and error code, and stop submitting — so an
      // operation that is meant to throw is itself compared across adapters (same code, same step,
      // same leftover balances) instead of aborting the run.
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

// Read the end state out of a running economy: the balance of every account the ledger has a
// head for (every account any posting touched), each account's head, the integrity report, and
// any error the replay caught.
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

// Compare a candidate adapter's snapshot against the memory reference and return the first
// difference as a human-readable detail, or null when they are byte-for-byte equal. The set of
// accounts and the per-account balances must match, the per-account head hashes must match, and
// every flag of the integrity report (plus the shortfall amount — how much USD backing is
// missing) must match.
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

  // Every account's head hash must match memory's exactly, byte for byte. A bug that merged an
  // account's debit/credit lines into the right balance but in a different order would leave the
  // balances equal while shifting the head hash; this comparison is the only thing that catches
  // it. The detail is worded so the caller's `adapter <X> diverged from memory at <detail>`
  // reads as `adapter <X> head diverged at <account>`.
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

// The outcome of running one case across the matrix: which adapters actually took part
// (memory plus every reachable backend) and which were skipped because their backend was down.
type CaseResult = { compared: string[]; skipped: string[] };

/**
 * Run one operation sequence against a set of adapters from the matrix and assert they all agree.
 *
 * memory is the reference and always available. For each other adapter we try to build a fresh
 * store; if that THROWS the backend is unreachable, so the adapter is skipped (recorded, not
 * failed) — correct for local work. A reachable adapter whose end state differs from memory's
 * throws `adapter <X> diverged from memory at <detail>`, which the caller reports before exiting
 * non-zero.
 *
 * `include` selects which adapter names take part. memory is always forced in (it is the
 * reference). This is how the number of real-database operations stays small: the deep seeds pass
 * an `include` that names only the adapters needing no database (memory, http), so the real SQL
 * databases run only on the short bounded seeds, never on the long deep loop.
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

// A small pseudo-random number generator (the "mulberry32" algorithm), identical to the one in
// scripts/prove.ts. Returns a function that yields the next number in [0, 1) each call. The math
// is fully fixed, so a given seed produces the exact same sequence on every JavaScript runtime —
// which is what makes "a seed is the same op sequence on every adapter" hold.
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

// The generator's running tally of one user's two spendable sources, in minor units (cents), so
// it only ever produces spends the user can actually afford — exercising the path where money
// really moves rather than the path where a spend is declined.
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

// Build a spend the user can afford and subtract it from the local running tally, taking from the
// promo balance first, matching the real spend handler (which always charges promo credit before
// regular spendable credit). If this tally fell out of step with the handler we would start
// generating spends the user can't afford, so the order matters.
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
    // A deterministic per-step order id: the SQL adapters record every sale in a `sales` table
    // whose `order_id` is NOT NULL, so a generated spend must carry one (the in-memory adapter
    // keeps no such table and would otherwise mask the omission). Derived from the step so the
    // sequence stays byte-identical on every adapter.
    orderId: `ord_f_${step}`,
    buyerId: userId,
    sku: 'wrld_pass',
    price: creditMinor(priceMinor),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
}

// What a generated sequence is allowed to contain. `promo` stays a toggle because a spend that
// draws on promo credit posts more than one debit/credit line to a single account — the shape
// that once broke the SQL adapters, which inserted those lines one at a time. That bug is fixed
// (every adapter now handles the repeated (account, previous-hash) pair correctly), so both the
// deep memory/http loop and the bounded SQL seeds run with `promo: true`, exercising the full set
// of operation kinds on every backend in the matrix.
type ProgramOptions = { promo: boolean };

// Pick one valid operation for the next step and update the local running tally so the next step
// stays valid too. The key that makes a retried request run at most once (the idempotency key)
// and all the ids come only from the step number, so the sequence is byte-identical on every
// replay — and therefore identical on every adapter.
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

// Assemble an Operation, stamping in the per-step idempotency key (the value that makes a retried
// request run at most once) and a fixed system actor. This check is about whether the accounting
// comes out the same on every backend, not who is allowed to do what, so it runs as the system
// and skips permission checks rather than modeling real users.
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

// The four original adversarial cases, each now expressed as a fixed operation sequence rather
// than an assertion against a single in-memory economy. Each sequence is replayed across the
// whole matrix; comparing every reachable adapter against memory proves they all end in the same
// state, which covers everything the old single-backend assertions did. The builders generate
// fresh idempotency keys (the keys that make a retried request run at most once) at module load,
// identically on every adapter, so a sequence is the same on every backend.
function adversarialFixtures(): Array<{
  name: string;
  operations: Operation[];
  // Optional flag to restrict a fixture to the adapters that need no database — memory and http —
  // instead of the full matrix. No fixture needs it today (the bug that once forced the
  // promo-draw fixture to skip the SQL backends is fixed, so every fixture now runs across the
  // whole matrix), but it is kept so a future fixture that genuinely can't reach a real database
  // can opt in.
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
      // A spend covered by promo credit draws the promo balance down before touching the user's
      // regular spendable credit, and the platform's promo accounting still balances afterward.
      // This posts two debit/credit lines to one account; now that the bug with writing multiple
      // lines at once is fixed, every adapter stores it, so it runs across the full matrix.
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

// Check the promo fixture's exact balances on the memory reference. Comparing adapters against
// each other cannot catch a change that broke spend ordering the same way on EVERY adapter at
// once; pinning the expected numbers here does. Run after the adapter comparison proves the
// adapters agree.
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
  // Track which non-memory adapters were actually compared, so the success line can say plainly
  // that memory matched (say) postgres, rather than claiming a comparison that a down database
  // silently skipped.
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

  // The full matrix (every adapter, SQL included) runs the small bounded cases; the set that
  // needs no database (memory plus http, both always available, no database round trips) carries
  // the long deep loop, keeping the number of real-database operations small. (memory is always
  // forced in by runDifferential, so naming only http here still compares memory against http.)
  let fullMatrix = new Set(adapterMatrix().map((adapter) => adapter.name));
  let inProcess = new Set(['http']);

  try {
    // The adversarial cases: small, hand-built. Each runs across the whole matrix unless it sets
    // its inProcessOnly flag, in which case it is restricted to the no-database adapters; no case
    // sets that flag today.
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

    // The generated seeds. memory carries the deep loop (many seeds, each a long sequence)
    // alongside http, which needs no database and is cheap; the real SQL databases run only a
    // small number of seeds and a short sequence, because each operation is a round trip to a
    // live database.
    let deepSeeds = Array.from({ length: 12 }, (_, i) => 0xf00 + i);
    let deepLength = 80;
    let sqlSeeds = 3; // run the SQL backends on only the first few seeds
    let sqlLength = 16; // and only a short sequence per seed

    for (let i = 0; i < deepSeeds.length; i += 1) {
      let seed = deepSeeds[i]!;
      if (i < sqlSeeds) {
        // Full matrix (SQL backends too) on a SHORT sequence, promos included — now that the bug
        // with writing multiple debit/credit lines at once is fixed, the SQL adapters store
        // promo-draw spends (two lines to one account) too, so memory and postgres compare
        // cleanly on the full set of operation kinds.
        note(
          await runDifferential(
            `seed 0x${seed.toString(16)} (sql-bounded)`,
            program(seed, sqlLength, { promo: true }),
            fullMatrix,
          ),
        );
      } else {
        // memory and http only, on a long sequence, promos included — no SQL round trips, so the
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
