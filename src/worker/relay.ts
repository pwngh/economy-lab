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
 * Result of one relay run.
 * - `relayed`: ids delivered and marked done this run.
 * - `failed`: delivery threw but still under the attempt cap; each carries error code and
 *   `retryable` (for caller metrics). Left 'pending' with `attempts` bumped, retried next run.
 * - `deadLettered`: hit the attempt cap (`config.maxOutboxAttempts`), set to 'failed', never
 *   re-claimed, so a poison event can't block events behind it. Each carries event id and the
 *   error code (`reason`) — same id+reason shape the other background sweeps use.
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
 */
export async function relayOutbox(
  store: Store,
  ctx: WorkerCtx,
  input: { dispatcher: Dispatcher; limit: number },
  options?: Options,
): Promise<RelaySummary> {
  let pending = await store.outbox.claimBatch(input.limit, options);
  let tally: RelayTally = { relayed: [], failed: [], deadLettered: [] };

  for (let message of pending) {
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
// the dispatcher throws, the failure is logged and persisted (not re-thrown) so the batch keeps
// going.
//
// The persisted bump bounds retries. This failure makes the row's attempt count
// `message.attempts + 1`; at the cap the row is dead-lettered (set to 'failed' so `claimBatch`
// won't hand it back) and recorded in `deadLettered`, keeping a poison event from wedging the
// queue. Otherwise `recordFailure` bumps `attempts` (row stays 'pending'), the event lands in
// `failed`, and the next run retries it.
//
// Cap is `>=` so the default `maxOutboxAttempts` of 10 dead-letters on the 10th failure (the one
// that takes `attempts` to 10). Single off-by-one for the outbox, stated here so every adapter
// only agrees on the stored count; mirrors the payout sweep's `attempts + 1 < cap` in payouts.ts.
async function dispatchOne(
  store: Store,
  ctx: WorkerCtx,
  work: { dispatcher: Dispatcher; message: OutboxMessage; options?: Options },
  tally: RelayTally,
): Promise<void> {
  let { dispatcher, message, options } = work;
  try {
    await dispatcher(message.event, options);
    tally.relayed.push(message.id);
  } catch (error) {
    let normalized = normalizeError(error);
    let next = message.attempts + 1;
    if (next >= ctx.config.maxOutboxAttempts) {
      ctx.logger.log('error', 'outbox.relay.deadLettered', {
        messageId: message.id,
        code: normalized.code,
        attempts: next,
      });
      await store.outbox.deadLetter(message.id, normalized.code, options);
      tally.deadLettered.push({ id: message.id, reason: normalized.code });
      return;
    }
    ctx.logger.log('warn', 'outbox.relay.failed', {
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
// write fails, the events stay undelivered and get re-delivered next run; acceptable (receiver
// drops duplicates), so the failure is metered and logged rather than thrown.
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
    let normalized = normalizeError(error);
    ctx.meter.count('economy.outbox.mark_relayed.failed', relayed.length, {
      code: normalized.code,
    });
    ctx.logger.log('error', 'outbox.markRelayed.failed', {
      count: relayed.length,
      code: normalized.code,
    });
  }
}
