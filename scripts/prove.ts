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
import { adapterMatrix } from '#test/support/adapters.ts';
import { seededProgram } from '#test/support/seeded-program.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  silentMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
  testSecrets,
} from '#test/support/capabilities.ts';

import type { AdapterCase } from '#test/support/adapters.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Store } from '#src/ports.ts';

type Provable = { economy: Economy; store: Store };

// The economy must use the same digest and clock the adapter's makeStore() hashes with — a
// mismatch would report a broken chain on correct data. Only the signer varies per seed, and the
// signer never feeds the chain hash.
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
    meter: silentMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
    secrets: testSecrets(),
  });
  return { economy, store };
}

type Failure = { invariant: string; detail: Record<string, unknown> };

// Returns the first failing ledger property, or null when all hold. Five flags come from prove();
// the sixth is the chain-link check below.
async function checkInvariants(
  provable: Provable,
  outcome: Outcome,
  heads: Map<AccountRef, string>,
): Promise<Failure | null> {
  const report = await provable.economy.read.health();
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

// Accumulates the expected head per touched account across steps (the hash each committed
// operation reported), then fails on any mismatch against the heads actually in storage.
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

// Resubmitting a committed operation must return `duplicate`. Rebuilt in a fresh economy and
// replayed up to the target step, so the replay never disturbs the main run.
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

// Finds the shortest leading slice that still fails — the smallest reproducer. `at` is where the
// full run broke, so the search never looks past it.
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

async function reachable(adapter: AdapterCase): Promise<boolean> {
  try {
    const probe = await adapter.makeStore();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

// Returns false on the first failing property, after narrowing to the shortest reproducing run and
// setting a non-zero exit code.
async function proveAdapter(
  adapter: AdapterCase,
  seeds: number[],
  length: number,
): Promise<boolean> {
  for (const seed of seeds) {
    const operations = seededProgram(seed, length, {
      prefix: 'p',
      service: 'prove',
    });
    // A thrown DB error is a per-adapter failure: report it and exit non-zero instead of crashing
    // the process and masking the remaining adapters.
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
    `prove [${adapter.name}]: ${seeds.length} seeds * ${length} ops — all ` +
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
  const seeds = Array.from({ length: 8 }, (_, i) => 0x1000 + i);
  const length = 60;

  // The one capture of process.env: the adapter matrix resolves its database URLs from this.
  for (const adapter of adapterMatrix(process.env)) {
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
