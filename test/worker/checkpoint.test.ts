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

// Deterministic capability bundle for the worker job. Takes the caller's `digest` so the seal
// hashes with the same function the ledger used at write time, so recomputed hashes match. The
// sealing job only reads digest/signer/clock/ids; the rest are stand-ins to satisfy the type.
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

// Reconciliation source that returns nothing on either side, so the reconcile sweep finds no
// records to mismatch.
function emptyFeed(): ReconcileFeed {
  return { pull: async () => ({ processor: [], ledger: [] }) };
}

// Event dispatcher that discards everything. No event is enqueued, so it is never invoked;
// present only to complete the sweep input.
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

// One balanced transaction: credit 500 to the user's spendable balance, debit the matching 500
// to platform revenue. Touches two accounts, so the ledger has two accounts to snapshot.
function balancedPosting(txnId: string, user: string): Posting {
  let amount = toAmount('CREDIT', 500n);
  return {
    txnId,
    legs: [credit(spendable(user), amount), debit(SYSTEM.REVENUE, amount)],
    meta: { kind: 'test', source: 'card' },
  };
}

// In-memory store seeded with one transaction, so the ledger has real accounts to snapshot.
// Returns the store and its hash function, so the test can pass the same one to both seal and
// verify.
async function populatedStore(): Promise<{ store: Store; digest: Digest }> {
  let digest = seededDigest(1);
  let store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_seed', 'usr_a')),
  );
  return { store, digest };
}

// Wrap a store so checkpoint put always throws the given error, leaving everything else working.
// Lets a test drive the sealing job's error handling (retry vs. set aside for an operator).
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

// An account's postings form a hash chain; its "head" is the latest hash. A checkpoint seals a
// "root" over the current heads. This appends a second balanced posting, advancing a head, so
// the live heads no longer match the earlier checkpoint and re-verification reports a mismatch.
// The debit goes to STORED_VALUE (holding account for issued credits), leaving the seed's
// REVENUE account untouched.
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

// Wrap a store so its ledger reports only the first `keep` account heads, as if the rest were
// deleted. Re-verification recomputes the root over whatever heads it sees, so a root over this
// shorter list still matches a checkpoint sealed over the same shorter list. Missing accounts
// are caught only by the separate check that live head count >= the count the checkpoint recorded.
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
  // Mismatch is a normal "doesn't match" outcome, not a thrown failure.
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function verifiesThePriorCheckpointBeforeSealingAFreshOne(): Promise<void> {
  // R2: one sweep cycle must verify the prior sealed checkpoint against the live ledger before
  // sealing a fresh one. Seal, then change the ledger so a head no longer matches the signed
  // root. runSweeps once should report checkpointVerify mismatch=true, showing the verify ran
  // against the prior checkpoint, not one sealed this cycle (which would match by construction).
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
  // Seal while the store reports one account head, then drop to zero, simulating a deleted
  // account. A root-only check never notices deletion (it matches its own shrunken input). The
  // count check catches it: it runs first and fails because live head count (0) is below the
  // count the checkpoint recorded (1).
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
  // Seal over the full two-head ledger, then re-verify with the sealed count pinned to 1, so live
  // head count (2) exceeds the sealed count. Root is unchanged so it matches, and the count guard
  // (live 2 >= sealed 1) does not fire: a grown head set is healthy, not a mismatch.
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
  // Wrap the store so the latest checkpoint keeps its valid, matching root but carries a malformed
  // signature. Ledger is unchanged, so roots match and verifyCheckpoint reaches the signature
  // check, where decoding the bad hex throws: a terminal failure (corrupt stored row), not a
  // normal mismatch.
  let corrupt: Store = {
    ...store,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => ({ ...real!, signature: 'zzz' }),
    },
  };

  let summary = await reverifyCheckpoint(corrupt, ctx);

  // The thrown error is sorted by retry verdict, like the seal path. A malformed hex decode is a
  // terminal (non-retryable) fault, so it lands in deadLettered.
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
