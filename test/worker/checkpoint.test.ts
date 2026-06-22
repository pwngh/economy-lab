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

import { reverifyCheckpoint, sealCheckpoint } from '#src/worker/checkpoint.ts';
import { runSweeps } from '#src/worker/index.ts';
import { verifyCheckpoint } from '#src/chain.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { fault } from '#src/errors.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import {
  fixedClock,
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  testConfig,
} from '#test/support/capabilities.ts';

import type { SweepInput } from '#src/worker/index.ts';
import type { ReconcileFeed } from '#src/worker/reconcile.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type {
  Checkpoint,
  Digest,
  Dispatcher,
  Posting,
  Store,
} from '#src/ports.ts';

// Build the capability bundle (clock, id generator, hashing, signing, etc.) that the worker
// job needs. Every capability here is deterministic: given the same inputs it always produces
// the same output, so the test is repeatable. It takes the caller's `digest` (the hash
// function) as an argument so the seal hashes with the exact same function the ledger used when
// the data was written, and the recomputed hashes will match. The sealing job only reads
// digest/signer/clock/ids; the others are unused stand-ins, included so the bundle has every
// field its type requires.
function workerCtx(digest: Digest): WorkerCtx {
  return {
    clock: fixedClock(0),
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

// A reconciliation source that returns nothing on either side, so the reconcile sweep runs to
// a clean result with no records to mismatch.
function emptyFeed(): ReconcileFeed {
  return { pull: async () => ({ processor: [], ledger: [] }) };
}

// An event dispatcher that discards every event; no event is enqueued here so it is never
// actually invoked. Present only to complete the sweep input.
function nullDispatcher(): Dispatcher {
  return async () => {};
}

// The full argument bundle the runner passes to every sweep. Callers can override any field.
function sweepInput(overrides?: Partial<SweepInput>): SweepInput {
  return {
    now: 1_000,
    limit: 10,
    dispatcher: nullDispatcher(),
    feed: emptyFeed(),
    windows: [{ from: 0, to: 1_000 }],
    ...overrides,
  };
}

// Build one balanced transaction: add 500 to the user's spendable balance and record the
// matching 500 against the platform's revenue account. Because it touches two different
// accounts, the ledger ends up with two accounts to snapshot.
function balancedPosting(txnId: string, user: string): Posting {
  let amount = toAmount('CREDIT', 500n);
  return {
    txnId,
    legs: [credit(spendable(user), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}

// Set up an in-memory store that already has one transaction in it, so the ledger has real
// accounts for the sealing job to snapshot. Returns the store along with the hash function it
// was built with, so the test can hand the same one to both the seal and the later verify
// step.
async function populatedStore(): Promise<{ store: Store; digest: Digest }> {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_seed', 'usr_a')),
  );
  return { store, digest };
}

// Wrap a store so that saving a checkpoint always throws the given error, while everything
// else about the store keeps working. This lets a test drive the sealing job's error handling
// (which decides whether a failure should be retried later or set aside for an operator)
// without breaking the rest of the in-memory store.
function withFailingCheckpointPut(store: Store, error: Error): Store {
  return {
    ...store,
    checkpoints: {
      put: async () => {
        throw error;
      },
      latest: store.checkpoints.latest,
    },
  };
}

// --- sealing the checkpoint -------------------------------------------------------

async function sealsACheckpointOverTheCurrentHeads(): Promise<void> {
  let { store, digest } = await populatedStore();

  let summary = await sealCheckpoint(store, workerCtx(digest));

  assert.notEqual(summary.sealed, null);
  assert.equal(summary.skipped, false);
  assert.equal(summary.sealed!.count, 2); // the user's spendable account and the revenue account
  assert.match(summary.sealed!.root, /^[0-9a-f]{64}$/);
}

async function persistsTheSealedCheckpointThroughTheStore(): Promise<void> {
  let { store, digest } = await populatedStore();

  let summary = await sealCheckpoint(store, workerCtx(digest));
  let latest = await store.checkpoints.latest();

  assert.notEqual(latest, null);
  assert.equal(latest!.id, summary.sealed!.id);
  assert.equal(latest!.root, summary.sealed!.root);
}

async function sealsACheckpointThatVerifies(): Promise<void> {
  let { store, digest } = await populatedStore();
  let signer = seededSigner(1);
  let ctx = workerCtx(digest);

  let summary = await sealCheckpoint(store, { ...ctx, signer });
  let ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer },
    summary.sealed as Checkpoint,
  );

  assert.equal(ok, true);
}

async function reportsNoFaultOnAHealthySeal(): Promise<void> {
  let { store, digest } = await populatedStore();

  let summary = await sealCheckpoint(store, workerCtx(digest));

  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

// --- the fresh-ledger skip --------------------------------------------------------

async function skipsAFreshLedgerWithNoHeads(): Promise<void> {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });

  let summary = await sealCheckpoint(store, workerCtx(digest));

  assert.equal(summary.skipped, true);
  assert.equal(summary.sealed, null);
}

async function persistsNothingWhenTheLedgerIsEmpty(): Promise<void> {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });

  await sealCheckpoint(store, workerCtx(digest));
  let latest = await store.checkpoints.latest();

  assert.equal(latest, null);
}

