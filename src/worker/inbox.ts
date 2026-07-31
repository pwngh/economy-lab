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
import { ATTEMPTS_ABANDONED } from '#src/ports.ts';

import { checkedPorts } from '#src/contract.ts';

import type { Economy, Outcome, WorkerCtx } from '#src/contract.ts';
import type { InboxMessage, CallOptions, Ports, Store } from '#src/ports.ts';

/**
 * Result of one inbox-apply run, the inbound mirror of {@link RelaySummary}.
 * - `applied` means the event committed or deduped. The row is marked 'applied' so it is not
 *   re-claimed.
 * - `failed` means the apply threw under the cap. The row stays 'pending' and the next run
 *   retries it.
 * - `deadLettered` means the event was declined (a `rejected` Outcome, terminal) or spent its
 *   attempt budget, either by failing at the cap or by swallowing every attempt without ever
 *   coming back. The row is set to 'dead' and never re-claimed, so a poison event cannot block
 *   the events behind it for more than `maxInboxAttempts` runs.
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
 * the `Operation` they apply.
 *
 * The drain is never gated on the economy pause, because settlements must keep flowing through a
 * maintenance window. An apply can run more than once: submit committed but `markApplied` did not,
 * or a second drain running alongside was handed the same row, which the claim does not prevent
 * because it runs on the store rather than in a transaction. Exactly-once rests on the stored
 * Operation's idempotencyKey (the provider event id the row deduped on), so a re-apply resolves to
 * a `duplicate` Outcome.
 *
 * Each of those applies is counted before it starts, so the cap counts applies rather than
 * failures and a row cannot be retried past it however an apply ends.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how inbox draining fits the sweep loop.
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/idempotency/ Idempotency} for the
 *   idempotencyKey dedupe.
 */
export async function drainInbox(
  store: Store,
  ports: Ports,
  input: { economy: Applier; now: number; limit: number },
  options?: CallOptions,
): Promise<InboxSummary> {
  const ctx = checkedPorts(ports);
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

// The attempt is counted before the apply, so `maxInboxAttempts` bounds applies started rather
// than failures seen, and an apply that never returns — the worker killed, hung or OOM-killed
// inside it — still walks the row toward its dead-letter instead of being retried forever.
async function applyOne(
  store: Store,
  ctx: WorkerCtx,
  work: { economy: Applier; entry: InboxMessage; options?: CallOptions },
  tally: InboxTally,
): Promise<void> {
  const { economy, entry, options } = work;
  const attempt = await store.inbox.bumpAttempt(entry.id, options);
  if (attempt === 0) {
    // Another drain applied or dead-lettered it between the claim and here.
    return;
  }
  if (attempt > ctx.config.maxInboxAttempts) {
    // Every attempt the budget allowed was started and none of them came back.
    ctx.logger.log('error', 'worker.inbox.dead_lettered', {
      entryId: entry.id,
      code: ATTEMPTS_ABANDONED,
      attempts: attempt,
    });
    await store.inbox.deadLetter(entry.id, ATTEMPTS_ABANDONED, options);
    tally.deadLettered.push({ id: entry.id, reason: ATTEMPTS_ABANDONED });
    return;
  }

  let outcome: Outcome;
  try {
    outcome = await economy.submit(entry.operation, options);
  } catch (error) {
    // The applier is the injected port. A fault it classified itself passes through unchanged.
    await recordFailure(
      store,
      ctx,
      { entry, attempt, normalized: normalizePortError(error), options },
      tally,
    );
    return;
  }

  if (outcome.status === 'rejected') {
    // A decline is terminal. The same Operation would be declined the same way on every retry;
    // dead-letter rather than burn attempts.
    ctx.logger.log('warn', 'worker.inbox.rejected', {
      entryId: entry.id,
      reason: outcome.detail.reason,
    });
    await store.inbox.deadLetter(entry.id, outcome.detail.reason, options);
    tally.deadLettered.push({ id: entry.id, reason: outcome.detail.reason });
    return;
  }

  // Committed or duplicate: either way the money move is in the ledger. markApplied no-ops on
  // an already-terminal row, which makes a double apply harmless.
  await store.inbox.markApplied(entry.id, options);
  tally.applied.push(entry.id);
}

// The cap is `>=`, so the default `maxInboxAttempts` of 10 dead-letters on the 10th apply, the one
// that took `attempts` to 10. The outbox's `dispatchOne` counts the same way.
async function recordFailure(
  store: Store,
  ctx: WorkerCtx,
  work: {
    entry: InboxMessage;
    attempt: number;
    normalized: ReturnType<typeof normalizeError>;
    options?: CallOptions;
  },
  tally: InboxTally,
): Promise<void> {
  const { entry, attempt, normalized, options } = work;
  // A non-retryable fault fails identically on every retry, so burning the remaining
  // attempts only delays the dead-letter an operator needs to see.
  if (!normalized.retryable || attempt >= ctx.config.maxInboxAttempts) {
    ctx.logger.log('error', 'worker.inbox.dead_lettered', {
      entryId: entry.id,
      code: normalized.code,
      attempts: attempt,
    });
    await store.inbox.deadLetter(entry.id, normalized.code, options);
    tally.deadLettered.push({ id: entry.id, reason: normalized.code });
    return;
  }
  ctx.logger.log('warn', 'worker.inbox.failed', {
    entryId: entry.id,
    code: normalized.code,
    retryable: normalized.retryable,
    attempts: attempt,
  });
  tally.failed.push({
    id: entry.id,
    code: normalized.code,
    retryable: normalized.retryable,
  });
}
