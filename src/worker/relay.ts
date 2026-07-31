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

import type { WorkerCtx } from '#src/contract.ts';
import type {
  Dispatcher,
  OutboxMessage,
  CallOptions,
  Ports,
  Store,
} from '#src/ports.ts';

/**
 * Outcome of one relay run.
 * - `relayed`: delivered and marked done.
 * - `failed`: delivery threw a retryable or unclassified fault under the attempt cap. The row
 *   stays 'pending' and is retried next run.
 * - `deadLettered`: delivery threw a fault classified non-retryable, or the event spent its
 *   attempt budget — by failing at the cap or by swallowing every attempt without ever coming
 *   back. The row is set to 'dead' and never re-claimed, so a poison event cannot block the
 *   events behind it for more than `maxOutboxAttempts` runs.
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
 * Delivery can happen more than once — delivery succeeded but marking done did not, or a second
 * relay running alongside was handed the same message, which the claim does not prevent because it
 * runs on the store rather than in a transaction — so the receiver must drop duplicates by event
 * id.
 *
 * Each of those deliveries is counted before it starts, so the cap counts deliveries rather than
 * failures and a row cannot be retried past it however a delivery ends.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for outbox relay run semantics and retries.
 */
export async function relayOutbox(
  store: Store,
  ports: Ports,
  input: { dispatcher: Dispatcher; limit: number },
  options?: CallOptions,
): Promise<RelaySummary> {
  const ctx = checkedPorts(ports);
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

// This is telemetry only, so a stats failure never blocks delivery. The ops backlog detector
// reads this gauge pair. A growing age means the relay is down or the events are poisoned.
async function observeBacklog(
  store: Store,
  ctx: WorkerCtx,
  options?: CallOptions,
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

// The attempt is counted before the delivery, so `maxOutboxAttempts` bounds deliveries started
// rather than failures seen. A dispatcher that throws needs none of this: the count is already
// durable when it does. The half this ordering exists for is a dispatcher that never returns —
// killed, hung, or OOM-killed — which leaves nothing to catch and no chance to write anything
// afterwards. Counting first is what stops such a row being retried forever.
async function dispatchOne(
  store: Store,
  ctx: WorkerCtx,
  work: {
    dispatcher: Dispatcher;
    message: OutboxMessage;
    options?: CallOptions;
  },
  tally: RelayTally,
): Promise<void> {
  const { dispatcher, message, options } = work;
  const attempt = await store.outbox.bumpAttempt(message.id, options);
  if (attempt === 0) {
    // Another relay marked it relayed or dead between the claim and here.
    return;
  }
  if (attempt > ctx.config.maxOutboxAttempts) {
    // Every attempt the budget allowed was started and none of them came back.
    ctx.logger.log('error', 'worker.relay.dead_lettered', {
      messageId: message.id,
      correlationId: message.correlationId,
      code: ATTEMPTS_ABANDONED,
      attempts: attempt,
    });
    await store.outbox.deadLetter(message.id, ATTEMPTS_ABANDONED, options);
    tally.deadLettered.push({ id: message.id, reason: ATTEMPTS_ABANDONED });
    return;
  }
  try {
    await dispatcher(message.event, options);
    tally.relayed.push(message.id);
  } catch (error) {
    // The dispatcher is the injected port. Its raw throw is a provider fault, not storage.
    const normalized = normalizePortError(error);
    // A fault classified non-retryable fails identically on every redelivery, so burning the
    // remaining attempts only delays the dead-letter an operator needs to see. Every shipped
    // dispatcher wraps its throws retryable — the Dispatcher conformance suite pins that — so
    // this verdict exists only where a host's thrower asserted it.
    if (!normalized.retryable || attempt >= ctx.config.maxOutboxAttempts) {
      ctx.logger.log('error', 'worker.relay.dead_lettered', {
        messageId: message.id,
        correlationId: message.correlationId,
        code: normalized.code,
        attempts: attempt,
      });
      await store.outbox.deadLetter(message.id, normalized.code, options);
      tally.deadLettered.push({ id: message.id, reason: normalized.code });
      return;
    }
    ctx.logger.log('warn', 'worker.relay.failed', {
      messageId: message.id,
      correlationId: message.correlationId,
      code: normalized.code,
      retryable: normalized.retryable,
      attempts: attempt,
    });
    tally.failed.push({
      id: message.id,
      code: normalized.code,
      retryable: normalized.retryable,
    });
  }
}

// If the write fails, the events are re-delivered next run. The receiver drops duplicates, so
// the failure is metered and logged rather than thrown.
async function markRelayed(
  store: Store,
  ctx: WorkerCtx,
  relayed: ReadonlyArray<string>,
  options?: CallOptions,
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
