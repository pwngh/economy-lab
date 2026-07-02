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
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { convertFloor, encodeAmount } from '#src/money.ts';
import { earned, platformShard, SYSTEM } from '#src/accounts.ts';

import type { WorkerCtx } from '#src/contract.ts';
import type { Saga, Store } from '#src/ports.ts';

/**
 * Reports which payouts moved this run, bucketed by outcome. The worker submits RESERVED payouts to
 * the provider and force-fails SUBMITTED payouts that have timed out. Settlement itself no longer runs
 * here. It arrives through the provider's settlement webhook (see src/operations/settlePayout.ts).
 * A failed payout goes to `deadLettered` if it can never succeed, including a timed-out submit. It
 * goes to `retrying` if it hit a temporary problem, such as a flaky network or database, and gets
 * another go next run.
 */
export type SettleSummary = {
  submitted: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

// Mutable version of SettleSummary that the run fills in, returned read-only at the end.
type SettleTally = {
  submitted: string[];
  deadLettered: Array<{ id: string; reason: string }>;
  retrying: Array<{ id: string; code: string }>;
};

/**
 * Advances a batch of due payouts one step each, then reports the outcomes.
 *
 * A payout runs as a multi-step saga. This job claims the ones whose next step is due and pushes each
 * forward in its own error boundary, so one broken payout cannot stop the others.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how this sweep claims and advances due payouts.
 */
export async function settleDuePayouts(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<SettleSummary> {
  let due = await store.sagas.claimDue(input.now, input.limit);
  let tally: SettleTally = {
    submitted: [],
    deadLettered: [],
    retrying: [],
  };

  for (let saga of due) {
    await advanceOne(store, ctx, saga, tally);
  }

  return tally;
}

// Pushes one payout to its next step inside the per-payout error boundary. If the step throws, a
// `retryable` error still under the per-payout attempt limit bumps the attempt count and retries
// next run. Anything else, whether permanent or retried too many times, is dead-lettered so the
// batch never gets stuck on a payout that cannot progress.
async function advanceOne(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  tally: SettleTally,
): Promise<void> {
  try {
    await driveTransition(store, ctx, saga, tally);
  } catch (error) {
    let normalized = normalizeError(error);
    if (
      normalized.retryable &&
      saga.attempts + 1 < ctx.config.maxPayoutAttempts
    ) {
      // Raise the attempt count, leaving the step unchanged. Without this a down provider would
      // retry forever. The count only rose on a successful submit (see submitToProvider), so a
      // payout whose submit kept failing never hit the limit, never dead-lettered, and left the
      // seller's reserved credits stuck. Bumping here means the payout eventually hits the limit and
      // the reserve is returned to the seller.
      await bumpAttempt(store, ctx, saga);
      tally.retrying.push({ id: saga.id, code: normalized.code });
      return;
    }
    if (await deadLetter(store, ctx, saga, normalized.code)) {
      tally.deadLettered.push({ id: saga.id, reason: normalized.code });
    }
  }
}

// Records one failed attempt without changing the step by re-asserting the current step with
// attempts+1. `advance` is a compare-and-set on the current step, so passing the same value for
// "from" and "to" raises the count only if no other worker moved the saga meanwhile, leaving the
// step in place.
async function bumpAttempt(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
): Promise<void> {
  await store.sagas.advance(saga.id, saga.state, saga.state, {
    attempts: saga.attempts + 1,
    updatedAt: ctx.clock.now(),
  });
}

// Gives up on a payout and, unless another actor already finished it, returns its reserved credits.
// Returns true if THIS call set the saga aside, false if it lost the race. One transaction couples
// the FAILED flip (a compare-and-set) with the reverse of the request-time reservation, so the
// reserve is never returned twice on a lost race.
// See https://economy-lab-docs.pages.dev/economy/concepts/lifecycles/ for the payout saga states and the shared CAS guard that releases the reserve exactly once.
//
// Locking PAYOUT_RESERVE and the seller's earned account in the global sorted order serializes this
// with the pipeline ops on the shared reserve. Without the lock, a late settle could win the chain
// and still let this reversal re-post on retry, double-paying the seller.
async function deadLetter(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  reason: string,
): Promise<boolean> {
  return store.transaction(async (unit) => {
    // The reserve routes by the saga's user, the same key requestPayout credited by, so the
    // routed shard, not the bare row, is what this locks and debits.
    let reserveRef = platformShard(
      SYSTEM.PAYOUT_RESERVE,
      saga.userId,
      ctx.config.platformShards,
    );
    await lockAll(unit.ledger, [reserveRef, earned(saga.userId)]);
    // Flip to FAILED only if the saga is still in the state we read, recording the failure reason in
    // the same write so it is read straight off the saga, not re-derived from posting meta. A false
    // return means a concurrent settle or reverse advanced the saga first, so leave the books to that actor.
    let advanced = await unit.sagas.advance(saga.id, saga.state, 'FAILED', {
      updatedAt: ctx.clock.now(),
      reason,
    });
    if (!advanced) {
      return false;
    }
    await postEntry(unit.ledger, {
      txnId: ctx.ids.next('txn'),
      legs: [
        debit(reserveRef, saga.reserve),
        credit(earned(saga.userId), saga.reserve),
      ],
      meta: { kind: 'payout.deadLetter', sagaId: saga.id, reason },
    });
    // Queue the "payout reversed" event in the same transaction, so it emits if and only if the
    // reversal committed: that is, if this worker, not a concurrent finisher, set the saga aside.
    await unit.outbox.enqueue({
      id: ctx.ids.next('obx'),
      event: {
        id: ctx.ids.next('evt'),
        type: 'economy.payout.reversed',
        version: 1,
        occurredAt: ctx.clock.now(),
        subject: saga.userId,
        data: {
          sagaId: saga.id,
          userId: saga.userId,
          reserve: encodeAmount(saga.reserve),
          reason,
        },
        audience: 'internal',
      },
      status: 'pending',
      attempts: 0,
      reason: null,
    });
    return true;
  });
}

// Reason recorded when a payout is force-failed for sitting in SUBMITTED too long. This is a stable
// string, not a thrown-fault code, so dashboards can distinguish a provider timeout from a provider
// error: nothing rejected the disbursement, the provider just never reported back within
// `maxPayoutAgeMs`.
const PAYOUT_TIMEOUT_REASON = 'payout.timeout';

// Does the one step the payout is up to, chosen by its current state. A 'RESERVED' payout gets
// submitted to the provider, moving to 'SUBMITTED'. A 'SUBMITTED' payout is left for the provider's
// settlement webhook to settle (see src/operations/settlePayout.ts), with one exception: if it has
// waited past `maxPayoutAgeMs` for a settlement that never arrived, it is force-failed here (see
// below). Any other state a due batch hands back, such as a leftover 'REQUESTED' or one already
// finished, is left untouched this run.
async function driveTransition(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  tally: SettleTally,
): Promise<void> {
  if (saga.state === 'RESERVED') {
    await submitToProvider(store, ctx, saga);
    tally.submitted.push(saga.id);
    return;
  }
  if (saga.state === 'SUBMITTED') {
    // The webhook settles SUBMITTED payouts (src/operations/settlePayout.ts). The sweep only steps
    // in when it never comes, so the reserve is not stranded in SUBMITTED forever. Force-fail once
    // the payout has waited past `maxPayoutAgeMs`, measured from `updatedAt`, which submitToProvider
    // sets on entry to SUBMITTED. deadLetter flips to FAILED and posts the compensating reversal in
    // one transaction, so a timed-out payout is never paid. Within the window, leave it for the
    // webhook.
    if (ctx.clock.now() - saga.updatedAt > ctx.config.maxPayoutAgeMs) {
      if (await deadLetter(store, ctx, saga, PAYOUT_TIMEOUT_REASON)) {
        tally.deadLettered.push({ id: saga.id, reason: PAYOUT_TIMEOUT_REASON });
      }
    }
  }
}

// Steps 'RESERVED' -> 'SUBMITTED' by handing the disbursement to the external payment provider. The
// seller's earned credits were reserved at request time. Here we convert the reserve to USD at the
// current rate, ask the provider to pay it out, record the provider's reference, and set when to
// next check on it. No ledger entry posts at this step, because the money already moved into the
// reserve at request time. A failed provider call is treated as temporary, so advanceOne can retry
// it.
async function submitToProvider(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
): Promise<void> {
  let rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  let usd = convertFloor(saga.reserve, rate, 'USD');

  let { providerRef } = await ctx.processor.submitPayout({
    key: saga.id,
    userId: saga.userId,
    amount: usd,
  });

  let now = ctx.clock.now();
  await store.sagas.advance(saga.id, 'RESERVED', 'SUBMITTED', {
    providerRef,
    attempts: saga.attempts + 1,
    dueAt: now + submittedSlaMs(ctx),
    updatedAt: now,
  });
}

// Returns the milliseconds to wait after submitting before the sweep next checks on the payout. It
// uses the configured SUBMITTED delay, falling back to DEFAULT, and the final `?? 0` guards against
// both being unset. (requestPayout reads the config the same way.) The sweep no longer settles a
// SUBMITTED payout, since that arrives via the settlement webhook, but it still re-examines the
// payout on this cadence to apply the `maxPayoutAgeMs` timeout if no settlement ever arrives.
function submittedSlaMs(ctx: WorkerCtx): number {
  let sla = ctx.config.payoutSla;
  return sla.SUBMITTED ?? sla.DEFAULT ?? 0;
}
