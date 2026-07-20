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
import { balancedPosting, sweepInput } from '#test/support/sweeps.ts';

import { reverifyCheckpoint, sealCheckpoint } from '#src/worker/checkpoint.ts';
import { runSweeps } from '#src/worker/index.ts';
import { verifyCheckpoint } from '#src/chain.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';
import { fault } from '#src/errors.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import {
  makePorts,
  makeWorkerCtx,
  seededDigest,
  seededSigner,
} from '#test/support/capabilities.ts';

import type { Checkpoint, Digest, Store } from '#src/ports.ts';

// Returns the store with its digest so seal and verify hash with the same function.
async function populatedStore(): Promise<{ store: Store; digest: Digest }> {
  const digest = seededDigest(1);
  const store = memoryStore({ digest });
  await store.transaction((unit) =>
    postEntry(unit.ledger, balancedPosting('txn_seed', 'usr_a')),
  );
  return { store, digest };
}

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
  const { store, digest } = await populatedStore();

  const summary = await sealCheckpoint(store, makeWorkerCtx({ digest }));

  assert.notEqual(summary.sealed, null);
  assert.equal(summary.skipped, false);
  assert.equal(summary.sealed!.count, 2); // the user's spendable account and the revenue account
  assert.match(summary.sealed!.root, /^[0-9a-f]{64}$/);
}

async function metersSealDurationWithItsOutcome(): Promise<void> {
  const { store, digest } = await populatedStore();
  const observed: Array<{ name: string; value: number; tags?: unknown }> = [];
  const meter = {
    count: () => {},
    observe: (name: string, value: number, tags?: Record<string, string>) =>
      observed.push({ name, value, tags }),
  };

  await sealCheckpoint(store, makeWorkerCtx({ digest, meter }));
  const sealed = observed.find((o) => o.name === 'worker.checkpoint.seal_ms');
  assert.notEqual(sealed, undefined);
  assert.ok(sealed!.value >= 0);
  assert.deepEqual(sealed!.tags, { outcome: 'sealed' });

  observed.length = 0;
  const empty = memoryStore({ digest });
  await sealCheckpoint(empty, makeWorkerCtx({ digest, meter }));
  const skipped = observed.find((o) => o.name === 'worker.checkpoint.seal_ms');
  assert.deepEqual(skipped!.tags, { outcome: 'skipped' });
}

async function persistsTheSealedCheckpointThroughTheStore(): Promise<void> {
  const { store, digest } = await populatedStore();

  const summary = await sealCheckpoint(store, makeWorkerCtx({ digest }));
  const latest = await store.checkpoints.latest();

  assert.notEqual(latest, null);
  assert.equal(latest!.id, summary.sealed!.id);
  assert.equal(latest!.root, summary.sealed!.root);
}

async function sealsACheckpointThatVerifies(): Promise<void> {
  const { store, digest } = await populatedStore();
  const signer = seededSigner(1);
  const ctx = makeWorkerCtx({ digest });

  const summary = await sealCheckpoint(store, { ...ctx, signer });
  const ok = await verifyCheckpoint(
    { ledger: store.ledger, digest, signer },
    summary.sealed as Checkpoint,
  );

  assert.equal(ok, true);
}

