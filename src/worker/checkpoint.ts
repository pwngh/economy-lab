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

import { recordCheckpoint, verifyCheckpoint } from '#src/chain.ts';
import { normalizeError } from '#src/errors.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { Checkpoint, Store } from '#src/ports.ts';

/**
 * Result of one checkpoint sweep. One outcome applies: sealed a checkpoint, skipped (empty
 * ledger), or failed (recorded in a failure list below).
 */
export type CheckpointSummary = {
  // Checkpoint written this run, or null (skipped or failed).
  sealed: Checkpoint | null;

  // True when the ledger has no accounts yet.
  skipped: boolean;

  // Failures not retried automatically; operator must investigate. Each carries the error code.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Failures the next run retries (typically a temporary storage outage). Each carries the code.
  retrying: ReadonlyArray<{ code: string }>;
};

type CheckpointTally = {
  sealed: Checkpoint | null;
  skipped: boolean;
  deadLettered: Array<{ reason: string }>;
  retrying: Array<{ code: string }>;
};

/**
 * Take one tamper-evident snapshot of the ledger and save it. Scheduled background job.
 *
 * Each account has a hash chain whose latest hash is its "head". Collects every head, combines
 * them into a Merkle root (changes if any account changes), signs it, and stores the signed
 * snapshot (checkpoint). Anchoring that root externally later proves the ledger is unaltered.
 *
 * Errors are caught so one bad run can't stop future runs: retryable failures are left for the
 * next run, others are set aside for an operator. An empty ledger is skipped rather than sealing
 * an empty snapshot.
 */
export async function sealCheckpoint(
  store: Store,
  ctx: WorkerCtx,
): Promise<CheckpointSummary> {
  let tally: CheckpointTally = {
    sealed: null,
    skipped: false,
    deadLettered: [],
    retrying: [],
  };

  await sealOne(store, ctx, tally);

  return tally;
}

// Run the seal and catch what it throws so one failure can't stop future runs. Retryable errors
// (e.g. storage outage) go to the next run; anything else is set aside for an operator.
async function sealOne(
  store: Store,
  ctx: WorkerCtx,
  tally: CheckpointTally,
): Promise<void> {
  try {
    await driveSeal(store, ctx, tally);
  } catch (error) {
    let normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
      return;
    }
    tally.deadLettered.push({ reason: normalized.code });
  }
}

// Build and save the checkpoint unless the ledger is empty. `recordCheckpoint` (chain.ts) collects
// the heads, combines them into the signed root, and stores the snapshot. Empty ledger → skip.
async function driveSeal(
  store: Store,
  ctx: WorkerCtx,
  tally: CheckpointTally,
): Promise<void> {
  if (await isEmpty(store)) {
    tally.skipped = true;
    return;
  }

  tally.sealed = await recordCheckpoint({
    ledger: store.ledger,
    checkpoints: store.checkpoints,
    digest: ctx.digest,
    signer: ctx.signer,
    clock: ctx.clock,
    ids: ctx.ids,
  });
}

// True when the ledger has no accounts. Stops after the first head, so it never loads the full list.
async function isEmpty(store: Store): Promise<boolean> {
  for await (let _head of store.ledger.heads()) {
    return false;
  }
  return true;
}

/**
 * Result of one re-verification sweep. One outcome applies: nothing to check, the latest
 * checkpoint matched the live ledger, or it did not match (chains changed since it was sealed).
 */
export type CheckpointVerifySummary = {
  // Id of the checkpoint checked, or null when there was none.
  verified: string | null;

  // True when no checkpoint has been sealed yet.
  skipped: boolean;

  // True when the latest checkpoint's signed root no longer matches the live heads, the live head
  // count dropped below the sealed count (accounts truncated/deleted), or its signature failed to
  // verify, a tamper signal for an operator. False on a healthy match (and when skipped).
  mismatch: boolean;

  // Failures not retried automatically; operator must investigate. A thrown error (e.g. corrupt
  // stored hex) ends the attempt here. A normal "doesn't match" sets `mismatch` instead.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Failures the next run retries (typically a temporary storage outage). Each carries the code.
  retrying: ReadonlyArray<{ code: string }>;
};

type VerifyTally = {
  verified: string | null;
  skipped: boolean;
  mismatch: boolean;
  deadLettered: Array<{ reason: string }>;
  retrying: Array<{ code: string }>;
};

/**
 * Re-check the most recent checkpoint against the current ledger. Scheduled background audit,
 * separate from sealing: sealing writes a snapshot, this confirms the last one still matches.
 *
 * Loads the latest checkpoint and re-derives the Merkle root over current heads (via
 * `verifyCheckpoint` in chain.ts), comparing it to the signed root, checking the live head count
 * hasn't dropped below the sealed count (catches truncation/deletion a root-over-current-heads
 * check alone would miss), and confirming the signature. A `false` result is a normal mismatch
 * (tampering, truncation, or a stale checkpoint), so it's recorded on the summary and logged at
 * error level, not thrown. Only a thrown error (corrupt stored row, storage unavailable) goes
 * through the same retry/dead-letter split as sealing. Skipped if no checkpoint exists yet.
 */
export async function reverifyCheckpoint(
  store: Store,
  ctx: WorkerCtx,
): Promise<CheckpointVerifySummary> {
  let tally: VerifyTally = {
    verified: null,
    skipped: false,
    mismatch: false,
    deadLettered: [],
    retrying: [],
  };

  await verifyOne(store, ctx, tally);

  return tally;
}

// Run the re-verification and catch what it throws so one failure can't stop future runs. Sorted
// like `sealOne`: retryable errors go to the next run, others to an operator. A normal mismatch
// doesn't reach here, `verifyCheckpoint` returns false and `driveVerify` records it as `mismatch`.
async function verifyOne(
  store: Store,
  ctx: WorkerCtx,
  tally: VerifyTally,
): Promise<void> {
  try {
    await driveVerify(store, ctx, tally);
  } catch (error) {
    let normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
      return;
    }
    tally.deadLettered.push({ reason: normalized.code });
  }
}

// Load the latest checkpoint and verify it against current heads. No checkpoint → skip. Otherwise
// `verifyCheckpoint` (chain.ts) returns whether the signed root still matches; false is recorded as
// a mismatch and logged at error level, true leaves `mismatch` false. The checked id is recorded
// either way.
async function driveVerify(
  store: Store,
  ctx: WorkerCtx,
  tally: VerifyTally,
): Promise<void> {
  let latest = await store.checkpoints.latest();
  if (latest === null) {
    tally.skipped = true;
    return;
  }

  let ok = await verifyCheckpoint(
    { ledger: store.ledger, digest: ctx.digest, signer: ctx.signer },
    latest,
  );
  tally.verified = latest.id;
  tally.mismatch = !ok;
  if (!ok) {
    ctx.logger.log('error', 'worker.checkpoint.mismatch', { id: latest.id });
    ctx.meter.count('economy.worker.checkpoint.verify', 1, {
      outcome: 'mismatch',
    });
  }
}
