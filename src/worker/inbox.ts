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

import { normalizeError } from '#src/errors.ts';

import type { Economy, Outcome, WorkerCtx } from '#src/contract.ts';
import type { InboxEntry, Options, Store } from '#src/ports.ts';

/**
 * Result of one inbox-apply run, the inbound mirror of {@link RelaySummary}.
 * - `applied`: ids that committed (or deduped to an already-applied result); the row is marked
 *   'applied' so it is not re-claimed.
 * - `failed`: ids whose apply threw a retryable fault under the cap; row stays 'pending', `attempts`
 *   bumped, retried next run. Carries error code and `retryable` for metrics.
 * - `deadLettered`: ids that hit the attempt cap (`config.maxInboxAttempts`) or were declined for a
 *   terminal business reason (a `rejected` Outcome). Row set to 'dead' and never re-claimed, so a
 *   poison event cannot block the events behind it. Carries event id and `reason`.
 */
export type InboxSummary = {
  applied: ReadonlyArray<string>;
  failed: ReadonlyArray<{ id: string; code: string; retryable: boolean }>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
};

// The mutable version of InboxSummary that the run fills in as it goes.
type InboxTally = {
  applied: string[];
  failed: Array<{ id: string; code: string; retryable: boolean }>;
  deadLettered: Array<{ id: string; reason: string }>;
};

// The capability one apply needs to submit a stored Operation. This is the normal economy path, so
// the money move runs through the same invariants and idempotency a direct caller would hit. It is
// narrowed to `submit` alone rather than the full Economy because that is all the apply touches. Any
// Economy satisfies it.
type Applier = Pick<Economy, 'submit'>;

/**
 * Applies a batch of pending inbox events. Each row holds a verified inbound provider event already
 * mapped to the {@link Operation} it applies (a topUp, a clawback). Claims up to `limit` rows,
 * submits each through the economy, and marks the committed ones so they are not re-claimed.
 *
 * Never gated on the economy pause: settlements must keep flowing through a maintenance window, and
 * settlement carries actor 'system', which the pause gate exempts anyway. Each event applies in its
 * own try/catch, so one failure cannot stop the batch and an apply can run more than once (submit
 * committed but `markApplied` did not). Exactly-once rests on the stored Operation's idempotencyKey
 * (the provider event id the row deduped on): a re-apply resolves to a `duplicate` Outcome.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how inbox draining fits the sweep loop.
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/idempotency/ Idempotency} for the idempotencyKey dedupe.
 */
export async function drainInbox(
  store: Store,
  ctx: WorkerCtx,
  input: { economy: Applier; now: number; limit: number },
  options?: Options,
): Promise<InboxSummary> {
  let pending = await store.inbox.claimInbound(
    { now: input.now, limit: input.limit },
    options,
  );
  let tally: InboxTally = { applied: [], failed: [], deadLettered: [] };

  for (let entry of pending) {
    await applyOne(
      store,
      ctx,
      { economy: input.economy, entry, options },
      tally,
    );
  }

  return tally;
}

// Submits one stored Operation and records the outcome in the tally. A committed or duplicate
// Outcome marks the row 'applied'. A `rejected` Outcome is a terminal business "no" (e.g.
// INSUFFICIENT_FUNDS) that retrying cannot fix, so it dead-letters the row rather than retrying the
// same apply that will fail every sweep. A thrown fault is the retryable case and goes to `recordFailure`,
// which bumps-and-retries or dead-letters at the cap rather than re-throwing.
async function applyOne(
  store: Store,
  ctx: WorkerCtx,
  work: { economy: Applier; entry: InboxEntry; options?: Options },
  tally: InboxTally,
): Promise<void> {
  let { economy, entry, options } = work;
  let outcome: Outcome;
  try {
    outcome = await economy.submit(entry.operation, options);
  } catch (error) {
    await recordFailure(
      store,
      ctx,
      { entry, normalized: normalizeError(error), options },
      tally,
    );
    return;
  }

  if (outcome.status === 'rejected') {
    // A declined but well-formed request: a normal "no" the economy returns as data, not a fault.
    // It is terminal for this row, because the same Operation will be declined the same way on every
    // retry, so dead-letter it rather than burning attempts. The reason code stands in for the
    // failure code so operators see why it parked.
    ctx.logger.log('warn', 'inbox.apply.rejected', {
      entryId: entry.id,
      reason: outcome.reason,
    });
    await store.inbox.deadLetter(entry.id, outcome.reason, options);
    tally.deadLettered.push({ id: entry.id, reason: outcome.reason });
    return;
  }

  // committed or duplicate: the money move is in the ledger, either from this run or from a prior run
  // whose markApplied did not land (the idempotencyKey deduped it). Mark the row applied so it is not
  // re-claimed. markApplied no-ops on an already-terminal row, so a double apply is harmless.
  await store.inbox.markApplied(entry.id, options);
  tally.applied.push(entry.id);
}

// Persists a thrown, retryable apply failure and bounds retries by the stored attempt count
// (`entry.attempts + 1`). At the cap the row dead-letters (status 'dead' so `claimInbound` won't
// hand it back), keeping a poison event from wedging the queue. Below the cap, `bumpAttempt` raises
// `attempts`, the row stays 'pending', and the next run retries it.
//
// The cap is `>=`, so the default `maxInboxAttempts` of 10 dead-letters on the 10th failure (the one
// that takes `attempts` to 10). Same off-by-one as the outbox's `dispatchOne`; stated at both so
// every adapter only has to agree on the stored count.
async function recordFailure(
  store: Store,
  ctx: WorkerCtx,
  work: {
    entry: InboxEntry;
    normalized: ReturnType<typeof normalizeError>;
    options?: Options;
  },
  tally: InboxTally,
): Promise<void> {
  let { entry, normalized, options } = work;
  let next = entry.attempts + 1;
  if (next >= ctx.config.maxInboxAttempts) {
    ctx.logger.log('error', 'inbox.apply.deadLettered', {
      entryId: entry.id,
      code: normalized.code,
      attempts: next,
    });
    await store.inbox.deadLetter(entry.id, normalized.code, options);
    tally.deadLettered.push({ id: entry.id, reason: normalized.code });
    return;
  }
  ctx.logger.log('warn', 'inbox.apply.failed', {
    entryId: entry.id,
    code: normalized.code,
    retryable: normalized.retryable,
    attempts: next,
  });
  await store.inbox.bumpAttempt(entry.id, options);
  tally.failed.push({
    id: entry.id,
    code: normalized.code,
    retryable: normalized.retryable,
  });
}
