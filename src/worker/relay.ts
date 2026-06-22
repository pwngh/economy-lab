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
 * The result of one relay run. `relayed` lists the ids of the events that were
 * delivered and marked done this run. `failed` lists the events whose delivery threw but
 * are still under the attempt cap: each carries its error code and whether the error was
 * transient (`retryable`), which the caller reports as metrics. A failed event was left
 * 'pending' (its `attempts` bumped) and will be tried again on the next run. `deadLettered`
 * lists the events whose delivery failed for the last allowed time: they hit the attempt cap
 * (`config.maxOutboxAttempts`), so they were set to 'failed' and will never be re-claimed —
 * this is what stops a single event that always fails ("poison") from blocking every event
 * behind it. Each dead-lettered entry carries the event id and the error code that stopped it
 * (its `reason`) — the same id-plus-reason shape the other background sweeps in this codebase
 * use for their own dead-letter lists, so callers can report them uniformly.
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
 * Delivers a batch of pending outbox events. Events were saved to the outbox in the same
 * database transaction as the money move they describe, so each one needs to be sent on to
 * subscribers. This grabs up to `limit` of them, sends each through the given `dispatcher`,
 * and marks the ones that went out so they aren't picked up again.
 *
 * Each event is sent inside its own try/catch, so one event whose delivery throws can't
 * stop the rest of the batch. An event that fails is left undelivered and gets retried on
 * the next run. Because a delivered event can therefore be sent more than once (e.g. if
 * delivery succeeded but marking it done did not), the receiving side is expected to drop
 * duplicates by event id.
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

// Sends one event and records the outcome in the running tally. On success, the event id is
// added to `relayed`. If the dispatcher throws, the error is logged and the failure is
// persisted (rather than re-thrown), so the rest of the batch keeps going.
//
// The persisted bump is what bounds retries. This failure would make the row's attempt count
// `message.attempts + 1`; if that reaches the configured cap, the row is dead-lettered — set
// to 'failed' so `claimBatch` never hands it back again — and recorded in `deadLettered`.
// That is what keeps one poison event (whose delivery always throws) from being re-claimed
// forever and wedging the queue. Otherwise the row's `attempts` is bumped via `recordFailure`
// (it stays 'pending'), the event lands in `failed`, and the next run retries it.
//
// The cap is `>=` so the default `maxOutboxAttempts` of 10 dead-letters on the 10th failure
// (the failure that takes `attempts` to 10). That is the single off-by-one decision for the
// outbox, deliberately stated here so every adapter only has to agree on the stored count;
// it mirrors the payout sweep's own `attempts + 1 < cap` boundary in payouts.ts.
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

// Marks this run's delivered events as done, in a single write, so the next run doesn't pick
// them up again. If that write itself fails, the events stay marked undelivered and will be
// delivered again on the next run; that's acceptable (the receiver drops duplicates), so the
// failure is recorded as a metric and logged rather than thrown.
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
