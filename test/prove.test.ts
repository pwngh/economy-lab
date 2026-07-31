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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

import '#test/support/dist-guard.ts';

import { createEconomy } from '#src/economy.ts';
import { proveEconomy } from '#src/integrity.ts';
import { adapterMatrix } from '#test/support/adapters.ts';
import { creditMinor, seededProgram } from '#test/support/seeded-program.ts';
import { recutLeg } from '#test/support/tamper.ts';
import { spendable } from '#src/accounts.ts';
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
import type { ChainBreak } from '#src/chain.ts';
import type { ProvePorts } from '#src/integrity.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { MemoryLedger } from '#src/adapters/memory.ts';
import type { Store } from '#src/ports.ts';

// `ports` is what the thorough prover needs. It is the same store, digest, signer and rates the
// economy was built on, because a prover holding a different digest reports a broken chain on
// correct data.
type Provable = { economy: Economy; store: Store; ports: ProvePorts };

/**
 * What one adapter's run actually did. Every field is reconciled against the seeds and the length
 * below, because a prover that quietly stopped checking examines fewer vectors and reports the
 * same green.
 */
type Tally = {
  submits: number;
  storeOpens: number;
  duplicateChecks: number;
  committed: number;
};

const freshTally = (): Tally => ({
  submits: 0,
  storeOpens: 0,
  duplicateChecks: 0,
  committed: 0,
});

// The economy must use the same digest and clock the adapter's makeStore() hashes with — a
// mismatch would report a broken chain on correct data. Only the signer varies per seed, and the
// signer never feeds the chain hash.
async function makeProvable(
  adapter: AdapterCase,
  seed: number,
  tally: Tally,
): Promise<Provable> {
  tally.storeOpens += 1;
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = await adapter.makeStore();
  const signer = seededSigner(seed);
  const rates = fixedRates();
  const economy = createEconomy({
    store,
    clock,
    ids: sequentialIds(),
    digest,
    signer,
    rates,
    logger: testLogger(),
    meter: silentMeter(),
    processor: fakeProcessor(),
    pricing: defaultPricing(),
    config: testConfig(),
    secrets: testSecrets(),
  });
  return { economy, store, ports: { store, rates, digest, signer } };
}

type Failure = { invariant: string; detail: Record<string, unknown> };

// Returns the first failing ledger property, or null when all hold. The five flags come from
// `proveEconomy`, which replays every account's chain from genesis, so `chainVerifies` here is a
// re-hash of every stored link and not a shape check on the newest one. The sixth check below
// asks a different question and needs the whole chain intact before its answer means anything.
async function checkInvariants(
  provable: Provable,
  outcome: Outcome,
  heads: Map<AccountRef, string>,
): Promise<Failure | null> {
  const report = await proveEconomy(provable.ports);
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
    // The break rides the detail because this message is the whole of what a failing `prove` step
    // hands back — a verdict naming no link sends the reader to search the ledger for the posting
    // the prover already found.
    return {
      invariant: 'chainVerifies',
      detail: { prover: report.prover, firstBreak: report.firstBreak },
    };
  }
  if (!report.consistent) {
    return {
      invariant: 'balanceConsistent',
      detail: { drift: report.drift.length },
    };
  }
  return headMatchesReported(provable, outcome, heads);
}

// Holds each committed operation to its word. It accumulates the head every operation reported
// for each account it touched, then fails on any account whose stored head is not the last head
// reported for it. An engine that answered with a head it never wrote is what this catches; a
// link whose content no longer hashes to its recorded head is `chainVerifies` above.
async function headMatchesReported(
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
        invariant: 'headMatchesReported',
        detail: { account, expected, actual: live.get(account) ?? null },
      };
    }
  }
  return null;
}

