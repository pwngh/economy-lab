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

// Pairs a running economy with its storage. We keep the store here so the link check
// below can read each account's latest hash directly from storage and compare it against
// what the committed operations said the hash should be.
type Provable = { economy: Economy; store: Store };

// Build a runnable { economy, store } over one adapter's storage. The store comes from the
// adapter's `makeStore()`, which is already set up to hash with seededDigest(1) and timestamp
// with fixedClock(0); the economy MUST use the SAME digest and clock. This matters because the
// integrity check (`read.prove()`) recomputes each account's chain hash with the economy's
// digest and compares it against the hash the store recorded. If the two used different digests
// or clocks, the recomputed hash would differ and the check would report the chain as broken
// even on correct data. So the digest and clock are held fixed; the only thing that varies from
// seed to seed is the signer, which never feeds the chain hash.
async function makeProvable(
  adapter: AdapterCase,
  seed: number,
): Promise<Provable> {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  let store = await adapter.makeStore();
  let economy = createEconomy({
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

// A small pseudo-random number generator (the "mulberry32" algorithm). Returns a function
// that yields the next number in [0, 1) each time it is called. Because the math is fully
// fixed, the same seed produces the exact same sequence on every JavaScript runtime, which
// is what makes a whole proof run repeatable and identical everywhere.
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

// The generator's own running tally of one user's two balances, in minor units (cents):
// `spendable` is money they topped up, `promo` is a marketing grant. We keep this tally so
// the generator only ever produces spends the user can actually afford. That way every
// generated operation succeeds, so the proof exercises the path where money really moves
// rather than the path where an operation is declined.
type Wallet = { spendable: bigint; promo: bigint };

// Format a count of minor units (cents) as a two-decimal string like "12.34". This is the
// text form `decodeAmount` expects when building an Amount.
function dollars(minor: bigint): string {
  let whole = minor / 100n;
  let frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

// Pick one random-but-valid operation for the next step, and update our local balance
// tally so the operation after it also stays valid. The idempotency key (the value that
// makes a retried request run at most once: a repeat carrying the same key is recognized
// and not applied again) and the ids come only from the step number, so re-running the
// program later produces the byte-identical operation, which is what lets the replay check
// resubmit the exact same request.
function nextOperation(
  next: () => number,
  step: number,
  wallets: Map<string, Wallet>,
): Operation {
  let userId = `usr_p${1 + Math.floor(next() * 3)}`;
  let wallet = walletOf(wallets, userId);
  let roll = next();

  if (roll < 0.45 || wallet.spendable + wallet.promo < 100n) {
    let minor = BigInt(1 + Math.floor(next() * 50)) * 100n;
    wallet.spendable += minor;
    return op('topUp', step, { userId, amount: credit(minor), source: 'card' });
  }
  if (roll < 0.6) {
    let minor = BigInt(1 + Math.floor(next() * 20)) * 100n;
    wallet.promo += minor;
    return op('grantPromo', step, {
      userId,
      amount: credit(minor),
      expiresAt: 86_400_000,
    });
  }
  return spendOperation(next, step, userId, wallet);
}

// Build a spend operation and subtract the price from our local balance tally. The real
// spend handler always charges the promo balance first and only then the spendable
// balance, so this tally must drain them in that same order; otherwise our copy of the
// balances would drift away from the economy's and we would start generating spends the
// user can't afford.
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
  // A spend's `orderId` is required by the contract and is the primary key of the sale row.
  // Deriving it from the step keeps it byte-identical on replay (like the idempotency key) and
  // unique per spend, so adapters that enforce a NOT-NULL/unique order key (e.g. postgres) take
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

// Assemble an Operation object, stamping in the per-step idempotency key and a fixed actor.
// We mark every request as coming from an internal "system" service: this proof is checking
// the ledger's accounting rules, not who is allowed to do what, so it bypasses the
// permission checks rather than modeling real users.
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
  let next = rng(seed);
  let wallets = new Map<string, Wallet>();
  let operations: Operation[] = [];
  for (let step = 0; step < length; step += 1) {
    operations.push(nextOperation(next, step, wallets));
  }
  return operations;
}

type Failure = { invariant: string; detail: Record<string, unknown> };

// Check every ledger property after a single operation, returning the first one that fails
// (or null if they all hold). Four of them come straight from the economy's built-in
// integrity report: money is neither created nor destroyed, real USD still covers what the
// platform owes users, no account went negative, and every account's hash chain is
// well-formed. The fifth, the chain-link check, is done separately below: it confirms that
// each account the operation touched now records, as its latest hash, the exact hash the
// committed operation said it produced.
async function checkInvariants(
  provable: Provable,
  outcome: Outcome,
  heads: Map<AccountRef, string>,
): Promise<Failure | null> {
  let report = await provable.economy.read.prove();
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
  return verifyChainLinks(provable, outcome, heads);
}

// Each account keeps a tamper-evident chain of postings, and the "head" is the latest hash
// in that chain. This builds up what every head should be — for each account the committed
// operation touched, the new hash it reported — and remembers it across steps in `heads`.
// It then reads the actual current head of every account from storage and fails if any one
// does not match the hash we expected.
async function verifyChainLinks(
  provable: Provable,
  outcome: Outcome,
  heads: Map<AccountRef, string>,
): Promise<Failure | null> {
  if (outcome.status === 'committed') {
    for (let link of outcome.transaction.links) {
      heads.set(link.account, link.hash);
    }
  }
  let live = new Map<AccountRef, string>();
  for await (let [account, head] of provable.store.ledger.heads()) {
    live.set(account, head);
  }
  for (let [account, expected] of heads) {
    if (live.get(account) !== expected) {
      return {
        invariant: 'chainVerifies',
        detail: { account, expected, actual: live.get(account) ?? null },
      };
    }
  }
  return null;
}

// Check that submitting the same operation twice runs it only once: the second submit must
// come back as `duplicate`, not run again. This is the guarantee that a client safely
// retrying a request never double-charges. To test it without disturbing the main run, this
// rebuilds the program in a brand-new economy, replays operations up to the target step,
// then submits that last operation a second time and expects a `duplicate` result.
async function replayIsDuplicate(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
  upTo: number,
): Promise<Failure | null> {
  let { economy, store } = await makeProvable(adapter, seed);
  try {
    let last: Outcome | null = null;
    for (let i = 0; i <= upTo; i += 1) {
      last = await economy.submit(operations[i]!);
    }
    if (!last || last.status !== 'committed') {
      return null;
    }
    let replay = await economy.submit(operations[upTo]!);
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

// Submit the operations one at a time, and after each one run the full set of checks. The
// moment a check fails, stop and return that step's index together with what failed. If the
// whole program runs with every check passing, return null.
async function runSeed(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
): Promise<{ at: number; failure: Failure } | null> {
  let provable = await makeProvable(adapter, seed);
  try {
    let heads = new Map<AccountRef, string>();
    for (let i = 0; i < operations.length; i += 1) {
      let outcome = await provable.economy.submit(operations[i]!);
      let failure = await checkInvariants(provable, outcome, heads);
      if (failure) {
        return { at: i, failure };
      }
      let replay = await replayIsDuplicate(adapter, seed, operations, i);
      if (replay) {
        return { at: i, failure: replay };
      }
    }
    return null;
  } finally {
    await provable.store.close();
  }
}

// Once a run has failed, find the shortest beginning slice of the program that still fails,
// so the report can point at the smallest example that reproduces the bug. It tries the
// first 1 operation, then the first 2, and so on, and stops at the first slice that fails;
// `at` is the step where the full run broke, so the search never needs to look past it.
async function shrink(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
  at: number,
): Promise<number> {
  let minimal = at;
  for (let length = 0; length <= at; length += 1) {
    let prefix = operations.slice(0, length + 1);
    if (await runSeed(adapter, seed, prefix)) {
      minimal = length;
      break;
    }
  }
  return minimal;
}

// Probe one adapter's backend by opening a store and closing it again. memory and the
// in-process http server always answer; postgres/mysql throw here when their backend is
// unreachable (or their URL is unset). An adapter that can't be reached is SKIPPED, which is
// correct for local work — it is not a failure.
async function reachable(adapter: AdapterCase): Promise<boolean> {
  try {
    let probe = await adapter.makeStore();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

// Run the full proof against ONE storage adapter: for every seed, generate a fixed-length
// program of operations and check all the ledger properties hold after each one. Prints one
// summary line for this adapter. Returns false on the first property that fails, and before
// returning it narrows the failure to the shortest run that still reproduces it and sets a
// non-zero process exit code so the script reports failure to the shell.
async function proveAdapter(
  adapter: AdapterCase,
  seeds: number[],
  length: number,
): Promise<boolean> {
  for (let seed of seeds) {
    let operations = program(seed, length);
    // A backend can also reject a posting outright (a thrown DB error), not just return a
    // failing invariant. Treat that as a per-adapter failure so one backend's hard error is
    // reported and exits non-zero, instead of crashing the process and masking the rest.
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
      let minimal = await shrink(adapter, seed, operations, result.at);
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

async function main(): Promise<void> {
  // Run 8 seeds, each a program of 60 operations. Every adapter runs this same workload, so
  // adding more adapters does not change how much work each one does.
  let seeds = Array.from({ length: 8 }, (_, i) => 0x1000 + i);
  let length = 60;

  for (let adapter of adapterMatrix()) {
    // memory is the always-on fast path; every other adapter is gated on its backend being
    // reachable and skipped (not failed) when it is not.
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
