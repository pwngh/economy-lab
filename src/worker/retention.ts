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

// The two lifetime-growth surfaces with a correctness-safe deletion horizon, each its own host
// opt-in (an absent horizon leaves that surface untouched). Idempotency rows: a deleted key is
// open again — a duplicate request after deletion re-executes — so `idempotencyOlderThanMs`
// must exceed every window in which a caller could still retry. Settled sessions' journal
// rows: pruning removes a session from the orphan sweep's enumeration, and verify-then-prune
// deletes rows only for a session whose settlement evidence checks out and whose escrow
// remainders were refunded, only past `sessionsOlderThanMs`; pruned history is gone from
// reads, so the horizon must exceed the refund/dispute window.

import { recoverSession } from '#src/netting.ts';
import { newestMovementAt, refundSessionEscrows } from '#src/worker/orphans.ts';
import { normalizeError } from '#src/errors.ts';

import type { OrphanSweepCtx } from '#src/worker/orphans.ts';
import type { Store } from '#src/ports.ts';

export interface RetentionSweepInput {
  now: number;

  /** Per-lane cap: idempotency rows deleted, and sessions inspected, per run. */
  limit: number;

  /** Delete idempotency rows older than this; a deleted key re-executes on a duplicate. */
  idempotencyOlderThanMs?: number;

  /** Prune settled sessions whose newest movement is older than this. */
  sessionsOlderThanMs?: number;
}

export interface RetentionSweepSummary {
  /** `skipped` when the lane's horizon is unset or the store offers no delete surface. */
  idempotency: { deleted: number; skipped?: true };
  sessions: {
    /** Session ids inspected this run (bounded by `limit`). */
    scanned: number;
    pruned: Array<{ sessionId: string; movements: number }>;
    /** Escrow remainders returned before pruning (the orphan sweep's own idempotent repair). */
    escrowRefunds: Array<{ sessionId: string; userId: string; minor: string }>;
    failed: Array<{ sessionId: string; code: string }>;
    skipped?: true;
  };
}

/** One retention pass; each lane runs only under its horizon opt-in. */
export async function sweepRetention(
  store: Store,
  ctx: OrphanSweepCtx,
  input: RetentionSweepInput,
): Promise<RetentionSweepSummary> {
  const idempotency = await sweepIdempotency(store, input);
  const sessions = await pruneSettledSessions(store, ctx, input);
  ctx.meter.count('worker.retention.idempotency_deleted', idempotency.deleted);
  ctx.meter.count('worker.retention.sessions_pruned', sessions.pruned.length);
  return { idempotency, sessions };
}

async function sweepIdempotency(
  store: Store,
  input: RetentionSweepInput,
): Promise<RetentionSweepSummary['idempotency']> {
  if (
    input.idempotencyOlderThanMs === undefined ||
    store.idempotency.deleteOlderThan === undefined
  ) {
    return { deleted: 0, skipped: true };
  }
  const deleted = await store.idempotency.deleteOlderThan(
    input.now - input.idempotencyOlderThanMs,
    input.limit,
  );
  return { deleted };
}

async function pruneSettledSessions(
  store: Store,
  ctx: OrphanSweepCtx,
  input: RetentionSweepInput,
): Promise<RetentionSweepSummary['sessions']> {
  const lane: RetentionSweepSummary['sessions'] = {
    scanned: 0,
    pruned: [],
    escrowRefunds: [],
    failed: [],
  };
  if (
    input.sessionsOlderThanMs === undefined ||
    store.movements.sessionIds === undefined ||
    store.movements.pruneSession === undefined
  ) {
    return { ...lane, skipped: true };
  }
  const deps = { store, digest: ctx.digest, clock: ctx.clock };

  for await (const sessionId of store.movements.sessionIds()) {
    if (lane.scanned >= input.limit) {
      break;
    }
    lane.scanned += 1;
    try {
      // Verification only: a throwaway process registry, so recovery touches no shared counter.
      const session = await recoverSession(deps, sessionId, {});
      if (!session.wasSettled()) {
        // Live or orphaned — the orphan sweep's business, never retention's.
        continue;
      }
      const ageMs = input.now - (await newestMovementAt(store, sessionId));
      if (ageMs <= input.sessionsOlderThanMs) {
        continue;
      }
      await refundSessionEscrows(store, sessionId, lane);
      const movements = await store.movements.pruneSession(sessionId);
      lane.pruned.push({ sessionId, movements });
    } catch (error) {
      const code = normalizeError(error).code;
      lane.failed.push({ sessionId, code });
      ctx.logger.log('error', 'worker.retention.failed', { sessionId, code });
    }
  }
  return lane;
}
