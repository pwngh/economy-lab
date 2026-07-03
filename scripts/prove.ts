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

import process from 'node:process';

import { createEconomy } from '#src/economy.ts';
import { decodeAmount } from '#src/money.ts';
import { adapterMatrix } from '#test/support/adapters.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
} from '#test/support/capabilities.ts';

import type { AdapterCase } from '#test/support/adapters.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Store } from '#src/ports.ts';

// Pairs a running economy with its storage. The link check below reads each account's latest
// hash from the store and compares it against what the committed operations reported.
type Provable = { economy: Economy; store: Store };

// Builds a runnable { economy, store } over one adapter's storage. The adapter's makeStore()
// hashes with seededDigest(1) and timestamps with fixedClock(0), so the economy must use the
// same digest and clock. read.prove() recomputes each account's chain hash with the economy's
// digest and compares it against the store's recorded hash. A mismatched digest or clock would
// therefore report a broken chain on correct data. The digest and clock stay fixed across seeds.
// Only the signer varies per seed, and the signer never feeds the chain hash.
async function makeProvable(
  adapter: AdapterCase,
  seed: number,
): Promise<Provable> {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = await adapter.makeStore();
  const economy = createEconomy({
    store,
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(seed),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
  });
  return { economy, store };
}

// Builds a mulberry32 PRNG and returns a function yielding the next number in [0, 1). The same
// seed produces an identical sequence on every JS runtime, which makes a proof run repeatable.
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

// Holds the generator's running tally of one user's two balances, in minor units (cents).
// `spendable` is topped-up money. `promo` is a marketing grant. The generator tracks both so
// it only produces affordable spends, keeping the proof on the path where money moves rather
// than declines.
type Wallet = { spendable: bigint; promo: bigint };

