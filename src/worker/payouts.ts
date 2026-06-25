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

import { ERROR_CODES, normalizeError } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Rate, Saga, Store } from '#src/ports.ts';

/**
 * Which payouts moved this run, bucketed by outcome. The worker submits RESERVED payouts to the
 * provider and force-fails SUBMITTED payouts that have timed out; settlement itself no longer runs
 * here — it arrives through the provider's settlement webhook (see src/operations/settlePayout.ts).
 * A failed payout lands in `deadLettered` if it can never succeed (including a timed-out submit),
 * or `retrying` if it hit a temporary problem (flaky network/database) and gets another go next run.
 */
export type SettleSummary = {
  submitted: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

// Mutable SettleSummary the run fills in, returned read-only at the end.
type SettleTally = {
  submitted: string[];
  deadLettered: Array<{ id: string; reason: string }>;
  retrying: Array<{ id: string; code: string }>;
};

/**
 * Advance a batch of due payouts one step each, then report the outcomes.
 *
 * A payout pays out over several steps spread across time, tracked as a "saga". This
 * background job claims the payouts whose next step is due and pushes each one forward.
 * Each runs in its own error boundary, so one broken payout can't stop the others: a
 * permanent failure is set aside and the batch continues.
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

// Push one payout to its next step inside the per-payout error boundary. If the step throws:
// a `retryable` error still under the per-payout attempt limit bumps the attempt count and
// retries next run; anything else (permanent, or retried too many times) is dead-lettered so
// the batch never gets stuck on a payout that can't progress.
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
      // retry forever: the count only rose on a *successful* submit (see submitToProvider), so a
      // payout whose submit kept failing never hit the limit, never dead-lettered, and left the
      // seller's reserved credits stuck. Bumping here means it eventually hits the limit and the
      // reserve is returned to the seller.
      await bumpAttempt(store, ctx, saga);
      tally.retrying.push({ id: saga.id, code: normalized.code });
      return;
    }
    await deadLetter(store, ctx, saga, normalized.code);
    tally.deadLettered.push({ id: saga.id, reason: normalized.code });
  }
}

// Record one failed attempt without changing the step: re-assert the current step with attempts+1.
// `advance` is a compare-and-set on the current step, so passing the same value for "from" and
// "to" raises the count only if no other worker moved the saga meanwhile, leaving the step put.
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

// Give up on a payout and, unless another worker already finished it, return its reserved credits.
//
// A requested payout moved the seller's earned credits into PAYOUT_RESERVE; flipping the saga to
// FAILED alone would park them there forever. So the normal abandon case (e.g. a provider failure
// out of retries) does two things in one transaction: post the exact reverse of the request-time
// reservation (debit PAYOUT_RESERVE, credit the seller's earned account, full reserved amount), and
// mark the saga FAILED. Coupling them releases the credits iff the saga is set aside.
//
// Exception: when the state change is rejected because another worker got there first
// (`INVALID_TRANSITION`). The step change only succeeds if the saga is still in the expected state,
// so a rejection means the saga already settled (via the settlement webhook, see
// src/operations/settlePayout.ts) and its reserve moved into REVENUE. The books are already correct;
// posting the reversal would return the credits twice, so we only flip the state and leave the
// ledger untouched.
async function deadLetter(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
  reason: string,
): Promise<void> {
  if (reason === ERROR_CODES.INVALID_TRANSITION) {
    await store.sagas.deadLetter(saga.id, reason);
    return;
  }
  await store.transaction(async (unit) => {
    await postEntry(unit.ledger, {
      txnId: ctx.ids.next('txn'),
      legs: [
        debit(SYSTEM.PAYOUT_RESERVE, saga.reserve),
        credit(earned(saga.userId), saga.reserve),
      ],
      meta: { kind: 'payout.deadLetter', sagaId: saga.id, reason },
    });
    await unit.sagas.deadLetter(saga.id, reason);
    // Queue the "payout reversed" event in the same transaction, so it emits iff the reversing
    // posting committed. Normal-abandon branch only; the early-return branch above (another worker
    // already settled) posts nothing and emits nothing, since that worker consumed the reserve.
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
  });
}

// Reason recorded when a payout is force-failed for sitting in SUBMITTED too long. A stable string
// (not a thrown-fault code) so dashboards can distinguish a provider timeout from a provider error:
// nothing rejected the disbursement, the provider just never reported back within `maxPayoutAgeMs`.
const PAYOUT_TIMEOUT_REASON = 'payout.timeout';

// Do the one step the payout is up to, chosen by its current state. 'RESERVED' gets submitted to
// the provider, moving to 'SUBMITTED'. 'SUBMITTED' is left for the provider's settlement webhook to
// settle (see src/operations/settlePayout.ts), with one exception: if it has waited past
// `maxPayoutAgeMs` for a settlement that never arrived, it is force-failed here (see below). Any
// other state a due batch hands back (e.g. a leftover 'REQUESTED', or one already finished) is left
// untouched this run.
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
    // The worker no longer self-settles a SUBMITTED payout; settlement arrives through the
    // provider's settlement webhook instead (src/operations/settlePayout.ts). The sweep only steps
    // in when the webhook never comes: a payout submitted to the provider that never reports back
    // can't settle, and without a cutoff it would sit in SUBMITTED forever, stranding the seller's
    // reserved credits. Once it has waited longer than `maxPayoutAgeMs` (from `updatedAt`, set on
    // entry to SUBMITTED in submitToProvider), force-fail it. The shared dead-letter helper flips it
    // to FAILED and, in the same transaction, posts the compensating reversal returning the reserve
    // to the seller, so a timed-out payout is never paid and never strands the reserve. A SUBMITTED
    // payout still within the age window is left untouched this run, waiting on the webhook.
    if (ctx.clock.now() - saga.updatedAt > ctx.config.maxPayoutAgeMs) {
      await deadLetter(store, ctx, saga, PAYOUT_TIMEOUT_REASON);
      tally.deadLettered.push({ id: saga.id, reason: PAYOUT_TIMEOUT_REASON });
    }
  }
}

// Step 'RESERVED' -> 'SUBMITTED': hand the disbursement to the external payment provider. The
// seller's earned credits were reserved at request time; here we convert the reserve to USD at the
// current rate, ask the provider to pay it out, record the provider's reference, and set when to
// next check on it. No ledger entry posts at this step (the money already moved into the reserve at
// request time). A failed provider call is treated as temporary, so advanceOne can retry it.
async function submitToProvider(
  store: Store,
  ctx: WorkerCtx,
  saga: Saga,
): Promise<void> {
  let rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  let usd = convert(saga.reserve, rate, 'USD');

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

// Convert a CREDIT amount to USD at the given rate, rounding down. The rate is stored as integers
// for exactness (`rate` scaled by 10^scale), so the real multiplier is `rate / 10^scale`: multiply
// the credit amount by `rate`, then divide by 10^scale.
function convert(amount: Amount, rate: Rate, to: Amount['currency']): Amount {
  return toAmount(to, (amount.minor * rate.rate) / 10n ** BigInt(rate.scale));
}

// Milliseconds to wait after submitting before the sweep next checks on the payout. Configured
// SUBMITTED delay, falling back to DEFAULT; the final `?? 0` guards against both being unset.
// (requestPayout reads the config the same way.) The sweep no longer settles a SUBMITTED payout —
// that arrives via the settlement webhook — but it still re-examines it on this cadence to apply the
// `maxPayoutAgeMs` timeout if no settlement ever lands.
function submittedSlaMs(ctx: WorkerCtx): number {
  let sla = ctx.config.payoutSla;
  return sla.SUBMITTED ?? sla.DEFAULT ?? 0;
}
