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

// A node that dies mid-epoch leaves its sessions journaled but never settled. This sweep
// enumerates them and reports each with its age. Settling an orphan moves money, so the sweep
// settles only when `settleOlderThanMs` is set, and only sessions whose newest movement is older
// than that bound. Set the bound comfortably above epochMaxAgeMs, where a still-open epoch is
// impossible. The settle is the session's own idempotent finish, so racing the owning node never
// double-posts.

import {
  recoverSession,
  refundEscrowRemainder,
  sharedReservations,
} from '#src/netting.ts';
import { normalizeError } from '#src/errors.ts';
import { balanceDelta } from '#src/ledger.ts';
import { escrowPartsOf, isWalletAccount } from '#src/accounts.ts';

import type { Reservations } from '#src/netting.ts';
import type { Store } from '#src/ports.ts';
import type { WorkerCtx } from '#src/contract.ts';

/** The structural subset of WorkerCtx the sweeps need. The worker passes its full ctx through. */
export type OrphanSweepCtx = Pick<
  WorkerCtx,
  'clock' | 'digest' | 'logger' | 'meter'
>;

export interface OrphanSweepSummary {
  /** Session ids inspected this run (bounded by `limit`). */
  scanned: number;
  /** Unsettled sessions and the age of their newest movement. */
  orphans: Array<{ sessionId: string; ageMs: number }>;
  /** Sessions this run finished (opt-in via `settleOlderThanMs`). */
  settled: Array<{ sessionId: string; mode: string }>;
  /** Prefund escrow remainders this run returned to their owners (crashed-refund repair). */
  escrowRefunds: Array<{ sessionId: string; userId: string; minor: string }>;
  failed: Array<{ sessionId: string; code: string }>;
  /** Set when the store offers no session enumeration. */
  skipped?: true;
}

export interface OrphanSweepInput {
  now: number;
  /** Max sessions to inspect per run; enumeration resumes from the top next run. */
  limit: number;
  /** Finish orphans older than this. When absent (the default), the sweep only reports, because settling moves money. */
  settleOlderThanMs?: number;
  /**
   * The registry recovered sessions release into. A multi-node host passes its shared registry
   * so a finished orphan frees the dead node's pending. By default the sweep builds one from the
   * store's counter when present, else a throwaway process registry. A throwaway release affects
   * nothing beyond this run, which is correct for single-node use of the sweep.
   */
  reservations?: Reservations;
}

/** One sweep pass. See the module doc for the live/dead discrimination the host owes it. */
export async function sweepOrphanSessions(
  store: Store,
  ctx: OrphanSweepCtx,
  input: OrphanSweepInput,
): Promise<OrphanSweepSummary> {
  const summary: OrphanSweepSummary = {
    scanned: 0,
    orphans: [],
    settled: [],
    escrowRefunds: [],
    failed: [],
  };
  if (store.movements.sessionIds === undefined) {
    return { ...summary, skipped: true };
  }
  const registry =
    input.reservations ??
    (store.reservations !== undefined ? sharedReservations(store) : undefined);
  const deps = { store, digest: ctx.digest, clock: ctx.clock };

  for await (const sessionId of store.movements.sessionIds()) {
    if (summary.scanned >= input.limit) {
      break;
    }
    summary.scanned += 1;
    try {
      const session = await recoverSession(deps, sessionId, {
        ...(registry === undefined ? {} : { reservations: registry }),
      });
      const ageMs = input.now - (await newestMovementAt(store, sessionId));
      const pastBound =
        input.settleOlderThanMs !== undefined &&
        ageMs > input.settleOlderThanMs;
      if (session.wasSettled()) {
        // The session already finished. The only repair a settled session can still need is a
        // prefund refund a crashed lane never posted — and that refund moves money, so it waits
        // for the same age bound the settle does. Inside the bound the owning lane is the one
        // that posts it, and racing it there is what turns a stale balance into an overdraft.
        if (pastBound) {
          await refundSessionEscrows(store, sessionId, summary);
        }
        continue;
      }
      summary.orphans.push({ sessionId, ageMs });
      if (pastBound) {
        const report = await session.settle();
        summary.settled.push({ sessionId, mode: report.mode });
        await refundSessionEscrows(store, sessionId, summary);
        ctx.logger.log('warn', 'worker.orphans.settled', {
          sessionId,
          mode: report.mode,
          ageMs,
        });
      }
    } catch (error) {
      const code = normalizeError(error).code;
      summary.failed.push({ sessionId, code });
      ctx.logger.log('error', 'worker.orphans.failed', { sessionId, code });
    }
  }

  ctx.meter.count('worker.orphans.scanned', summary.scanned);
  // This gauge is a level, not an event count. It reports how many orphans this run saw open,
  // like the drain's backlog.
  ctx.meter.observe('worker.orphans.open', summary.orphans.length);
  ctx.meter.count('worker.orphans.settled', summary.settled.length);
  return summary;
}