// Formats minor units (cents) as a two-decimal string like "12.34". That is the form
// decodeAmount expects when building an Amount.
function dollars(minor: bigint): string {
  const whole = minor / 100n;
  const frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

// Picks one random-but-valid operation and updates the local tally so the next one stays valid.
// The idempotency key and the ids derive only from the step number, so a re-run produces the
// byte-identical operation. That lets the replay check resubmit the exact request. The
// idempotency key makes a retried request run at most once: a repeat with the same key is
// recognized and not reapplied.
function nextOperation(
  next: () => number,
  step: number,
  wallets: Map<string, Wallet>,
): Operation {
  const userId = `usr_p${1 + Math.floor(next() * 3)}`;
  const wallet = walletOf(wallets, userId);
  const roll = next();

  if (roll < 0.45 || wallet.spendable + wallet.promo < 100n) {
    const minor = BigInt(1 + Math.floor(next() * 50)) * 100n;
    wallet.spendable += minor;
    return op('topUp', step, { userId, amount: credit(minor), source: 'card' });
  }
  if (roll < 0.6) {
    const minor = BigInt(1 + Math.floor(next() * 20)) * 100n;
    wallet.promo += minor;
    return op('grantPromo', step, {
      userId,
      amount: credit(minor),
      expiresAt: 86_400_000,
    });
  }
  return spendOperation(next, step, userId, wallet);
}

// Builds a spend operation and subtracts the price from the local tally. The real spend handler
// charges promo before spendable, so the tally must drain in that same order. Draining in any
// other order would let the local copy drift from the economy's and generate unaffordable spends.
function spendOperation(
  next: () => number,
  step: number,
  userId: string,
  wallet: Wallet,
): Operation {
  const available = wallet.spendable + wallet.promo;
  let priceMinor =
    BigInt(1 + Math.floor(next() * Number(available / 100n))) * 100n;
  if (priceMinor > available) {
    priceMinor = available;
  }
  const fromPromo = wallet.promo < priceMinor ? wallet.promo : priceMinor;
  wallet.promo -= fromPromo;
  wallet.spendable -= priceMinor - fromPromo;
  // `orderId` is required by the contract and is the sale row's primary key. Deriving it from
  // the step keeps it byte-identical on replay, like the idempotency key, and unique per spend.
  // An adapter that enforces a not-null and unique order key (for example postgres) then takes
  // the same path as memory rather than diverging on a null key.
  return op('spend', step, {
    orderId: `ord_p_${step}`,
    buyerId: userId,
    sku: 'wrld_pass',
    price: credit(priceMinor),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
}

function walletOf(wallets: Map<string, Wallet>, userId: string): Wallet {
  let wallet = wallets.get(userId);
  if (!wallet) {
    wallet = { spendable: 0n, promo: 0n };
    wallets.set(userId, wallet);
  }
  return wallet;
}

// Assembles an Operation, stamping in the per-step idempotency key and a fixed actor. Every
// request comes from an internal "system" service. This proof checks accounting rules, not
// authorization, so it bypasses permission checks rather than modeling real users.
function op(
  kind: Operation['kind'],
  step: number,
  fields: Record<string, unknown>,
): Operation {
  return {
    kind,
    idempotencyKey: `idem_p_${step}`,
    actor: { kind: 'system', service: 'prove' },
    ...fields,
  } as Operation;
}

function credit(minor: bigint) {
  return decodeAmount(dollars(minor), 'CREDIT');
}

function program(seed: number, length: number): Operation[] {
  const next = rng(seed);
  const wallets = new Map<string, Wallet>();
  const operations: Operation[] = [];
  for (let step = 0; step < length; step += 1) {
    operations.push(nextOperation(next, step, wallets));
  }
  return operations;
}

type Failure = { invariant: string; detail: Record<string, unknown> };

// Checks every ledger property after one operation and returns the first failure, or null when
// all hold. Five flags come from the economy's integrity report. The sixth is the chain-link
// check below, which confirms each touched account's latest head matches what the committed
// operation reported.
async function checkInvariants(
  provable: Provable,
  outcome: Outcome,
  heads: Map<AccountRef, string>,
): Promise<Failure | null> {
  const report = await provable.economy.read.prove();
  if (!report.conserved) {
    return { invariant: 'conserves', detail: {} };
  }
  if (!report.backed) {
    return {
      invariant: 'staysBacked',
      detail: { shortfall: report.shortfall.minor.toString() },
    };
  }
  if (!report.noOverdraft) {
    return { invariant: 'neverNegative', detail: {} };
  }
  if (!report.chainIntact) {
    return { invariant: 'chainVerifies', detail: { reason: 'malformed head' } };
  }
  if (!report.consistent) {
    return {
      invariant: 'balanceConsistent',
      detail: { drift: report.drift.length },
    };
  }
  return verifyChainLinks(provable, outcome, heads);
}

// Each account keeps a tamper-evident chain of postings, and its "head" is the latest hash. This
// accumulates the expected head per touched account in `heads` across steps, where each expected
// head is the hash the committed operation reported. It then reads each account's actual head
// from storage and fails on any mismatch.
async function verifyChainLinks(
  provable: Provable,
  outcome: Outcome,
  heads: Map<AccountRef, string>,
): Promise<Failure | null> {
  if (outcome.status === 'committed') {
    for (const link of outcome.transaction.links) {
      heads.set(link.account, link.hash);
    }
  }
  const live = new Map<AccountRef, string>();
  for await (const [account, head] of provable.store.ledger.heads()) {
    live.set(account, head);
  }
  for (const [account, expected] of heads) {
    if (live.get(account) !== expected) {
      return {
        invariant: 'chainVerifies',
        detail: { account, expected, actual: live.get(account) ?? null },
      };
    }
  }
  return null;
}

// Checks that submitting the same operation twice runs it only once. The second submit must
// return `duplicate`, which guarantees a safely retried request never double-charges. To avoid
// disturbing the main run, this rebuilds the program in a fresh economy, replays up to the
// target step, then resubmits that operation and expects `duplicate`.
async function replayIsDuplicate(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
  upTo: number,
): Promise<Failure | null> {
  const { economy, store } = await makeProvable(adapter, seed);
  try {
    let last: Outcome | null = null;
    for (let i = 0; i <= upTo; i += 1) {
      last = await economy.submit(operations[i]!);
    }
    if (!last || last.status !== 'committed') {
      return null;
    }
    const replay = await economy.submit(operations[upTo]!);
    if (replay.status !== 'duplicate') {
      return {
        invariant: 'replayIsDuplicate',
        detail: { status: replay.status },
      };
    }
    return null;
  } finally {
    await store.close();
  }
}

// Submits operations one at a time, running the full checks after each. On the first failure,
// it stops and returns the step index plus what failed. It returns null when every check passes.
async function runSeed(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
): Promise<{ at: number; failure: Failure } | null> {
  const provable = await makeProvable(adapter, seed);
  try {
    const heads = new Map<AccountRef, string>();
    for (let i = 0; i < operations.length; i += 1) {
      const outcome = await provable.economy.submit(operations[i]!);
      const failure = await checkInvariants(provable, outcome, heads);
      if (failure) {
        return { at: i, failure };
      }
      const replay = await replayIsDuplicate(adapter, seed, operations, i);
      if (replay) {
        return { at: i, failure: replay };
      }
    }
    return null;
  } finally {
    await provable.store.close();
  }
}

// After a failure, finds the shortest leading slice that still fails, so the report points at
// the smallest reproducer. It tries the first 1 op, then the first 2, and so on, stopping at the
// first failing slice. `at` is where the full run broke, so the search never looks past it.
async function shrink(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
  at: number,
): Promise<number> {
  let minimal = at;
  for (let length = 0; length <= at; length += 1) {
    const prefix = operations.slice(0, length + 1);
    if (await runSeed(adapter, seed, prefix)) {
      minimal = length;
      break;
    }
  }
  return minimal;
}

// Probes an adapter's backend by opening and closing a store. memory and the in-process http
// server always answer. postgres and mysql throw when their backend is unreachable or its URL
// is unset. An unreachable adapter is skipped, not failed, which is correct for local work.
async function reachable(adapter: AdapterCase): Promise<boolean> {
  try {
    const probe = await adapter.makeStore();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

// Runs the full proof against one storage adapter. For every seed, it generates a fixed-length
// program and checks all ledger properties after each operation, then prints one summary line.
// It returns false on the first failing property, first narrowing it to the shortest reproducing
// run and setting a non-zero process exit code so the script reports failure to the shell.
async function proveAdapter(
  adapter: AdapterCase,
  seeds: number[],
  length: number,
): Promise<boolean> {
  for (const seed of seeds) {
    const operations = program(seed, length);
    // A backend can also reject a posting outright with a thrown DB error, not just return a
    // failing invariant. Treat that as a per-adapter failure. Report it and exit non-zero
    // instead of crashing the process and masking the remaining adapters.
    let result: { at: number; failure: Failure } | null;
    try {
      result = await runSeed(adapter, seed, operations);
    } catch (error) {
      console.error(
        `prove [${adapter.name}]: backend rejected an operation, seed ` +
          `0x${seed.toString(16)}`,
        error,
      );
      process.exitCode = 1;
      return false;
    }
    if (result) {
      const minimal = await shrink(adapter, seed, operations, result.at);
      console.error(
        `prove [${adapter.name}]: ${result.failure.invariant} violated at op ` +
          `#${result.at + 1} (minimal failing prefix: ${minimal + 1} ops), ` +
          `seed 0x${seed.toString(16)}`,
        result.failure.detail,
      );
      process.exitCode = 1;
      return false;
    }
  }
  console.warn(
    `prove [${adapter.name}]: ${seeds.length} seeds × ${length} ops — all ` +
      `invariants hold.`,
  );
  return true;
}

/**
 * Run the randomized invariant prover across every reachable adapter, exiting non-zero on
 * the first violation.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for what
 * the proof asserts and why it runs after every operation.
 */
async function main(): Promise<void> {
  // Use 8 seeds, each a 60-operation program. Every adapter runs this same workload.
  const seeds = Array.from({ length: 8 }, (_, i) => 0x1000 + i);
  const length = 60;

  for (const adapter of adapterMatrix()) {
    // memory always runs. Every other adapter is gated on its backend being reachable, and it
    // is skipped, not failed, when the backend is unreachable.
    if (adapter.name !== 'memory' && !(await reachable(adapter))) {
      console.warn(`prove [${adapter.name}]: backend unreachable — skipped.`);
      continue;
    }
    if (!(await proveAdapter(adapter, seeds, length))) {
      return;
    }
  }
}

await main();
