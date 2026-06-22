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
 * The result of one run of the checkpoint sweep. Exactly one outcome applies: a checkpoint
 * was sealed, the run was skipped because the ledger is empty, or the attempt failed and
 * was recorded in one of the two failure lists below.
 */
export type CheckpointSummary = {
  // The checkpoint that was written this run, or null if none was (skipped or failed).
  sealed: Checkpoint | null;

  // True when the run did nothing because the ledger has no accounts yet.
  skipped: boolean;

  // Failures that won't be retried automatically. Each gives the error code that ended
  // the attempt; an operator has to look into these.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Failures the next scheduled run will retry on its own — typically a temporary storage
  // outage. Each gives the error code so logs can show why.
  retrying: ReadonlyArray<{ code: string }>;
};

type CheckpointTally = {
  sealed: Checkpoint | null;
  skipped: boolean;
  deadLettered: Array<{ reason: string }>;
  retrying: Array<{ code: string }>;
};

/**
 * Take one tamper-evident snapshot of the whole ledger and save it. This is a background
 * job meant to run on a schedule.
 *
 * Each account has a running hash chain whose latest hash is its "head". This job collects
 * every account's head, combines them into a single hash (a Merkle root) that changes if
 * any account changes, signs it, and stores the signed snapshot (a checkpoint). Anchoring
 * it somewhere outside this system later lets anyone prove the ledger hasn't been altered.
 *
 * Any error is caught here so one bad run can't stop future runs. A temporary failure is
 * left for the next run to retry; any other failure is set aside for an operator. If the
 * ledger has no accounts yet, the run is skipped instead of saving an empty snapshot.
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

// Run the seal and catch anything it throws, so one failure can't stop future runs. A
// caught error is sorted once: if it's the temporary kind (marked retryable, e.g. a
// storage outage), record it for the next run to retry; otherwise set it aside for an
// operator to look into.
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

// Build and save the checkpoint, unless the ledger is empty. `recordCheckpoint` (chain.ts)
// does the actual work: it collects the heads, combines them into the signed root, and
// stores the snapshot. An empty ledger has no accounts to snapshot, so the run is skipped
// rather than saving a meaningless empty snapshot.
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

// True when the ledger has no accounts yet, meaning there's nothing to snapshot. It stops
// after seeing the first account, so it never loads the whole list just to check for one.
async function isEmpty(store: Store): Promise<boolean> {
  for await (let _head of store.ledger.heads()) {
    return false;
  }
  return true;
}

/**
 * The result of one run of the re-verification sweep. Exactly one outcome applies: there was
 * no checkpoint to check, the latest checkpoint was checked and matched the live ledger, or
 * it was checked and did NOT match (the chains have changed since it was sealed).
 */
export type CheckpointVerifySummary = {
  // The id of the checkpoint that was checked, or null when there was none to check yet.
  verified: string | null;

  // True when the run did nothing because no checkpoint has been sealed yet.
  skipped: boolean;

  // True when the latest checkpoint's signed root no longer matches the live ledger's heads,
  // the live head count dropped below the sealed count (accounts were truncated/deleted), or
  // its signature didn't verify — a tamper signal an operator must look into. False on a
  // healthy match (and also false when skipped).
  mismatch: boolean;

  // Failures that won't be retried automatically. A thrown error (e.g. corrupt stored hex)
  // ends the attempt here; an operator has to look into these. A normal "doesn't match"
  // outcome is NOT a failure — it sets `mismatch` instead.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Failures the next scheduled run will retry on its own — typically a temporary storage
  // outage. Each gives the error code so logs can show why.
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
 * Re-check the most recent checkpoint against the ledger as it stands now. This is a
 * background audit meant to run on a schedule, separate from sealing: sealing writes a fresh
 * snapshot, this one confirms the last snapshot still matches the live data.
 *
 * It loads the latest checkpoint and re-derives the Merkle root over the current account
 * heads (via `verifyCheckpoint` in chain.ts), comparing it to the signed root in the
 * checkpoint, checking the live head count has not dropped below the sealed count (which
 * catches truncation/deletion a root-over-current-heads check alone would miss), and
 * confirming the signature. A `false` result is a NORMAL mismatch — the ledger has diverged
 * from what was sealed (tampering, truncation, or a checkpoint that was never refreshed) — so
 * it is recorded on the summary (and logged at error level), not thrown. Only a thrown error,
 * meaning the stored row itself is corrupt or storage is unavailable, is sorted into the same
 * retry/dead-letter split that sealing uses. If no checkpoint has been sealed yet, the run is
 * skipped.
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

// Run the re-verification and catch anything it throws, so one failure can't stop future
// runs. A caught error is sorted exactly like `sealOne`: the temporary kind (marked
// retryable) is recorded for the next run to retry; any other error is set aside for an
// operator. A normal mismatch does NOT come through here — `verifyCheckpoint` returns false
// for that rather than throwing, and `driveVerify` records it as `mismatch`.
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

// Load the latest checkpoint and verify it against the current heads. With no checkpoint yet,
// the run is skipped. Otherwise `verifyCheckpoint` (chain.ts) returns whether the signed root
// still matches the live ledger; a false result is recorded as a mismatch and logged at error
// level so an operator notices, while a true result leaves `mismatch` false. Either way the
// checked checkpoint's id is recorded.
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
