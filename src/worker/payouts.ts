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
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { encodeAmount } from '#src/money.ts';
import { pendingOutbox } from '#src/outbox.ts';
import { EVENT_VERSION } from '#src/ports.ts';
import { assertSagaAnchored } from '#src/operations/guards.ts';
import { earned, platformShard, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { PayoutProviderStatus, Saga, Store } from '#src/ports.ts';

/**
 * Reports which payouts moved this run, bucketed by outcome. `deadLettered` holds payouts that can
 * never succeed: a refused or timed-out submit. `retrying` holds temporary failures that get
 * another go next run, plus wedged sagas (anchor check refused, code CHAIN_BROKEN) that every
 * sweep re-reports until an operator acts. Settlement arrives via the provider's webhook (see
 * src/operations/settlePayout.ts), not this sweep.
 */
export type PayoutSweepSummary = {
  submitted: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

type PayoutSweepTally = {
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
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how this sweep claims and advances due payouts.
 */
export async function advanceDuePayouts(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<PayoutSweepSummary> {
  const due = await store.sagas.claimDue(input.now, input.limit);
  const tally: PayoutSweepTally = {
    submitted: [],
    deadLettered: [],
    retrying: [],
  };

  for (const saga of due) {
    // This gauge measures time in the current state, not since the request. `updatedAt`
    // refreshes on every transition, so the gauge is exactly the "stuck" age a supervisor
    // alerts on.
    ctx.meter.observe(
      'worker.payouts.saga_age_ms',
      input.now - saga.updatedAt,
      { state: saga.state },
    );
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
  tally: PayoutSweepTally,
): Promise<void> {
  try {
    await driveTransition(store, ctx, saga, tally);
  } catch (error) {
    const normalized = normalizeError(error);
    if (
      normalized.retryable &&
      saga.attempts + 1 < ctx.config.maxPayoutAttempts
    ) {
      await bumpAttempt(store, ctx, saga);
      tally.retrying.push({ id: saga.id, code: normalized.code });
      return;
    }
    try {
      if (await deadLetter(store, ctx, saga, normalized.code)) {
        tally.deadLettered.push({ id: saga.id, reason: normalized.code });
      }
    } catch (refused) {
      // The dead-letter itself refused. An unverifiable saga must not even return its reserve,
      // because that amount too would derive from the edited row. The saga wedges where it
      // stands, moving nothing, and every sweep re-reports it until an operator acts.
      const code = normalizeError(refused).code;
      ctx.logger.log('error', 'worker.payouts.wedged', { id: saga.id, code });
      tally.retrying.push({ id: saga.id, code });
    }
  }
}

// Re-asserts the current step with attempts+1. The state is unchanged here, so the state
// predicate holds for every sweep at once; `expectAttempts` is what makes this advance exclusive.
// Without it a sweep still holding an older snapshot writes its own count over a higher one, and a
// count that can fall keeps a permanently failing payout under maxPayoutAttempts, so its reserve
// is never returned. A false return means another sweep already counted this attempt, or the saga
// moved on: the row is at least as far along as this call wanted either way, and the sweep still
// reports the payout as retrying.
async function bumpAttempt(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
): Promise<void> {
  await store.sagas.advance(
    saga.id,
    saga.state,
    saga.state,
    {
      attempts: saga.attempts + 1,
      updatedAt: ctx.clock.now(),
    },
    { expectAttempts: saga.attempts },
  );
}

// Gives up on a payout and, unless another actor already finished it, returns its reserved
// credits. Returns true only if THIS call set the saga aside. One transaction couples the FAILED
// compare-and-set with the reversal, so the reserve is never returned twice on a lost race.
// See https://economy-lab-docs.pages.dev/economy/concepts/payout-saga/ for the saga states.
// Locking PAYOUT_RESERVE and the seller's earned account in the global sorted order serializes
// this with the pipeline ops on the shared reserve. Without that order, a late settle could
// double-pay.
async function deadLetter(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  reason: string,
): Promise<boolean> {
  const failed = await store.transaction(async (unit) => {
    // The reserve returned is re-proved against the saga's anchor posting first — the undo must
    // not derive from an edited row any more than a disbursement may.
    await assertSagaAnchored({ ledger: unit.ledger, digest: ctx.digest }, saga);
    // The reserve routes by the saga's user, the same key requestPayout credited by, so the
    // routed shard, not the bare row, is what this locks and debits.
    const reserveRef = platformShard(
      SYSTEM.PAYOUT_RESERVE,
      saga.userId,
      ctx.config.platformShards,
    );
    await lockAll(unit.ledger, [reserveRef, earned(saga.userId)]);
    // A false return means a concurrent settle or reverse advanced the saga first; leave the
    // books to that actor.
    const advanced = await unit.sagas.advance(saga.id, saga.state, 'FAILED', {
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
      meta: { kind: 'payouts.dead_letter', sagaId: saga.id, reason },
    });
    // Same transaction: the event emits if and only if the reversal committed.
    await unit.outbox.enqueue(
      pendingOutbox(ctx.ids, {
        id: ctx.ids.next('evt'),
        type: 'economy.payout.reversed',
        version: EVENT_VERSION,
        occurredAt: ctx.clock.now(),
        subject: saga.userId,
        data: {
          sagaId: saga.id,
          userId: saga.userId,
          reserve: encodeAmount(saga.reserve),
          reason,
        },
        audience: 'internal',
      }),
    );
    return true;
  });
  // This logs at error level like the inbox/outbox dead-letters, so an operator tailing logs
  // sees the abandoned cash-out without unpacking the sweep summary. It logs after the commit.
  // Inside the transaction, a rollback would leave the line claiming a reversal that never
  // happened, and a throwing logger would abort the reversal itself.
  if (failed) {
    try {
      ctx.logger.log('error', 'worker.payouts.dead_lettered', {
        sagaId: saga.id,
        userId: saga.userId,
        reason,
      });
      ctx.meter.count('worker.payouts.dead_lettered', 1, { reason });
    } catch {
      // The reversal committed; a logging failure must not report the item as unfinished.
    }
  }
  return failed;
}

// Stable reason string (not a thrown-fault code) for a payout that sat in SUBMITTED past
// `maxPayoutAgeMs`. Nothing rejected the disbursement. The provider just never reported back.
const PAYOUT_TIMEOUT_REASON = 'payout.timeout';

// Stable reasons for a provider-reported failure or return, surfaced by the optional
// `payoutStatus` probe.
const PAYOUT_PROVIDER_FAILED_REASON = 'payout.provider_failed';
const PAYOUT_PROVIDER_RETURNED_REASON = 'payout.provider_returned';

// Does the one step the payout is up to, chosen by its current state. A 'RESERVED' payout gets
// submitted to the provider, moving to 'SUBMITTED'. A 'SUBMITTED' payout is watched (see
// checkSubmitted). Any other state a due batch hands back, such as a leftover 'REQUESTED' or one
// already finished, is left untouched this run.
async function driveTransition(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  tally: PayoutSweepTally,
): Promise<void> {
  if (saga.state === 'RESERVED') {
    await submitToProvider(store, ctx, saga, tally);
    return;
  }
  if (saga.state === 'SUBMITTED') {
    await checkSubmitted(store, ctx, saga, tally);
  }
}

// Watches one SUBMITTED payout. The webhook settles it (src/operations/settlePayout.ts); the sweep
// steps in on the strength of what it can learn. A payout still carrying no provider reference is
// re-handed to the rail first (see resumeHandOff), because without one there is no evidence to
// gather. Otherwise, when the processor offers the `payoutStatus` probe, its answer is acted on
// first:
// - FAILED / RETURNED: the rail gave up on the disbursement; the reserve comes back now rather
//   than after the timeout. This is the prompt failure path.
// - SETTLED: the money moved but the settlement webhook has not landed. Force-failing here would
//   return the reserve on top of the disbursed USD (a double-pay), so the sweep only reschedules
//   and raises an error log for the operator. The webhook (or an operator settle) completes it.
// - PENDING past the timeout: the rail says it is still working, so the sweep defers the timeout
//   by refreshing `updatedAt`. Force-failing a live disbursement risks the same double-pay. The
//   deferral is logged each time, which keeps a payout pinned in PENDING visible.
// - UNKNOWN, no probe, or a probe error: the timeout protocol stands unchanged — past
//   `maxPayoutAgeMs` (measured from `updatedAt`, set on entry to SUBMITTED) the payout is
//   force-failed, and deadLetter posts the compensating reversal in the same transaction.
async function checkSubmitted(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  tally: PayoutSweepTally,
): Promise<void> {
  const aged = ctx.clock.now() - saga.updatedAt > ctx.config.maxPayoutAgeMs;
  // No provider reference means the hand-off never came back, so there is nothing to probe with
  // and asking the rail again is this sweep's whole step. Past the settlement window the timeout
  // below owns the payout instead, and asking again would only push the reserve further away.
  if (saga.providerRef === null && !aged) {
    await resumeHandOff(store, ctx, saga, tally);
    return;
  }
  const verdict = await providerVerdict(ctx, saga);
  if (verdict === 'FAILED' || verdict === 'RETURNED') {
    const reason =
      verdict === 'FAILED'
        ? PAYOUT_PROVIDER_FAILED_REASON
        : PAYOUT_PROVIDER_RETURNED_REASON;
    if (await deadLetter(store, ctx, saga, reason)) {
      tally.deadLettered.push({ id: saga.id, reason });
    }
    return;
  }
  if (verdict === 'SETTLED') {
    ctx.logger.log('error', 'worker.payouts.settlement_unreported', {
      sagaId: saga.id,
      providerRef: saga.providerRef,
    });
    ctx.meter.count('worker.payouts.settlement_unreported', 1);
    await recheckLater(store, ctx, saga, {});
    return;
  }
  if (verdict === 'PENDING') {
    if (aged) {
      ctx.logger.log('warn', 'worker.payouts.pending_past_timeout', {
        sagaId: saga.id,
        providerRef: saga.providerRef,
        ageMs: ctx.clock.now() - saga.updatedAt,
      });
      ctx.meter.count('worker.payouts.pending_past_timeout', 1);
      await recheckLater(store, ctx, saga, { updatedAt: ctx.clock.now() });
      return;
    }
    await recheckLater(store, ctx, saga, {});
    return;
  }
  if (aged && (await deadLetter(store, ctx, saga, PAYOUT_TIMEOUT_REASON))) {
    tally.deadLettered.push({ id: saga.id, reason: PAYOUT_TIMEOUT_REASON });
  }
}

// Asks the processor where a submitted payout stands, when it can be asked at all. Returns null
// when the processor offers no probe, the saga has no provider reference to look up, or the probe
// itself failed. In every such case the sweep has no evidence and must fall back to the timeout
// protocol. A probe fault is logged and swallowed here on purpose. It must not bump the saga's
// attempt count or dead-letter it via the sweep's error boundary, because the payout itself did
// nothing wrong.
async function providerVerdict(
  ctx: WorkerCtx,
  saga: Saga,
): Promise<PayoutProviderStatus['state'] | null> {
  if (ctx.processor.payoutStatus === undefined || saga.providerRef === null) {
    return null;
  }
  try {
    const status = await ctx.processor.payoutStatus({
      providerRef: saga.providerRef,
    });
    return status.state === 'UNKNOWN' ? null : status.state;
  } catch (error) {
    ctx.logger.log('warn', 'worker.payouts.status_probe_failed', {
      sagaId: saga.id,
      code: normalizePortError(error).code,
    });
    return null;
  }
}

// Reschedules the next look at a SUBMITTED payout without changing its state, via the same
// compare-and-set every other transition uses, so a concurrent settle or reverse wins cleanly.
// `patch` lets the PENDING deferral also refresh `updatedAt`, the timeout's measuring point.
async function recheckLater(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  patch: Partial<Saga>,
): Promise<void> {
  await store.sagas.advance(saga.id, 'SUBMITTED', 'SUBMITTED', {
    dueAt: ctx.clock.now() + submittedSlaMs(ctx),
    ...patch,
  });
}

// Steps 'RESERVED' -> 'SUBMITTED' by handing the disbursement to the external payment provider.
// The seller's earned credits were reserved at request time, and the USD submitted is the quote
// sealed in the reserve posting's hashed metadata. The saga row is re-proved against that
// anchor first, so an edited row cannot wire USD out. No ledger entry posts at this step,
// because the money already moved into the reserve at request time.
//
// The state advances BEFORE the rail is called. A thrown submit cannot say whether the transfer
// happened, and 'RESERVED' is the one state whose failure path returns the reserve — so failing
// there pays the seller their credits back on top of USD the provider may already have sent.
// 'SUBMITTED' is where the unknown outcome belongs: probe, then webhook, then the timeout.
async function submitToProvider(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  tally: PayoutSweepTally,
): Promise<void> {
  const usd = await assertSagaAnchored(
    { ledger: store.ledger, digest: ctx.digest },
    saga,
  );

  const now = ctx.clock.now();
  const entered = await store.sagas.advance(saga.id, 'RESERVED', 'SUBMITTED', {
    attempts: saga.attempts + 1,
    dueAt: now + submittedSlaMs(ctx),
    updatedAt: now,
  });
  // A false return means a settle or reverse took the saga first, and nothing has been handed to
  // the rail. Leave it to that actor.
  if (!entered) {
    return;
  }
  await handOff(
    store,
    ctx,
    // The copy handed on mirrors the row the advance just wrote — state included, so a refusal's
    // dead-letter compare-and-sets from 'SUBMITTED', the state the row is actually in.
    {
      ...saga,
      state: 'SUBMITTED',
      attempts: saga.attempts + 1,
      updatedAt: now,
    },
    { usd, tally },
  );
}

// Calls the rail and records what came back. The saga is already 'SUBMITTED' here, so a throw is
// not something this sweep can undo — and what it means depends on the verdict it carries. A
// throw with no verdict, or one that says retryable, is an answer lost in transit: the transfer
// may have gone through, so it is logged and left to the SUBMITTED protocol, which is the only
// path that can tell the two apart. A throw that classified itself non-retryable is the rail
// refusing outright: no transfer to wait on, and re-driving a call the rail already answered can
// never succeed, so the payout fails through deadLetter now — returning the reserve — rather than
// burning the attempt budget and then wedging until the settlement window expires. Acting on the
// verdict is safe because every wrapper defaults the other way: a throw carrying no signal stays
// retryable (see normalizePortError).
async function handOff(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  hand: { usd: Amount; tally: PayoutSweepTally },
): Promise<void> {
  const { usd, tally } = hand;
  let providerRef: string;
  try {
    ({ providerRef } = await ctx.processor.submitPayout({
      key: saga.id,
      userId: saga.userId,
      amount: usd,
    }));
  } catch (error) {
    const normalized = normalizePortError(error);
    if (!normalized.retryable) {
      // A false return means a concurrent settle or reverse finished the payout first; the
      // refusal is moot and the books belong to that actor.
      if (await deadLetter(store, ctx, saga, normalized.code)) {
        tally.deadLettered.push({ id: saga.id, reason: normalized.code });
      }
      return;
    }
    ctx.logger.log('error', 'worker.payouts.handoff_unresolved', {
      sagaId: saga.id,
      code: normalized.code,
    });
    ctx.meter.count('worker.payouts.handoff_unresolved', 1, {
      code: normalized.code,
    });
    // `updatedAt` is deliberately untouched: the timeout measures from the hand-off, and
    // refreshing it here would keep a silent payout out of the timeout forever.
    await recheckLater(store, ctx, saga, {});
    tally.retrying.push({ id: saga.id, code: normalized.code });
    return;
  }
  await store.sagas.advance(saga.id, 'SUBMITTED', 'SUBMITTED', {
    providerRef,
    dueAt: ctx.clock.now() + submittedSlaMs(ctx),
  });
  tally.submitted.push(saga.id);
}

// Asks the rail again for a payout whose hand-off never came back. `key` is what makes this safe
// to repeat — the provider settles one transfer per key — and the reference it returns is what
// both the status probe and the settlement webhook join on, so recovering it is what puts the
// payout back on the evidence path.
//
// The attempt count is claimed first. This is a same-state advance writing an absolute value, so
// `expectAttempts` is what makes it exclusive; without it two concurrent sweeps would both call
// the rail for the same payout. A false return means another sweep took this attempt.
async function resumeHandOff(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  tally: PayoutSweepTally,
): Promise<void> {
  // `maxPayoutAttempts` bounds how often the rail is asked, and nothing more. Past it the
  // settlement window is the whole remaining protocol, and re-calling a rail that is not
  // answering only adds traffic — it can no longer decide whether the reserve comes back.
  if (saga.attempts >= ctx.config.maxPayoutAttempts) {
    await recheckLater(store, ctx, saga, {});
    return;
  }
  const usd = await assertSagaAnchored(
    { ledger: store.ledger, digest: ctx.digest },
    saga,
  );
  const claimed = await store.sagas.advance(
    saga.id,
    'SUBMITTED',
    'SUBMITTED',
    { attempts: saga.attempts + 1 },
    { expectAttempts: saga.attempts },
  );
  if (!claimed) {
    return;
  }
  await handOff(
    store,
    ctx,
    { ...saga, attempts: saga.attempts + 1 },
    { usd, tally },
  );
}

// Milliseconds before the sweep next checks a submitted payout. The sweep re-examines it on this
// cadence only to apply the `maxPayoutAgeMs` timeout; settlement arrives via the webhook.
function submittedSlaMs(ctx: WorkerCtx): number {
  const sla = ctx.config.payoutSla;
  return sla.SUBMITTED ?? sla.DEFAULT ?? 0;
}