// --- error handling: retry vs. set aside ------------------------------------------

async function retriesATransientStoreFault(): Promise<void> {
  let { store, digest } = await populatedStore();
  let failing = withFailingCheckpointPut(
    store,
    fault('STORE.FAILURE', 'put failed', { retryable: true }),
  );

  let summary = await sealCheckpoint(failing, workerCtx(digest));

  assert.equal(summary.sealed, null);
  assert.deepEqual(summary.retrying, [{ code: 'STORE.FAILURE' }]);
  assert.deepEqual(summary.deadLettered, []);
}

async function deadLettersATerminalFault(): Promise<void> {
  let { store, digest } = await populatedStore();
  let failing = withFailingCheckpointPut(
    store,
    fault('LEDGER.UNBALANCED', 'terminal', { retryable: false }),
  );

  let summary = await sealCheckpoint(failing, workerCtx(digest));

  assert.equal(summary.sealed, null);
  assert.deepEqual(summary.deadLettered, [{ reason: 'LEDGER.UNBALANCED' }]);
  assert.deepEqual(summary.retrying, []);
}

// Each account's postings are linked into a hash chain; an account's "head" is the most
// recent hash in that chain. A checkpoint seals a summary hash (its "root") over the current
// set of heads. This appends a second balanced posting, which advances a head, so the live
// heads no longer match what the earlier checkpoint sealed and re-verification must report a
// mismatch. The matching debit goes to STORED_VALUE (the platform's holding account for issued
// credits) so the seed's REVENUE account is left untouched.
async function mutateLedger(store: Store, user: string): Promise<void> {
  let amount = toAmount('CREDIT', 100n);
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: `txn_mutate_${user}`,
      legs: [credit(earned(user), amount), debit(SYSTEM.STORED_VALUE, amount)],
      meta: { kind: 'test.mutate' },
    }),
  );
}

// Wrap a store so its ledger reports only the first `keep` account heads (the latest hash of
// each account's chain), as if the rest were deleted. Everything else about the store keeps
// working. Re-verification recomputes the summary root over whatever heads it sees, so a root
// computed over this shorter list would still match a checkpoint that was sealed over the same
// shorter list. The only thing that catches the missing accounts is the separate check that
// the live head count is at least the count the checkpoint recorded.
function withTruncatedHeads(store: Store, keep: number): Store {
  return {
    ...store,
    ledger: {
      ...store.ledger,
      heads: async function* () {
        let seen = 0;
        for await (let pair of store.ledger.heads()) {
          if (seen >= keep) {
            return;
          }
          seen += 1;
          yield pair;
        }
      },
    },
  };
}

// --- re-verifying the latest checkpoint -------------------------------------------