/**
 * The prefund repair for one settled session. Every escrow account its journaled movements
 * touched gives its remainder back to the owner's spendable. The refund posts by the same
 * deterministic txn id the lane's own refund uses, so lane, orphan sweep, and retention sweep
 * can never double-post it.
 */
export async function refundSessionEscrows(
  store: Store,
  sessionId: string,
  summary: Pick<OrphanSweepSummary, 'escrowRefunds'>,
): Promise<void> {
  const owners = new Set<string>();
  for await (const movement of store.movements.bySession(sessionId)) {
    for (const leg of movement.legs) {
      const parts = escrowPartsOf(leg.account);
      if (parts !== null && parts.sessionId === sessionId) {
        owners.add(parts.userId);
      }
    }
  }
  for (const userId of owners) {
    const minor = await refundEscrowRemainder(store, sessionId, userId);
    if (minor === null) {
      continue;
    }
    summary.escrowRefunds.push({ sessionId, userId, minor: minor.toString() });
  }
}

/** Epoch ms of the session's newest journal row. Returns 0 when the session has none. */
export async function newestMovementAt(
  store: Store,
  sessionId: string,
): Promise<number> {
  let newest = 0;
  for await (const movement of store.movements.bySession(sessionId)) {
    if (movement.recordedAt > newest) {
      newest = movement.recordedAt;
    }
  }
  return newest;
}

/**
 * Quiesced-maintenance repair for the shared reservation counter. It recomputes every account's
 * journal-derived pending (the sum over unsettled sessions' accepted movements) and adjusts each
 * counter row to match. This erases the conservative leaks a crash can leave (unflushed
 * acceptances, a release interrupted mid-run).
 *
 * It must run with the tier quiesced — no node accepting movements — because live sessions'
 * in-flight reservations are indistinguishable from leaks here. Running it live would erase
 * them and reopen the cross-node overdraft window. That makes this an operator action, never a
 * scheduled sweep.
 */
export async function reconcileReservations(
  store: Store,
  ctx: OrphanSweepCtx,
): Promise<{ accounts: number; adjusted: number }> {
  const counter = store.reservations;
  if (counter === undefined || store.movements.sessionIds === undefined) {
    return { accounts: 0, adjusted: 0 };
  }
  const deps = { store, digest: ctx.digest, clock: ctx.clock };

  // This fold computes journal truth, meaning what unsettled sessions still hold — the same
  // wallet-leg balanceDelta fold reserve() applied at accept time. Recovery uses a throwaway
  // process registry because this pass only reads session state and must not touch the shared
  // counter while computing.
  const desired = new Map<string, bigint>();
  for await (const sessionId of store.movements.sessionIds()) {
    const session = await recoverSession(deps, sessionId, {});
    if (session.wasSettled()) {
      continue;
    }
    for await (const movement of store.movements.bySession(sessionId)) {
      for (const leg of movement.legs) {
        if (!isWalletAccount(leg.account)) {
          continue;
        }
        const prior = desired.get(leg.account) ?? 0n;
        desired.set(leg.account, prior + balanceDelta(leg).minor);
      }
    }
  }

  let accounts = 0;
  let adjusted = 0;
  for await (const [account, current] of counter.entries()) {
    accounts += 1;
    const target = desired.get(account) ?? 0n;
    if (current !== target) {
      await counter.add(account, target - current);
      adjusted += 1;
      ctx.logger.log('warn', 'worker.orphans.reconciled', {
        account,
        from: current.toString(),
        to: target.toString(),
      });
    }
  }
  return { accounts, adjusted };
}
