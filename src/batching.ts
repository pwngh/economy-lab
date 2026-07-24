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

/**
 * The submit coalescer: a drop-in `submit` that gathers concurrent calls into one
 * {@link Economy.submitBatch}, so a burst of independent operations pays one database commit
 * instead of one each. Each caller still receives exactly what a direct `submit` would have
 * produced — the outcome resolved, or the fault rethrown.
 */

import type { CallOptions } from '#src/ports.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';

export type CoalescerOptions = {
  /** Largest batch one flush submits; a full queue flushes immediately. Default 16. */
  maxBatch?: number;

  /**
   * Schedules the pending flush. The default, `queueMicrotask`, coalesces the calls of one
   * event-loop turn — the same-burst case, with no added latency. A host that wants a wider
   * window injects its own scheduler (e.g. a short timer) and buys more batching for a few
   * milliseconds of delay.
   */
  defer?: (flush: () => void) => void;
};

export type SubmitCoalescer = {
  /** Queues the operation for the next flush and resolves with its own outcome. */
  submit(operation: Operation, options?: CallOptions): Promise<Outcome>;

  /** Submits everything queued right now, without waiting for the scheduled flush. */
  flush(): Promise<void>;
};

type Waiter = {
  operation: Operation;
  resolve: (outcome: Outcome) => void;
  reject: (error: unknown) => void;
};

/**
 * Wraps an economy's submit in batch coalescing. Per-call {@link CallOptions} cannot ride a
 * shared batch, so a call that passes options bypasses the queue and submits directly — it keeps
 * its exact semantics and simply forgoes the batching win.
 *
 * @example
 * const coalesced = createSubmitCoalescer(economy, { maxBatch: 32 });
 * // A burst of independent operations pays one database commit, each caller
 * // still resolving with exactly its own outcome.
 * const outcomes = await Promise.all(
 *   operations.map((operation) => coalesced.submit(operation)),
 * );
 */
export function createSubmitCoalescer(
  economy: Pick<Economy, 'submit' | 'submitBatch'>,
  options: CoalescerOptions = {},
): SubmitCoalescer {
  const maxBatch = options.maxBatch ?? 16;
  const defer = options.defer ?? ((flush: () => void) => queueMicrotask(flush));
  const queue: Waiter[] = [];
  let scheduled = false;

  const flush = async (): Promise<void> => {
    scheduled = false;
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatch);
      const slots = await economy
        .submitBatch(batch.map((waiter) => waiter.operation))
        .catch((error: unknown) => {
          for (const waiter of batch) {
            waiter.reject(error);
          }
          return null;
        });
      if (slots === null) {
        continue;
      }
      batch.forEach((waiter, i) => {
        const slot = slots[i]!;
        if (slot.ok) {
          waiter.resolve(slot.outcome);
        } else {
          waiter.reject(slot.error);
        }
      });
    }
  };

  return {
    submit: (operation, callOptions) => {
      if (callOptions !== undefined) {
        return economy.submit(operation, callOptions);
      }
      return new Promise<Outcome>((resolve, reject) => {
        queue.push({ operation, resolve, reject });
        if (queue.length >= maxBatch) {
          void flush();
          return;
        }
        if (!scheduled) {
          scheduled = true;
          defer(() => void flush());
        }
      });
    },
    flush,
  };
}