async function skipsWhenNoCheckpointHasBeenSealed(): Promise<void> {
  let { store, digest } = await populatedStore();

  let summary = await reverifyCheckpoint(store, workerCtx(digest));

  assert.equal(summary.skipped, true);
  assert.equal(summary.verified, null);
  assert.equal(summary.mismatch, false);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function reportsAHealthyMatchOnAnUnchangedLedger(): Promise<void> {
  let { store, digest } = await populatedStore();
  let ctx = workerCtx(digest);
  let sealed = await sealCheckpoint(store, ctx);

  let summary = await reverifyCheckpoint(store, ctx);

  assert.equal(summary.skipped, false);
  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, false);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function flagsAMismatchAfterTheLedgerChanges(): Promise<void> {
  let { store, digest } = await populatedStore();
  let ctx = workerCtx(digest);
  let sealed = await sealCheckpoint(store, ctx);
  // Change the ledger after sealing: the live heads no longer match the signed root.
  await mutateLedger(store, 'usr_a');

  let summary = await reverifyCheckpoint(store, ctx);

  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, true);
  // A mismatch is a normal "doesn't match" outcome, not a thrown failure.
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function verifiesThePriorCheckpointBeforeSealingAFreshOne(): Promise<void> {
  // R2: one full sweep cycle must verify the PRIOR sealed checkpoint against the live ledger
  // BEFORE sealing a fresh one. Seal a checkpoint, then change the ledger so a head no longer
  // matches the signed root. Running runSweeps once must report checkpointVerify mismatch=true
  // — proof the verify ran against the prior checkpoint and caught the divergence, not against
  // a checkpoint just sealed this cycle (which would match by construction).
  let { store, digest } = await populatedStore();
  let ctx = workerCtx(digest);
  await sealCheckpoint(store, ctx);
  await mutateLedger(store, 'usr_a');

  let batch = await runSweeps(store, ctx, sweepInput());

  assert.equal(batch.checkpointVerify.ok, true);
  assert.equal(
    batch.checkpointVerify.ok === true &&
      batch.checkpointVerify.summary.mismatch,
    true,
  );
  await store.close();
}

async function flagsAMismatchWhenHeadsAreTruncated(): Promise<void> {
  let { store, digest } = await populatedStore();
  let ctx = workerCtx(digest);
  // Seal a checkpoint while the store reports only one account head, then drop to reporting
  // zero, simulating a deleted account. Re-verification recomputes the summary root over
  // whatever heads it sees, so a root-only check can never notice deletion: it would just match
  // its own shrunken input. What catches the missing account is the separate count check, which
  // runs first and fails because the live head count (0) is below the count the checkpoint
  // recorded (1).
  let oneHead = withTruncatedHeads(store, 1);
  let sealed = await sealCheckpoint(oneHead, ctx);
  assert.equal(sealed.sealed!.count, 1);
  let truncated = withTruncatedHeads(store, 0);
  let real = await store.checkpoints.latest();
  let pinned: Store = {
    ...truncated,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => real,
    },
  };

  let summary = await reverifyCheckpoint(pinned, ctx);

  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, true);
  // Truncation is a normal "doesn't match" tamper signal, not a thrown failure.
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function verifiesWhenTheHeadSetGrewSinceSealing(): Promise<void> {
  let { store, digest } = await populatedStore();
  let ctx = workerCtx(digest);
  // Seal over the full two-head ledger, then re-verify with the sealed count pinned to 1, so the
  // live head count (2) is GREATER than the sealed count. The root is unchanged so it matches,
  // and the count guard (live 2 >= sealed 1) does not fire — proof that a grown head set is
  // healthy, not flagged as a mismatch.
  let sealed = await sealCheckpoint(store, ctx);
  assert.equal(sealed.sealed!.count, 2);
  let grown: Store = {
    ...store,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => ({ ...sealed.sealed!, count: 1 }),
    },
  };

  let summary = await reverifyCheckpoint(grown, ctx);

  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, false);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function deadLettersACorruptCheckpointRow(): Promise<void> {
  let { store, digest } = await populatedStore();
  let ctx = workerCtx(digest);
  await sealCheckpoint(store, ctx);
  let real = await store.checkpoints.latest();
  // Wrap the store so the latest checkpoint keeps its (valid, matching) root but carries a
  // malformed signature. The ledger is unchanged, so the roots match and verifyCheckpoint
  // reaches the signature check, where decoding the bad hex throws — a terminal failure
  // (a corrupt stored row), not a normal mismatch.
  let corrupt: Store = {
    ...store,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => ({ ...real!, signature: 'zzz' }),
    },
  };

  let summary = await reverifyCheckpoint(corrupt, ctx);

  // The thrown error is sorted by its retry verdict, exactly like the seal path. A malformed
  // hex decode is a terminal (non-retryable) fault, so it lands in deadLettered.
  assert.equal(summary.mismatch, false);
  assert.equal(summary.deadLettered.length, 1);
  assert.deepEqual(summary.retrying, []);
}

describe('Checkpoint Sweep', () => {
  test('seals a checkpoint over every account latest chain hash', () =>
    sealsACheckpointOverTheCurrentHeads());
  test('persists the sealed checkpoint through the store', () =>
    persistsTheSealedCheckpointThroughTheStore());
  test('seals a checkpoint that verifies', () =>
    sealsACheckpointThatVerifies());
  test('reports no fault on a healthy seal', () =>
    reportsNoFaultOnAHealthySeal());

  test('skips a fresh ledger with no accounts', () =>
    skipsAFreshLedgerWithNoHeads());
  test('persists nothing when the ledger is empty', () =>
    persistsNothingWhenTheLedgerIsEmpty());

  test('retries a transient store fault', () => retriesATransientStoreFault());
  test('dead-letters a terminal fault', () => deadLettersATerminalFault());

  test('re-verify skips when no checkpoint has been sealed', () =>
    skipsWhenNoCheckpointHasBeenSealed());
  test('re-verify reports a healthy match on an unchanged ledger', () =>
    reportsAHealthyMatchOnAnUnchangedLedger());
  test('re-verify flags a mismatch after the ledger changes', () =>
    flagsAMismatchAfterTheLedgerChanges());
  test('re-verify flags a mismatch when an account goes missing', () =>
    flagsAMismatchWhenHeadsAreTruncated());
  test('re-verify still verifies when accounts were added since sealing', () =>
    verifiesWhenTheHeadSetGrewSinceSealing());
  test('verifies the prior checkpoint before sealing a fresh one in one cycle', () =>
    verifiesThePriorCheckpointBeforeSealingAFreshOne());
  test('re-verify dead-letters a corrupt checkpoint row', () =>
    deadLettersACorruptCheckpointRow());
});
