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

// Running economy plus its storage. The link check below reads each account's latest hash
// from the store and compares it against what the committed operations reported.
type Provable = { economy: Economy; store: Store };

// Build a runnable { economy, store } over one adapter's storage. The adapter's makeStore()
// hashes with seededDigest(1) and timestamps with fixedClock(0); the economy must use the same
// digest and clock. read.prove() recomputes each account's chain hash with the economy's digest
// and compares against the store's recorded hash, so a mismatched digest or clock would report a
// broken chain on correct data. Digest and clock stay fixed; only the signer varies per seed,
// and it never feeds the chain hash.
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

// mulberry32 PRNG. Returns a function yielding the next number in [0, 1). The same seed
// produces the identical sequence on every JS runtime, which makes a proof run repeatable.
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

// Generator's running tally of one user's two balances, in minor units (cents): `spendable`
// is topped-up money, `promo` is a marketing grant. Tracked so the generator only produces
// affordable spends, keeping the proof on the path where money moves rather than declines.
type Wallet = { spendable: bigint; promo: bigint };

// Format minor units (cents) as a two-decimal string like "12.34", the form decodeAmount
// expects when building an Amount.
function dollars(minor: bigint): string {
  let whole = minor / 100n;
  let frac = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

// Pick one random-but-valid operation and update the local tally so the next one stays valid.
// The idempotency key (makes a retried request run at most once: a repeat with the same key
// is recognized and not reapplied) and the ids derive only from the step number, so a re-run
// produces the byte-identical operation, letting the replay check resubmit the exact request.
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

// Build a spend operation and subtract the price from the local tally. The real spend handler
// charges promo before spendable, so the tally drains in that order; otherwise the local copy
// drifts from the economy's and we'd generate unaffordable spends.
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
  // `orderId` is required by the contract and is the sale row's primary key. Deriving it from
  // the step keeps it byte-identical on replay (like the idempotency key) and unique per spend,
  // so adapters enforcing a not-null/unique order key (e.g. postgres) take the same path as
  // memory rather than diverging on a null key.
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

// Assemble an Operation, stamping in the per-step idempotency key and a fixed actor. Every
// request comes from an internal "system" service: this proof checks accounting rules, not
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
  let next = rng(seed);
  let wallets = new Map<string, Wallet>();
  let operations: Operation[] = [];
  for (let step = 0; step < length; step += 1) {
    operations.push(nextOperation(next, step, wallets));
  }
  return operations;
}

type Failure = { invariant: string; detail: Record<string, unknown> };

// Check every ledger property after one operation, returning the first failure (or null).
// Five come from the economy's integrity report: money is neither created nor destroyed,
// real USD still covers what the platform owes users, no account went negative, every
// hash chain is well-formed, and each account's cached balance equals the sum of its
// debit/credit lines. The sixth, the chain-link check below, confirms each touched
// account's latest hash matches the hash the committed operation reported.
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
  if (!report.consistent) {
    return {
      invariant: 'balanceConsistent',
      detail: { drift: report.drift.length },
    };
  }
  return verifyChainLinks(provable, outcome, heads);
}

// Each account keeps a tamper-evident chain of postings; the "head" is its latest hash. This
// accumulates the expected head per touched account (the hash the committed operation reported)
// across steps in `heads`, then reads each account's actual head from storage and fails on any
// mismatch.
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

// Check that submitting the same operation twice runs it once: the second submit must return
// `duplicate`, guaranteeing a safely retried request never double-charges. To avoid disturbing
// the main run, this rebuilds the program in a fresh economy, replays up to the target step,
// then resubmits that operation and expects `duplicate`.
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

// Submit operations one at a time, running the full checks after each. On the first failure,
// stop and return the step index plus what failed. If every check passes, return null.
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

// After a failure, find the shortest leading slice that still fails, so the report points at
// the smallest reproducer. Tries the first 1 op, then 2, etc., stopping at the first failing
// slice; `at` is where the full run broke, so the search never looks past it.
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

// Probe an adapter's backend by opening and closing a store. memory and the in-process http
// server always answer; postgres/mysql throw when their backend is unreachable (or URL unset).
// An unreachable adapter is skipped, not failed, which is correct for local work.
async function reachable(adapter: AdapterCase): Promise<boolean> {
  try {
    let probe = await adapter.makeStore();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

// Run the full proof against one storage adapter: for every seed, generate a fixed-length
// program and check all ledger properties after each operation. Prints one summary line.
// Returns false on the first failing property, first narrowing it to the shortest reproducing
// run and setting a non-zero process exit code so the script reports failure to the shell.
async function proveAdapter(
  adapter: AdapterCase,
  seeds: number[],
  length: number,
): Promise<boolean> {
  for (let seed of seeds) {
    let operations = program(seed, length);
    // A backend can also reject a posting outright (a thrown DB error), not just return a
    // failing invariant. Treat that as a per-adapter failure, reporting it and exiting non-zero
    // instead of crashing the process and masking the rest.
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
  // 8 seeds, each a 60-operation program. Every adapter runs this same workload.
  let seeds = Array.from({ length: 8 }, (_, i) => 0x1000 + i);
  let length = 60;

  for (let adapter of adapterMatrix()) {
    // memory always runs; every other adapter is gated on its backend being reachable and
    // skipped (not failed) when it isn't.
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
