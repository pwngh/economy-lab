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

/** Result of one checkpoint sweep; exactly one outcome applies. */
export type CheckpointSummary = {
  sealed: Checkpoint | null;

  // True when the ledger has no accounts yet.
  skipped: boolean;

  // Not retried automatically; an operator must investigate.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Retried by the next run.
  retrying: ReadonlyArray<{ code: string }>;
};

type CheckpointTally = {
  sealed: Checkpoint | null;
  skipped: boolean;
  deadLettered: Array<{ reason: string }>;
  retrying: Array<{ code: string }>;
};

/**
 * Folds every account's chain head into one signed Merkle root and stores it as a checkpoint.
 * Errors are caught so one bad run cannot stop future runs; an empty ledger is skipped rather
 * than sealed.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for how the
 *   signed Merkle root anchors the ledger and proves it is unaltered.
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how scheduled sweeps are driven and retried.
 */
export async function sealCheckpoint(
  store: Store,
  ctx: WorkerCtx,
): Promise<CheckpointSummary> {
  const tally: CheckpointTally = {
    sealed: null,
    skipped: false,
    deadLettered: [],
    retrying: [],
  };

  const started = ctx.clock.now();
  try {
    await driveSeal(store, ctx, tally);
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
    } else {
      tally.deadLettered.push({ reason: normalized.code });
    }
  }
  // The seal re-derives every chain head, so its duration grows with the table: a rising trend
  // here is the early warning that the ledger is outgrowing the sweep.
  ctx.meter.observe('worker.checkpoint.seal_ms', ctx.clock.now() - started, {
    outcome: sealOutcome(tally),
  });

  return tally;
}

function sealOutcome(
  tally: CheckpointTally,
): 'sealed' | 'skipped' | 'retrying' | 'dead_lettered' {
  if (tally.sealed !== null) {
    return 'sealed';
  }
  if (tally.skipped) {
    return 'skipped';
  }
  return tally.retrying.length > 0 ? 'retrying' : 'dead_lettered';
}

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

async function isEmpty(store: Store): Promise<boolean> {
  for await (const _head of store.ledger.heads()) {
    return false;
  }
  return true;
}

/** Result of one re-verification sweep; exactly one outcome applies. */
export type CheckpointVerifySummary = {
  verified: string | null;

  // True when no checkpoint has been sealed yet.
  skipped: boolean;

  // True when the audit found tampering — an operator signal, not a thrown error.
  mismatch: boolean;

  // Thrown failures that are not retried; a normal "does not match" sets `mismatch` instead.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Retried by the next run.
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
 * Re-checks the most recent checkpoint against the current ledger, as a scheduled audit separate
 * from sealing. Delegates to `verifyCheckpoint` (chain.ts), which also checks the live head count
 * has not dropped below the sealed count, catching truncation a root check alone would miss. A
 * `false` result is a normal mismatch: recorded on the summary and logged at error level, not
 * thrown. Only a thrown error (corrupt row, unavailable storage) goes through the retry and
 * dead-letter split as sealing does. Skipped when no checkpoint exists yet.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for why a
 *   head-count drop is itself a tamper signal and why a mismatch is logged, not thrown.
 */
export async function reverifyCheckpoint(
  store: Store,
  ctx: WorkerCtx,
): Promise<CheckpointVerifySummary> {
  const tally: VerifyTally = {
    verified: null,
    skipped: false,
    mismatch: false,
    deadLettered: [],
    retrying: [],
  };

  try {
    await driveVerify(store, ctx, tally);
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
    } else {
      tally.deadLettered.push({ reason: normalized.code });
    }
  }

  return tally;
}

async function driveVerify(
  store: Store,
  ctx: WorkerCtx,
  tally: VerifyTally,
): Promise<void> {
  const latest = await store.checkpoints.latest();
  if (latest === null) {
    tally.skipped = true;
    return;
  }

  const ok = await verifyCheckpoint(
    { ledger: store.ledger, digest: ctx.digest, signer: ctx.signer },
    latest,
  );
  tally.verified = latest.id;
  tally.mismatch = !ok;
  if (!ok) {
    ctx.logger.log('error', 'worker.checkpoint.mismatch', { id: latest.id });
    ctx.meter.count('worker.checkpoint.verify', 1, {
      outcome: 'mismatch',
    });
    return;
  }
  // The clean verify beats too: a silent auditor and a healthy one must not look alike.
  ctx.meter.count('worker.checkpoint.verify', 1, { outcome: 'ok' });
}
