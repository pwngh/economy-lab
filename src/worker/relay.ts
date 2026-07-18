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

import type { WorkerCtx } from '#src/contract.ts';
import type { Dispatcher, OutboxMessage, Options, Store } from '#src/ports.ts';

/**
 * Outcome of one relay run.
 * - `relayed`: delivered and marked done.
 * - `failed`: threw under the attempt cap; row stays 'pending' with `attempts` bumped, retried
 *   next run.
 * - `deadLettered`: hit the attempt cap. Row set to 'dead' and never re-claimed, so a poison
 *   event cannot block the events behind it.
 */
export type RelaySummary = {
  relayed: ReadonlyArray<string>;
  failed: ReadonlyArray<{ id: string; code: string; retryable: boolean }>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
};

type RelayTally = {
  relayed: string[];
  failed: Array<{ id: string; code: string; retryable: boolean }>;
  deadLettered: Array<{ id: string; reason: string }>;
};

/**
 * Delivers a batch of pending outbox events — each written in the same DB transaction as the
 * money move it describes.
 *
 * Delivery can happen more than once (delivery succeeded but marking done did not), so the
 * receiver must drop duplicates by event id.
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
  await observeBacklog(store, ctx, options);
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

// Telemetry only: a stats failure never blocks delivery. The gauge pair is what the ops
// backlog detector reads — a growing age means the relay is down or the events are poisoned.
async function observeBacklog(
  store: Store,
  ctx: WorkerCtx,
  options?: Options,
): Promise<void> {
  try {
    const stats = await store.outbox.stats(options);
    ctx.meter.observe('worker.relay.backlog', stats.pending);
    if (stats.oldestPendingAgeMs !== null) {
      ctx.meter.observe(
        'worker.relay.backlog_age_ms',
        stats.oldestPendingAgeMs,
      );
    }
  } catch {
    // The relay's own delivery accounting below still runs; a broken gauge is not a broken relay.
  }
}

// The cap test is `>=`, so the default `maxOutboxAttempts` of 10 dead-letters on the 10th
// failure, the one that takes `attempts` to 10.
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
    // The dispatcher is the injected port: its raw throw is a provider fault, not storage.
    const normalized = normalizePortError(error);
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

// If the write fails, the events are re-delivered next run; the receiver drops duplicates, so
// the failure is metered and logged rather than thrown.
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