// Resubmitting a committed operation must return `duplicate`. The resubmit goes to the economy
// that just committed it: a key replay returns from the idempotency claim before any lock,
// handler, velocity attempt or event, so it writes nothing the rest of the run can read — and
// the next operation's invariant check reads the same economy, so it would catch it if that ever
// stopped being true.
async function replayIsDuplicate(
  provable: Provable,
  operation: Operation,
  outcome: Outcome,
  tally: Tally,
): Promise<Failure | null> {
  if (outcome.status !== 'committed') {
    return null;
  }
  tally.submits += 1;
  tally.duplicateChecks += 1;
  const replay = await provable.economy.submit(operation);
  if (replay.status !== 'duplicate') {
    return {
      invariant: 'replayIsDuplicate',
      detail: { status: replay.status },
    };
  }
  return null;
}

async function runSeed(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
  tally: Tally,
): Promise<{ at: number; failure: Failure } | null> {
  const provable = await makeProvable(adapter, seed, tally);
  try {
    const heads = new Map<AccountRef, string>();
    for (let i = 0; i < operations.length; i += 1) {
      tally.submits += 1;
      const outcome = await provable.economy.submit(operations[i]!);
      if (outcome.status === 'committed') {
        tally.committed += 1;
      }
      const failure = await checkInvariants(provable, outcome, heads);
      if (failure) {
        return { at: i, failure };
      }
      const replay = await replayIsDuplicate(
        provable,
        operations[i]!,
        outcome,
        tally,
      );
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
// full run broke, so the search never looks past it. Its re-runs get their own tally, so the
// vectors the run reports stay one per operation.
async function shrink(
  adapter: AdapterCase,
  seed: number,
  operations: Operation[],
  at: number,
): Promise<number> {
  let minimal = at;
  for (let length = 0; length <= at; length += 1) {
    const prefix = operations.slice(0, length + 1);
    if (await runSeed(adapter, seed, prefix, freshTally())) {
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

// Replays every seed against one adapter and returns what the run did. It throws on the first
// failing property, after narrowing to the shortest reproducing run, so the reason is the failure
// message rather than an exit code somebody has to parse back out of stdout.
async function proveAdapter(
  adapter: AdapterCase,
  seeds: readonly number[],
  length: number,
): Promise<Tally> {
  const tally = freshTally();
  for (const seed of seeds) {
    const operations = seededProgram(seed, length, {
      prefix: 'p',
      service: 'prove',
    });
    let result: { at: number; failure: Failure } | null;
    try {
      result = await runSeed(adapter, seed, operations, tally);
    } catch (cause) {
      throw new Error(
        `prove [${adapter.name}]: backend rejected an operation, seed 0x${seed.toString(16)}`,
        { cause },
      );
    }
    if (result) {
      const minimal = await shrink(adapter, seed, operations, result.at);
      throw new Error(
        `prove [${adapter.name}]: ${result.failure.invariant} violated at op ` +
          `#${result.at + 1} (minimal failing prefix: ${minimal + 1} ops), ` +
          `seed 0x${seed.toString(16)} — ${JSON.stringify(result.failure.detail)}`,
      );
    }
  }
  return tally;
}

/** Eight seeds of sixty operations, per adapter. The vector count below is derived from both. */
const SEEDS = Array.from({ length: 8 }, (_, i) => 0x1000 + i);
const LENGTH = 60;

/**
 * One adapter's whole run. Eight store opens and 480 operations against a live engine is the
 * slowest thing here; the SQL legs measure about ten seconds each. The bound is per test, so a
 * wedged engine names its adapter instead of taking the file's 600s backstop with it.
 */
const ADAPTER_BOUND_MS = 180_000;

// This is the one capture of process.env. The adapter matrix resolves its database URLs from it.
const matrix = adapterMatrix(process.env);

test('the prover runs against every adapter the matrix declares', () => {
  // A matrix that resolved to nothing would leave every test below undeclared and the file green.
  assert.deepEqual(
    matrix.map((adapter) => adapter.name),
    ['memory', 'postgres', 'mysql', 'http'],
  );
});

/**
 * Run the randomized invariant prover across every reachable adapter.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/the-proof/ The proof} for what
 * the proof asserts and why it runs after every operation.
 */
for (const adapter of matrix) {
  test(
    `prove [${adapter.name}]: every invariant holds over ${SEEDS.length} seeds * ${LENGTH} ops`,
    { timeout: ADAPTER_BOUND_MS },
    async (t) => {
      // memory always runs. Every other adapter is gated on its backend being reachable, and it
      // is skipped by name, not failed, when the backend is unreachable.
      if (adapter.name !== 'memory' && !(await reachable(adapter))) {
        t.skip(`${adapter.name}: backend unreachable`);
        return;
      }
      const tally = await proveAdapter(adapter, SEEDS, LENGTH);

      // The vectors, counted. `prove` signalled by exit code alone until it moved here, so a
      // version that quietly stopped checking read as a speedup; every number below is derived
      // from the seeds and the length, so a run that examined less than it claims fails by name.
      assert.equal(
        tally.storeOpens,
        SEEDS.length,
        'one fresh store per seed, and this run opened a different number',
      );
      assert.equal(
        tally.duplicateChecks,
        tally.committed,
        `${tally.committed} operations committed but ${tally.duplicateChecks} were re-submitted, so the duplicate property went unchecked somewhere`,
      );
      assert.ok(
        tally.duplicateChecks > 0,
        'nothing committed, so the duplicate property was never exercised',
      );
      assert.equal(
        tally.submits,
        SEEDS.length * LENGTH + tally.duplicateChecks,
        'every operation is submitted once and every commit re-submitted once, and these do not add up',
      );
    },
  );
}

// One top-up through the public door, asserted to have committed so the transaction it returns is
// real. The amount is whole credits, which is what the step's own generator produces.
async function topUpOnce(
  provable: Provable,
  userId: string,
  step: number,
): Promise<{ outcome: Outcome; txnId: string; head: string }> {
  const outcome = await provable.economy.submit({
    kind: 'topUp',
    idempotencyKey: `idem_recut_${step}`,
    actor: { kind: 'system', service: 'prove' },
    userId,
    amount: creditMinor(500n * BigInt(step)),
    source: 'card',
  });
  if (outcome.status !== 'committed') {
    assert.fail(`the top-up at step ${step} returned ${outcome.status}`);
  }
  const wallet = outcome.transaction.links.find(
    (link) => link.account === spendable(userId),
  );
  if (wallet === undefined) {
    assert.fail(`the top-up at step ${step} advanced no chain for ${userId}`);
  }
  return { outcome, txnId: outcome.transaction.id, head: wallet.hash };
}

async function lineageTxnIds(
  provable: Provable,
  account: AccountRef,
): Promise<string[]> {
  const txnIds: string[] = [];
  for await (const link of provable.store.ledger.lineage(account)) {
    txnIds.push(link.txnId);
  }
  return txnIds;
}

/**
 * The step's chain claim, put to the edit that breaks it and nothing else.
 *
 * Until this landing `checkInvariants` read `economy.read.health()`, whose `chainIntact` is a
 * hex-shape test on each account's newest hash, and the head check below it compares stored heads
 * to the heads the committing operations reported. Neither re-derives a link, so a posting edited
 * behind an account's newest one passed the step twice over — and an engine that wrote a leg
 * differently from what it hashed is exactly that shape.
 *
 * The tamper runs on memory because memory is the only adapter with a door onto a recorded
 * posting: both SQL engines reject a raw write against `chain_links` and `legs`, which
 * test/conformance/invariants.adversarial.test.ts asserts. The replay it proves runs on all four.
 */
test('a posting edited behind a head fails the step, and only the replay catches it', async () => {
  const memory = matrix.find((adapter) => adapter.name === 'memory')!;
  const provable = await makeProvable(memory, 0x2000, freshTally());
  const account = spendable('usr_recut');
  try {
    // The positive control: the same two operations, unedited, pass every check the step makes.
    // Without it, a step that failed everything would satisfy the assertions below.
    const heads = new Map<AccountRef, string>();
    const first = await topUpOnce(provable, 'usr_recut', 1);
    assert.equal(await checkInvariants(provable, first.outcome, heads), null);
    const second = await topUpOnce(provable, 'usr_recut', 2);
    assert.equal(await checkInvariants(provable, second.outcome, heads), null);

    // Behind the head is asserted, not assumed: the wallet carries exactly these two links in
    // this order, so the edit below lands on the older one and the newest is untouched.
    assert.deepEqual(await lineageTxnIds(provable, account), [
      first.txnId,
      second.txnId,
    ]);

    recutLeg(provable.store.ledger as MemoryLedger, first.txnId, account);

    // `checkInvariants` returns the FIRST property that fails, and `chainVerifies` is the fourth
    // it asks. Reading it back means conservation, backing and overdraft all still held, so this
    // one equality is also the proof that the edit broke the chain and nothing else.
    const reported = new Map<AccountRef, string>(heads);
    const failure = await checkInvariants(provable, second.outcome, reported);
    assert.equal(failure?.invariant, 'chainVerifies');
    assert.deepEqual(Object.keys(failure!.detail).sort(), [
      'firstBreak',
      'prover',
    ]);
    assert.equal(failure!.detail.prover, 'proveEconomy');
    const broken = failure!.detail.firstBreak as ChainBreak | null;
    if (broken === null) {
      assert.fail('the step reported a broken chain and named no link');
    }
    // `actual` is the head the committing operation reported, read before the edit and untouched
    // by it, and `txnId` is the older of the two postings — a detail naming the newest link fails
    // here. The recomputed hash is the one figure no literal can pin: it is the hash of content
    // that did not exist until the edit.
    assert.deepEqual(
      {
        account: broken.account,
        txnId: broken.txnId,
        reason: broken.reason,
        actual: broken.actual,
      },
      {
        account,
        txnId: first.txnId,
        reason: 'tampered-hash',
        actual: first.head,
      },
      'the step named a link and it is not the one the edit landed on',
    );
    assert.match(broken.expected, /^[0-9a-f]{64}$/);
    assert.notEqual(broken.expected, first.head);

    // Both halves of what the step used to be, on the same book. Neither can see the edit.
    assert.equal(
      (await provable.economy.read.health()).chainIntact,
      true,
      'the light prover the step ran until this landing reported a broken chain, so this book no longer demonstrates the gap',
    );
    assert.equal(
      await headMatchesReported(provable, second.outcome, new Map(heads)),
      null,
      'the head check reported a mismatch, so it is no longer the head-identity check this test holds it to',
    );
  } finally {
    await provable.store.close();
  }
});

/**
 * The sixth check, proven able to fail. Nothing a correct backend does leaves an account whose
 * stored head is not the head its last committed operation reported, so a clean run never reaches
 * this arm — the disagreeing pair is handed to it here instead. Both directions are asserted,
 * because a check that answered `null` for every pair would satisfy only one of them.
 */
test('the head check fails on a stored head that is not the one reported', async () => {
  const memory = matrix.find((adapter) => adapter.name === 'memory')!;
  const provable = await makeProvable(memory, 0x2001, freshTally());
  const wallet = spendable('usr_head_a');
  const forged = 'f'.repeat(64);
  try {
    // Two users, so the second operation's own links cannot overwrite the first user's entry:
    // the check folds the outcome's reported heads in before it compares.
    const first = await topUpOnce(provable, 'usr_head_a', 1);
    const second = await topUpOnce(provable, 'usr_head_b', 2);

    assert.equal(
      await headMatchesReported(
        provable,
        second.outcome,
        new Map([[wallet, first.head]]),
      ),
      null,
    );
    assert.deepEqual(
      await headMatchesReported(
        provable,
        second.outcome,
        new Map([[wallet, forged]]),
      ),
      {
        invariant: 'headMatchesReported',
        detail: { account: wallet, expected: forged, actual: first.head },
      },
    );
  } finally {
    await provable.store.close();
  }
});
