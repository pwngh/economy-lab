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

import type { WorkerCtx } from '#src/contract.ts';
import type { Dispatcher, OutboxMessage, Options, Store } from '#src/ports.ts';

/**
 * Holds the outcome of one relay run.
 *
 * `relayed` lists the ids delivered and marked done this run.
 *
 * `failed` lists deliveries that threw but stayed under the attempt cap. Each entry carries the
 * error code and a `retryable` flag for caller metrics. The row stays 'pending' with `attempts`
 * bumped, so the next run retries it.
 *
 * `deadLettered` lists events that hit the attempt cap (`config.maxOutboxAttempts`). Each is set
 * to 'failed' and never re-claimed, so a poison event cannot block the events behind it. Each
 * entry carries the event id and the error code (`reason`). This matches the id and reason shape
 * the other background sweeps use.
 */
export type RelaySummary = {
  relayed: ReadonlyArray<string>;
  failed: ReadonlyArray<{ id: string; code: string; retryable: boolean }>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
};

// The mutable version of RelaySummary that the run fills in as it goes.
type RelayTally = {
  relayed: string[];
  failed: Array<{ id: string; code: string; retryable: boolean }>;
  deadLettered: Array<{ id: string; reason: string }>;
};

/**
 * Delivers a batch of pending outbox events. Events were written in the same DB transaction as
 * the money move they describe. Claims up to `limit`, sends each through `dispatcher`, and marks
 * the ones that went out so they aren't re-claimed.
 *
 * Each event is sent in its own try/catch, so one failure can't stop the batch; a failed event
 * is left undelivered and retried next run. Delivery can therefore happen more than once (e.g.
 * delivery succeeded but marking done did not), so the receiver must drop duplicates by event id.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for outbox relay run semantics and retries.
 */
export async function relayOutbox(
  store: Store,
  ctx: WorkerCtx,
  input: { dispatcher: Dispatcher; limit: number },
  options?: Options,
): Promise<RelaySummary> {
  const pending = await store.outbox.claimBatch(input.limit, options);
  const tally: RelayTally = { relayed: [], failed: [], deadLettered: [] };

  for (const message of pending) {
    await dispatchOne(
      store,
      ctx,
      { dispatcher: input.dispatcher, message, options },
      tally,
    );
  }

  await markRelayed(store, ctx, tally.relayed, options);

  return tally;
}

// Sends one event and records the outcome in the tally. On success the id goes to `relayed`. If
// the dispatcher throws, the failure is logged and persisted rather than re-thrown, so the batch
// keeps going. The failure buckets and their store effects are specified on {@link RelaySummary};
// this failure makes the row's attempt count `message.attempts + 1`, dead-lettering at the cap
// and otherwise bumping `attempts` for the next run to retry.
//
// The cap test is `>=`, so the default `maxOutboxAttempts` of 10 dead-letters on the 10th
// failure, the one that takes `attempts` to 10. This is the single off-by-one for the outbox,
// stated here so every adapter agrees on the stored count. It mirrors the payout sweep's
// `attempts + 1 < cap` in payouts.ts.
async function dispatchOne(
  store: Store,
  ctx: WorkerCtx,
  work: { dispatcher: Dispatcher; message: OutboxMessage; options?: Options },
  tally: RelayTally,
): Promise<void> {
  const { dispatcher, message, options } = work;
  try {
    await dispatcher(message.event, options);
    tally.relayed.push(message.id);
  } catch (error) {
    const normalized = normalizeError(error);
    const next = message.attempts + 1;
    if (next >= ctx.config.maxOutboxAttempts) {
      ctx.logger.log('error', 'worker.relay.dead_lettered', {
        messageId: message.id,
        code: normalized.code,
        attempts: next,
      });
      await store.outbox.deadLetter(message.id, normalized.code, options);
      tally.deadLettered.push({ id: message.id, reason: normalized.code });
      return;
    }
    ctx.logger.log('warn', 'worker.relay.failed', {
      messageId: message.id,
      code: normalized.code,
      retryable: normalized.retryable,
      attempts: next,
    });
    await store.outbox.recordFailure(message.id, options);
    tally.failed.push({
      id: message.id,
      code: normalized.code,
      retryable: normalized.retryable,
    });
  }
}

// Marks this run's delivered events as done in a single write so the next run skips them. If the
// write fails, the events stay undelivered and are re-delivered next run. That is acceptable
// because the receiver drops duplicates, so the failure is metered and logged rather than thrown.
async function markRelayed(
  store: Store,
  ctx: WorkerCtx,
  relayed: ReadonlyArray<string>,
  options?: Options,
): Promise<void> {
  if (relayed.length === 0) {
    return;
  }
  try {
    await store.outbox.markRelayed(relayed, options);
  } catch (error) {
    const normalized = normalizeError(error);
    ctx.meter.count('worker.relay.mark_failed', relayed.length, {
      code: normalized.code,
    });
    ctx.logger.log('error', 'worker.relay.mark_failed', {
      count: relayed.length,
      code: normalized.code,
    });
  }
}