async function reportsNoFaultOnAHealthySeal(): Promise<void> {
  const { store, digest } = await populatedStore();

  const summary = await sealCheckpoint(store, makeWorkerCtx({ digest }));

  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

// --- the fresh-ledger skip --------------------------------------------------------

async function skipsAFreshLedgerWithNoHeads(): Promise<void> {
  const digest = seededDigest(1);
  const store = memoryStore({ digest });

  const summary = await sealCheckpoint(store, makeWorkerCtx({ digest }));

  assert.equal(summary.skipped, true);
  assert.equal(summary.sealed, null);
}

async function persistsNothingWhenTheLedgerIsEmpty(): Promise<void> {
  const digest = seededDigest(1);
  const store = memoryStore({ digest });

  await sealCheckpoint(store, makeWorkerCtx({ digest }));
  const latest = await store.checkpoints.latest();

  assert.equal(latest, null);
}

// --- error handling: retry vs. set aside ------------------------------------------

async function retriesATransientStoreFault(): Promise<void> {
  const { store, digest } = await populatedStore();
  const failing = withFailingCheckpointPut(
    store,
    fault('STORE.FAILURE', 'put failed', { retryable: true }),
  );

  const summary = await sealCheckpoint(failing, makeWorkerCtx({ digest }));

  assert.equal(summary.sealed, null);
  assert.deepEqual(summary.retrying, [{ code: 'STORE.FAILURE' }]);
  assert.deepEqual(summary.deadLettered, []);
}

async function deadLettersATerminalFault(): Promise<void> {
  const { store, digest } = await populatedStore();
  const failing = withFailingCheckpointPut(
    store,
    fault('LEDGER.UNBALANCED', 'terminal', { retryable: false }),
  );

  const summary = await sealCheckpoint(failing, makeWorkerCtx({ digest }));

  assert.equal(summary.sealed, null);
  assert.deepEqual(summary.deadLettered, [{ reason: 'LEDGER.UNBALANCED' }]);
  assert.deepEqual(summary.retrying, []);
}

// Advances an account head so the live heads no longer match the sealed checkpoint. The debit
// goes to STORED_VALUE to leave the seed's REVENUE account untouched.
async function mutateLedger(store: Store, user: string): Promise<void> {
  const amount = toAmount('CREDIT', 100n);
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: `txn_mutate_${user}`,
      legs: [credit(earned(user), amount), debit(SYSTEM.STORED_VALUE, amount)],
      meta: { kind: 'test.mutate' },
    }),
  );
}

// Reports only the first `keep` heads — from both `heads` and `headSums`, as a deleted account
// would vanish from both. The root matches its own shrunken input; only the count check
// (live >= sealed) catches the deletion.
function withTruncatedHeads(store: Store, keep: number): Store {
  async function* firstN<T>(source: AsyncIterable<T>): AsyncIterable<T> {
    let seen = 0;
    for await (const row of source) {
      if (seen >= keep) {
        return;
      }
      seen += 1;
      yield row;
    }
  }
  return {
    ...store,
    ledger: {
      ...store.ledger,
      heads: () => firstN(store.ledger.heads()),
      headSums: () => firstN(store.ledger.headSums()),
    },
  };
}

// --- re-verifying the latest checkpoint -------------------------------------------

async function skipsWhenNoCheckpointHasBeenSealed(): Promise<void> {
  const { store, digest } = await populatedStore();

  const summary = await reverifyCheckpoint(store, makeWorkerCtx({ digest }));

  assert.equal(summary.skipped, true);
  assert.equal(summary.verified, null);
  assert.equal(summary.mismatch, false);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function reportsAHealthyMatchOnAnUnchangedLedger(): Promise<void> {
  const { store, digest } = await populatedStore();
  const ctx = makeWorkerCtx({ digest });
  const sealed = await sealCheckpoint(store, ctx);

  const summary = await reverifyCheckpoint(store, ctx);

  assert.equal(summary.skipped, false);
  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, false);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function flagsAMismatchAfterTheLedgerChanges(): Promise<void> {
  const { store, digest } = await populatedStore();
  const ctx = makeWorkerCtx({ digest });
  const sealed = await sealCheckpoint(store, ctx);
  await mutateLedger(store, 'usr_a');

  const summary = await reverifyCheckpoint(store, ctx);

  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, true);
  // Mismatch is a normal "doesn't match" outcome, not a thrown failure.
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function verifiesThePriorCheckpointBeforeSealingAFreshOne(): Promise<void> {
  // A checkpoint sealed this cycle would match by construction, so mismatch=true from a single
  // runSweeps call proves the verify ran against the prior checkpoint, before the fresh seal.
  const { store, digest } = await populatedStore();
  const ctx = makeWorkerCtx({ digest });
  await sealCheckpoint(store, ctx);
  await mutateLedger(store, 'usr_a');

  const batch = await runSweeps(
    store,
    makePorts(store, { digest }),
    sweepInput(),
  );

  assert.equal(batch.checkpointVerify.ok, true);
  assert.equal(
    batch.checkpointVerify.ok === true &&
      batch.checkpointVerify.summary.mismatch,
    true,
  );
  await store.close();
}

async function flagsAMismatchWhenHeadsAreTruncated(): Promise<void> {
  const { store, digest } = await populatedStore();
  const ctx = makeWorkerCtx({ digest });
  // Post the seed's exact opposite so every account's raw leg sum nets to zero on its own. The
  // seal refuses a nonzero total, so a one-account subset must itself be balanced for the
  // truncated seal below to go through.
  await store.transaction((unit) =>
    postEntry(unit.ledger, {
      txnId: 'txn_unseed',
      legs: [
        debit(spendable('usr_a'), toAmount('CREDIT', 500n)),
        credit(SYSTEM.REVENUE, toAmount('CREDIT', 500n)),
      ],
      meta: { kind: 'test', source: 'card' },
    }),
  );
  // Seal over one head, then drop to zero to simulate a deleted account. The count check
  // (live 0 < sealed 1) is what fails; the root alone would still match.
  const oneHead = withTruncatedHeads(store, 1);
  const sealed = await sealCheckpoint(oneHead, ctx);
  assert.equal(sealed.sealed!.count, 1);
  const truncated = withTruncatedHeads(store, 0);
  const real = await store.checkpoints.latest();
  const pinned: Store = {
    ...truncated,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => real,
    },
  };

  const summary = await reverifyCheckpoint(pinned, ctx);

  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, true);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function verifiesWhenTheHeadSetGrewSinceSealing(): Promise<void> {
  const { store, digest } = await populatedStore();
  const ctx = makeWorkerCtx({ digest });
  // Re-verify with the sealed count pinned to 1 so the live count (2) exceeds it. A grown head
  // set is healthy: the >= guard does not fire and the unchanged root still matches.
  const sealed = await sealCheckpoint(store, ctx);
  assert.equal(sealed.sealed!.count, 2);
  const grown: Store = {
    ...store,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => ({ ...sealed.sealed!, count: 1 }),
    },
  };

  const summary = await reverifyCheckpoint(grown, ctx);

  assert.equal(summary.verified, sealed.sealed!.id);
  assert.equal(summary.mismatch, false);
  assert.deepEqual(summary.deadLettered, []);
  assert.deepEqual(summary.retrying, []);
}

