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
 * Result of one inbox-apply run. The inbound mirror of {@link RelaySummary}: where the relay
 * delivers committed money moves outward, this applies received events inward.
 * - `applied`: ids whose stored Operation submitted and committed (or deduped to an already-applied
 *   result), marked 'applied' this run so they aren't re-claimed.
 * - `failed`: applying threw a retryable fault but the row is still under the attempt cap; each
 *   carries the error code and `retryable` flag (for caller metrics). Left 'pending' with `attempts`
 *   bumped, retried next run.
 * - `deadLettered`: hit the attempt cap (`config.maxInboxAttempts`) on a retryable fault, or was
 *   declined for a terminal business reason that retrying can't fix (a `rejected` Outcome). Set to
 *   'dead', never re-claimed, so a poison event can't block events behind it. Each carries the event
 *   id and the error/reason code (`reason`) — same id+reason shape the other background sweeps use.
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

// The capability one apply needs to submit a stored Operation: the normal economy path, so the
// money move runs through the same invariants and idempotency a direct caller would hit. Narrowed to
// `submit` alone (rather than the full Economy) because that's all the apply touches; any Economy
// satisfies it.
type Applier = Pick<Economy, 'submit'>;

/**
 * Applies a batch of pending inbox events. Each row holds a verified inbound provider event already
 * mapped to the {@link Operation} it should apply (a topUp, a clawback, …), enqueued in the same
 * transaction as the webhook ingress that claimed it. Claims up to `limit`, submits each through the
 * economy, and marks the ones that committed so they aren't re-claimed.
 *
 * Runs CONTINUOUSLY: unlike an end-user write, draining the inbox is NEVER gated on the economy pause
 * (`economyPaused`). The inbox's job is to keep settlements flowing and decouple provider latency, so
 * a maintenance window that refuses discretionary user writes must not also stall money the provider
 * already confirmed. (Settlement carries actor 'system', which the pause gate exempts anyway, so a
 * stored topUp/clawback isn't declined as ECONOMY_PAUSED when it reaches the economy.)
 *
 * Each event is applied in its own try/catch, so one failure can't stop the batch; a failed event is
 * left 'pending' and retried next run. An apply can therefore run more than once (e.g. submit
 * committed but `markApplied` did not), so exactly-once rests on the stored Operation's
 * idempotencyKey — the provider event id, the same value the row deduped on — which makes a re-apply
 * resolve to the same money move (a `duplicate` Outcome) rather than a second posting.
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

// Submits one stored Operation and records the outcome in the tally. On a committed/duplicate
// Outcome the row is marked 'applied' and its id goes to `applied`. A `rejected` Outcome (a terminal
// business "no" like INSUFFICIENT_FUNDS that retrying can't fix) dead-letters the row, since leaving
// it 'pending' would retry the same doomed apply every sweep. A thrown fault is the retryable case
// and goes to `recordFailure`, which bumps-and-retries or dead-letters at the cap; the failure is
// persisted there (not re-thrown) so the batch keeps going.
//
// `relayOutbox` inlines its failure handling in one catch; the inbox splits it out because this
// function already owns the `rejected`-Outcome dead-letter path, and keeping the thrown-fault path
// in its own helper keeps both readable.
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
    // A declined-but-well-formed request: a normal "no" the economy returns as data, not a fault.
    // It's terminal for this row — the same Operation will be declined the same way on every retry —
    // so dead-letter it rather than burning attempts. The reason code stands in for the failure
    // code so operators see why it parked.
    ctx.logger.log('warn', 'inbox.apply.rejected', {
      entryId: entry.id,
      reason: outcome.reason,
    });
    await store.inbox.deadLetter(entry.id, outcome.reason, options);
    tally.deadLettered.push({ id: entry.id, reason: outcome.reason });
    return;
  }

  // committed or duplicate: the money move is in the ledger (this run, or a prior run whose
  // markApplied didn't land — the idempotencyKey deduped it). Mark the row applied so it's not
  // re-claimed. markApplied no-ops on an already-terminal row, so a double apply is harmless.
  await store.inbox.markApplied(entry.id, options);
  tally.applied.push(entry.id);
}

// Persists a thrown (retryable) apply failure, bounding retries by the stored attempt count. This
// failure makes the row's count `entry.attempts + 1`; at the cap the row is dead-lettered (status
// 'dead' so `claimInbound` won't hand it back) and recorded in `deadLettered`, keeping a poison
// event from wedging the queue. Otherwise `bumpAttempt` raises `attempts` (row stays 'pending'), the
// event lands in `failed`, and the next run retries it.
//
// Cap is `>=` so the default `maxInboxAttempts` of 10 dead-letters on the 10th failure (the one that
// takes `attempts` to 10). Same off-by-one as the outbox's `dispatchOne`, stated at both so every
// adapter only has to agree on the stored count.
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
