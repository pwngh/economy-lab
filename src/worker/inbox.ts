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

import { normalizePortError, normalizeError } from '#src/errors.ts';

import type { Economy, Outcome, WorkerCtx } from '#src/contract.ts';
import type { InboxEntry, Options, Store } from '#src/ports.ts';

/**
 * Result of one inbox-apply run, the inbound mirror of {@link RelaySummary}.
 * - `applied`: committed or deduped; row marked 'applied' so it is not re-claimed.
 * - `failed`: apply threw under the cap; row stays 'pending' with `attempts` bumped, retried
 *   next run.
 * - `deadLettered`: hit the attempt cap or was declined (a `rejected` Outcome, terminal). Row set
 *   to 'dead' and never re-claimed, so a poison event cannot block the events behind it.
 */
export type InboxSummary = {
  applied: ReadonlyArray<string>;
  failed: ReadonlyArray<{ id: string; code: string; retryable: boolean }>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
};

type InboxTally = {
  applied: string[];
  failed: Array<{ id: string; code: string; retryable: boolean }>;
  deadLettered: Array<{ id: string; reason: string }>;
};

// Inbox applies go through the normal economy path — the same invariants and idempotency a direct
// caller hits.
type Applier = Pick<Economy, 'submit'>;

/**
 * Applies a batch of pending inbox events — verified inbound provider events already mapped to
 * the {@link Operation} they apply.
 *
 * Never gated on the economy pause: settlements must keep flowing through a maintenance window.
 * An apply can run more than once (submit committed but `markApplied` did not); exactly-once
 * rests on the stored Operation's idempotencyKey (the provider event id the row deduped on), so
 * a re-apply resolves to a `duplicate` Outcome.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how inbox draining fits the sweep loop.
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/idempotency/ Idempotency} for the
 *   idempotencyKey dedupe.
 */
export async function drainInbox(
  store: Store,
  ctx: WorkerCtx,
  input: { economy: Applier; now: number; limit: number },
  options?: Options,
): Promise<InboxSummary> {
  const pending = await store.inbox.claimInbound(
    { now: input.now, limit: input.limit },
    options,
  );
  const tally: InboxTally = { applied: [], failed: [], deadLettered: [] };

  for (const entry of pending) {
    await applyOne(
      store,
      ctx,
      { economy: input.economy, entry, options },
      tally,
    );
  }

  return tally;
}

async function applyOne(
  store: Store,
  ctx: WorkerCtx,
  work: { economy: Applier; entry: InboxEntry; options?: Options },
  tally: InboxTally,
): Promise<void> {
  const { economy, entry, options } = work;
  let outcome: Outcome;
  try {
    outcome = await economy.submit(entry.operation, options);
  } catch (error) {
    // The applier is the injected port; a fault it classified itself passes through unchanged.
    await recordFailure(
      store,
      ctx,
      { entry, normalized: normalizePortError(error), options },
      tally,
    );
    return;
  }

  if (outcome.status === 'rejected') {
    // A decline is terminal: the same Operation would be declined the same way on every retry, so
    // dead-letter rather than burn attempts.
    ctx.logger.log('warn', 'worker.inbox.rejected', {
      entryId: entry.id,
      reason: outcome.reason,
    });
    await store.inbox.deadLetter(entry.id, outcome.reason, options);
    tally.deadLettered.push({ id: entry.id, reason: outcome.reason });
    return;
  }

  // committed or duplicate: the money move is in the ledger. markApplied no-ops on an
  // already-terminal row, so a double apply is harmless.
  await store.inbox.markApplied(entry.id, options);
  tally.applied.push(entry.id);
}

// The cap is `>=`, so the default `maxInboxAttempts` of 10 dead-letters on the 10th failure (the
// one that takes `attempts` to 10). Same off-by-one as the outbox's `dispatchOne`.
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
  const { entry, normalized, options } = work;
  const next = entry.attempts + 1;
  // A non-retryable fault fails identically on every retry, so burning the remaining
  // attempts only delays the dead-letter an operator needs to see.
  if (!normalized.retryable || next >= ctx.config.maxInboxAttempts) {
    ctx.logger.log('error', 'worker.inbox.dead_lettered', {
      entryId: entry.id,
      code: normalized.code,
      attempts: next,
    });
    await store.inbox.deadLetter(entry.id, normalized.code, options);
    tally.deadLettered.push({ id: entry.id, reason: normalized.code });
    return;
  }
  ctx.logger.log('warn', 'worker.inbox.failed', {
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