async function deadLettersACorruptCheckpointRow(): Promise<void> {
  const { store, digest } = await populatedStore();
  const ctx = makeWorkerCtx({ digest });
  await sealCheckpoint(store, ctx);
  const real = await store.checkpoints.latest();
  // A valid, matching root with a malformed signature: verification reaches the signature check,
  // where decoding the bad hex throws — a terminal fault from a corrupt row, not a mismatch.
  const corrupt: Store = {
    ...store,
    checkpoints: {
      put: store.checkpoints.put,
      latest: async () => ({ ...real!, signature: 'zzz' }),
    },
  };

  const summary = await reverifyCheckpoint(corrupt, ctx);

  assert.equal(summary.mismatch, false);
  assert.equal(summary.deadLettered.length, 1);
  assert.deepEqual(summary.retrying, []);
}

describe('Checkpoint Sweep', () => {
  test('seals a checkpoint over every account latest chain hash', () =>
    sealsACheckpointOverTheCurrentHeads());
  test('meters the seal duration with its outcome', () =>
    metersSealDurationWithItsOutcome());
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

describe('Checkpoint Anchoring', () => {
  test('publishes each sealed checkpoint to the anchor and counts it', async () => {
    const { store, digest } = await populatedStore();
    const published: Checkpoint[] = [];
    const counted: string[] = [];
    const ctx = makeWorkerCtx({
      digest,
      anchor: {
        publish: async (checkpoint) => {
          published.push(checkpoint);
        },
      },
      meter: {
        count: (name) => {
          counted.push(name);
        },
        observe: () => {},
      },
    });

    const summary = await sealCheckpoint(store, ctx);

    assert.notEqual(summary.sealed, null);
    assert.deepEqual(published, [summary.sealed]);
    assert.equal(counted.includes('worker.checkpoint.anchored'), true);
  });

  test('a failing anchor logs and counts but never blocks the seal', async () => {
    const { store, digest } = await populatedStore();
    const events: string[] = [];
    const counted: string[] = [];
    const ctx = makeWorkerCtx({
      digest,
      anchor: {
        publish: async () => {
          throw new Error('anchor endpoint down');
        },
      },
      logger: {
        log: (_level, event) => {
          events.push(event);
        },
      },
      meter: {
        count: (name) => {
          counted.push(name);
        },
        observe: () => {},
      },
    });

    const summary = await sealCheckpoint(store, ctx);

    assert.notEqual(summary.sealed, null);
    assert.equal(summary.retrying.length, 0);
    assert.equal(summary.deadLettered.length, 0);
    assert.equal(events.includes('worker.checkpoint.anchor_failed'), true);
    assert.equal(counted.includes('worker.checkpoint.anchor_failed'), true);
  });
});
