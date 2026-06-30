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
 * Reports the result of one checkpoint sweep. Exactly one outcome applies: the sweep sealed a
 * checkpoint, skipped because the ledger is empty, or failed. Failures land in one of the lists
 * below.
 */
export type CheckpointSummary = {
  // The checkpoint written this run, or null when the run skipped or failed.
  sealed: Checkpoint | null;

  // True when the ledger has no accounts yet.
  skipped: boolean;

  // Holds failures that are not retried automatically, so an operator must investigate. Each entry
  // carries the error code.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Holds failures the next run retries, typically a temporary storage outage. Each entry carries
  // the error code.
  retrying: ReadonlyArray<{ code: string }>;
};

type CheckpointTally = {
  sealed: Checkpoint | null;
  skipped: boolean;
  deadLettered: Array<{ reason: string }>;
  retrying: Array<{ code: string }>;
};

/**
 * Takes one tamper-evident snapshot of the ledger and saves it. Runs as a scheduled background job.
 *
 * Collects every account's chain head and combines them into a signed Merkle root, then stores that
 * root as a checkpoint. The root changes if any account changes, so anchoring it externally later
 * proves the ledger is unaltered.
 *
 * Catches errors so one bad run cannot stop future runs. Retryable failures are left for the next
 * run, and other failures are set aside for an operator. An empty ledger is skipped rather than
 * sealing an empty snapshot.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how scheduled sweeps are driven and retried.
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

// Runs the seal and catches what it throws so one failure cannot stop future runs. Retryable errors
// such as a storage outage go to the next run. Anything else is set aside for an operator.
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

// Builds and saves the checkpoint unless the ledger is empty. `recordCheckpoint` (chain.ts)
// collects the heads, combines them into the signed root, and stores the snapshot. An empty ledger
// is skipped.
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

// Reports whether the ledger has no accounts. Stops after the first head, so it never loads the
// full list.
async function isEmpty(store: Store): Promise<boolean> {
  for await (let _head of store.ledger.heads()) {
    return false;
  }
  return true;
}

/**
 * Reports the result of one re-verification sweep. Exactly one outcome applies: there was nothing
 * to check, the latest checkpoint matched the live ledger, or it did not match because the chains
 * changed since it was sealed.
 */
export type CheckpointVerifySummary = {
  // The id of the checkpoint checked, or null when there was none.
  verified: string | null;

  // True when no checkpoint has been sealed yet.
  skipped: boolean;

  // True when the audit found tampering, a signal for an operator. A mismatch means one of three
  // things: the latest checkpoint's signed root no longer matches the live heads, the live head
  // count dropped below the sealed count because accounts were truncated or deleted, or the
  // signature failed to verify. False on a healthy match and when skipped.
  mismatch: boolean;

  // Holds failures that are not retried automatically, so an operator must investigate. A thrown
  // error such as corrupt stored hex ends the attempt here. A normal "does not match" sets
  // `mismatch` instead.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Holds failures the next run retries, typically a temporary storage outage. Each entry carries
  // the error code.
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
 * Re-checks the most recent checkpoint against the current ledger. Runs as a scheduled background
 * audit, separate from sealing. Sealing writes a snapshot, and this audit confirms the last one
 * still matches.
 *
 * Delegates to `verifyCheckpoint` (chain.ts). That function also checks that the live head count
 * has not dropped below the sealed count, which catches truncation or deletion that a check of the
 * root over current heads alone would miss. A `false` result is a normal mismatch from tampering,
 * truncation, or a stale checkpoint, so it is recorded on the summary and logged at error level
 * rather than thrown. Only a thrown error, such as a corrupt stored row or unavailable storage,
 * goes through the same retry and dead-letter split as sealing. The audit is skipped when no
 * checkpoint exists yet.
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

// Runs the re-verification and catches what it throws so one failure cannot stop future runs.
// Sorts errors like `sealOne`: retryable errors go to the next run, and others go to an operator. A
// normal mismatch does not reach here. Instead, `verifyCheckpoint` returns false and `driveVerify`
// records it as `mismatch`.
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

// Loads the latest checkpoint and verifies it against current heads. When no checkpoint exists, the
// audit is skipped. Otherwise `verifyCheckpoint` (chain.ts) returns whether the signed root still
// matches. A false result is recorded as a mismatch and logged at error level, and a true result
// leaves `mismatch` false. The checked id is recorded either way.
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
