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

import { recordCheckpoint, verifySealedHistory } from '#src/chain.ts';
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
 * The sweep catches errors so one bad run cannot stop future runs. An empty ledger is skipped
 * rather than sealed.
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
  // The seal re-derives every chain head, so its duration grows with the table. A rising trend
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
  await publishAnchor(ctx, tally.sealed);
}

// Publishing is best-effort by design. The anchor is an external service, and a down anchor
// must not stop the seal. The failure log and counter tell the operator to re-anchor by hand.
async function publishAnchor(
  ctx: WorkerCtx,
  sealed: Checkpoint,
): Promise<void> {
  if (ctx.anchor === undefined) {
    return;
  }
  try {
    await ctx.anchor.publish(sealed);
    ctx.meter.count('worker.checkpoint.anchored', 1);
  } catch (error) {
    ctx.logger.log('warn', 'worker.checkpoint.anchor_failed', {
      checkpointId: sealed.id,
      code: normalizeError(error).code,
    });
    ctx.meter.count('worker.checkpoint.anchor_failed', 1);
  }
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

  // True when the store could not answer for the sealed leaves, so nothing was checked. A
  // clean `mismatch` alongside this one means "not asked", never "asked and fine".
  unverified: boolean;

  // Thrown failures that are not retried. A normal "does not match" sets `mismatch` instead.
  deadLettered: ReadonlyArray<{ reason: string }>;

  // Retried by the next run.
  retrying: ReadonlyArray<{ code: string }>;
};

type VerifyTally = {
  verified: string | null;
  skipped: boolean;
  mismatch: boolean;
  unverified: boolean;
  deadLettered: Array<{ reason: string }>;
  retrying: Array<{ code: string }>;
};

/**
 * Re-checks the most recent checkpoint against stored history, as a scheduled audit separate from
 * sealing. Delegates to `verifySealedHistory` (chain.ts), which holds the ledger against the
 * sealed leaves rather than against a root recomputed from live heads — so ordinary traffic reads
 * clean and only a change to history the seal already covered flags. A divergence is recorded on
 * the summary and logged at error level, and does not throw. Only a thrown error (corrupt row,
 * unavailable storage) goes through the retry and dead-letter split as sealing does. Skipped when
 * no checkpoint exists yet.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/integrity/ Integrity} for why a
 *   vanished account is itself a tamper signal and why a mismatch is logged, not thrown.
 */
export async function reverifyCheckpoint(
  store: Store,
  ctx: WorkerCtx,
): Promise<CheckpointVerifySummary> {
  const tally: VerifyTally = {
    verified: null,
    skipped: false,
    mismatch: false,
    unverified: false,
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

  const verdict = await verifySealedHistory(
    {
      ledger: store.ledger,
      checkpoints: store.checkpoints,
      digest: ctx.digest,
      signer: ctx.signer,
    },
    latest,
  );
  tally.verified = latest.id;
  tally.mismatch = verdict === 'diverged';
  tally.unverified = verdict === 'unverifiable';
  if (verdict === 'diverged') {
    ctx.logger.log('error', 'worker.checkpoint.mismatch', { id: latest.id });
    ctx.meter.count('worker.checkpoint.verify', 1, {
      outcome: 'mismatch',
    });
    return;
  }
  // A store that cannot answer for its sealed leaves says so on its own channel. Counting it as
  // a pass is how an auditor that checks nothing comes to look healthy.
  if (verdict === 'unverifiable') {
    ctx.logger.log('warn', 'worker.checkpoint.unverified', { id: latest.id });
    ctx.meter.count('worker.checkpoint.verify', 1, { outcome: 'unverified' });
    return;
  }
  // The passing path also emits a heartbeat, so a silent auditor never looks like a healthy one.
  ctx.meter.count('worker.checkpoint.verify', 1, { outcome: 'ok' });
}
