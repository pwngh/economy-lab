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

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Rate, Saga, SagaState, Store, Unit } from '#src/ports.ts';

/**
 * What `settleDuePayouts` returns: which payouts moved this run, sorted by what happened
 * to each. A payout that failed lands in `deadLettered` if it can never succeed, or in
 * `retrying` if it hit a temporary problem (a flaky network or database) and will be
 * tried again on the next run. The escrow-release worker (holds.ts) returns the same
 * shape, so every background sweep reports its results the same way.
 */
export type SettleSummary = {
  settled: ReadonlyArray<string>;
  submitted: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

// The mutable version of SettleSummary that this run fills in as it goes; it is returned
// as the read-only SettleSummary at the end.
type SettleTally = {
  settled: string[];
  submitted: string[];
  deadLettered: Array<{ id: string; reason: string }>;
  retrying: Array<{ id: string; code: string }>;
};

/**
 * Move a batch of due payouts one step closer to being paid out, then report what
 * happened to each.
 *
 * A payout is paid out in several steps spread over time (the steps are tracked as a
 * record called a "saga"). This is the background job that picks up the payouts whose
 * next step is due and pushes each one to its next step. Each payout is handled inside
 * its own error boundary, so a single broken payout can't stop the others: if one fails
 * for good it is set aside, and the batch keeps going.
 */
export async function settleDuePayouts(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<SettleSummary> {
  let due = await store.sagas.claimDue(input.now, input.limit);
  let tally: SettleTally = {
    settled: [],
    submitted: [],
    deadLettered: [],
    retrying: [],
  };

  for (let saga of due) {
    await advanceOne(store, ctx, saga, tally);
  }

  return tally;
}

// Push one payout to its next step, with the error boundary that keeps one failure from
// taking down the batch. If the step throws, decide what to do once: a temporary problem
// (a flaky network or database, flagged `retryable`) that hasn't yet hit the per-payout
// attempt limit has its attempt count bumped and is retried on the next run; anything else —
// a permanent error, or a temporary one that has now been retried too many times — is set
// aside (dead-lettered) so the batch never gets stuck retrying a payout that can't progress.
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
      // Record that this attempt failed: raise the saga's attempt count by one, leaving its
      // step unchanged, so the next run sees a higher count. Without this a provider that stays
      // down would retry forever — the count only ever rose on a *successful* submit (see
      // submitToProvider), so a payout whose submit kept failing never reached the limit, never
      // dead-lettered, and left the seller's reserved credits stuck. Bumping it here means a
      // persistently-failing payout eventually hits the limit and is given up on, which returns
      // the reserve to the seller.
      await bumpAttempt(store, ctx, saga);
      tally.retrying.push({ id: saga.id, code: normalized.code });
      return;
    }
    await deadLetter(store, ctx, saga, normalized.code);
    tally.deadLettered.push({ id: saga.id, reason: normalized.code });
  }
}

// Record one failed attempt without changing the payout's step: re-assert its current step
// with the attempt count raised by one. `advance` is a compare-and-set on the current step, so
// passing the same value for both "from" and "to" raises the count only if no other worker has
// moved the saga meanwhile, and leaves the step exactly where it was.
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

// Give up on a payout, and unless another worker already finished it, return its reserved
// credits instead of stranding them.
//
// A requested payout moved the seller's earned credits into PAYOUT_RESERVE; flipping the
// saga to FAILED on its own would leave those credits parked there forever. So in the normal
// abandon case (a provider failure that has run out of retries, say) the dead-letter does two
// things in one database transaction: it posts the exact reverse of the request-time
// reservation (debit PAYOUT_RESERVE, credit the seller's earned account, for the full reserved
// amount), and it records the saga as FAILED. Coupling them means the credits are released if
// and only if the saga is set aside — never one without the other.
//
// The one exception is when the state change is rejected because another worker got there
// first (the `INVALID_TRANSITION` error): the step change only succeeds if the saga is still
// in the state we expected, so a rejection means another worker already settled this saga and
// moved its reserve into REVENUE. The books are then already correct and there is nothing of
// ours left to return; posting the reversal anyway would return the credits a second time, so
// we only flip the state and leave the ledger untouched. (See `assertAdvanced`.)
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
    // Pair the reversal with a "payout reversed" event, queued in the same transaction so it is
    // emitted if and only if the reversing posting committed. This is the normal-abandon branch
    // only; the early-return branch above (where another worker already settled the saga) posts
    // nothing and so emits nothing — that worker already consumed the reserve.
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
    });
  });
}

// The reason recorded when a payout is force-failed for sitting in SUBMITTED too long. A
// stable string (not a thrown-fault code) so dashboards can tell a provider timeout apart
// from a provider error: nothing rejected the disbursement, the provider just never reported
// back within `maxPayoutAgeMs`.
const PAYOUT_TIMEOUT_REASON = 'payout.timeout';

// Do the one step this payout is up to, chosen by its current step. A payout that has had
// its credits set aside ('RESERVED') gets submitted to the payment provider, moving it to
// 'SUBMITTED'; a submitted payout gets settled — unless it has been waiting on the provider
// past `maxPayoutAgeMs`, in which case it is force-failed instead of settled (see below).
// Any other state a due batch hands back (for example a leftover 'REQUESTED', or one already
// finished) is left untouched this run.
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
    // A payout that submitted to the provider but never came back can't settle — without a
    // cutoff it would sit in SUBMITTED forever, stranding the seller's reserved credits. Once
    // it has been waiting longer than `maxPayoutAgeMs` (measured from `updatedAt`, set when it
    // entered SUBMITTED in submitToProvider), force-fail it instead. The shared dead-letter
    // helper flips it to FAILED and, in the same transaction, posts the compensating reversal
    // that returns the reserved credits to the seller — so a timed-out payout is never paid
    // and never strands the reserve.
    if (ctx.clock.now() - saga.updatedAt > ctx.config.maxPayoutAgeMs) {
      await deadLetter(store, ctx, saga, PAYOUT_TIMEOUT_REASON);
      tally.deadLettered.push({ id: saga.id, reason: PAYOUT_TIMEOUT_REASON });
      return;
    }
    await settle(store, ctx, saga);
    tally.settled.push(saga.id);
  }
}

// Step 'RESERVED' -> 'SUBMITTED': hand the disbursement to the outside payment provider.
// The seller's earned credits were set aside (reserved) when the payout was requested;
// here we convert that reserve to USD at the current rate, ask the provider to pay it
// out, and record the provider's own reference for the payment. No ledger entry is posted
// at this step — the money already moved into the reserve account at request time. We also
// set when the worker should next check on it. If the provider call fails it is treated as
// a temporary error, so the error boundary in advanceOne can retry it later.
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

// Step 'SUBMITTED' -> 'SETTLED': record the money movement once the provider has paid.
// The two ledger entries and the step change all commit together in one database
// transaction, so a settled payout always has both entries posted, or neither. The step
// change only succeeds if the payout is still in 'SUBMITTED'; if another copy of this
// worker already settled it, the change returns false, the whole transaction (including
// the entries) rolls back via the thrown error in assertAdvanced, and the seller is never
// paid twice.
async function settle(store: Store, ctx: WorkerCtx, saga: Saga): Promise<void> {
  let rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  let usd = convert(saga.reserve, rate, 'USD');
  // The payout-rail fee (VRChat's third fee point — PayPal ≈1.5%, see config.payoutFeeBps) is the
  // rail's cut of the disbursement, NOT VRChat revenue: the gross `usd` leaves the trust account,
  // the rail keeps `fee`, and the creator receives `net`. We record fee + net for the audit trail;
  // the actual split happens at the external rail, downstream of USD_CLEARING.
  let fee = payoutFee(usd, ctx.config.payoutFeeBps);
  let net = toAmount('USD', usd.minor - fee.minor);

  await store.transaction(async (unit) => {
    await postSettlementEntries(unit, ctx, {
      saga,
      usd,
      fee,
      net,
      rateId: rate.rateId,
    });
    let advanced = await unit.sagas.advance(saga.id, 'SUBMITTED', 'SETTLED', {
      updatedAt: ctx.clock.now(),
    });
    assertAdvanced(advanced, saga, 'SETTLED');
    // Queue the "payout settled" event in the same transaction as the postings and the state
    // change, so it is saved if and only if the payout actually settled. If the state change was
    // rejected because another worker settled first, assertAdvanced above throws and rolls back
    // this queued event along with the entries — no event is emitted for a settle that didn't
    // take. Internal-only: it carries the money detail downstream consumers need.
    await unit.outbox.enqueue({
      id: ctx.ids.next('obx'),
      event: {
        id: ctx.ids.next('evt'),
        type: 'economy.payout.settled',
        version: 1,
        occurredAt: ctx.clock.now(),
        subject: saga.userId,
        data: {
          sagaId: saga.id,
          userId: saga.userId,
          reserve: encodeAmount(saga.reserve),
          usd: encodeAmount(usd),
          payoutFee: encodeAmount(fee),
          netUsd: encodeAmount(net),
          rateId: rate.rateId,
        },
        audience: 'internal',
      },
      status: 'pending',
      attempts: 0,
    });
  });
}

// The payout-rail fee on a gross USD disbursement, rounded down to whole minor units. `feeBps` is
// in basis points (150 = 1.5%); this is the rail's cut (e.g. PayPal's), deducted so the creator
// receives the net.
function payoutFee(gross: Amount, feeBps: number): Amount {
  return toAmount('USD', (gross.minor * BigInt(feeBps)) / 10_000n);
}

// Post the two ledger entries that record a settled payout, one per currency.
//
// The CREDIT entry empties the reserve account into the platform's revenue: the seller's
// set-aside credits become the platform's earnings, since the platform now owes the seller
// real money instead.
//
// The USD entry records the cash leaving the platform: USD_CLEARING (which mirrors money
// moving in and out of the trust account) is debited, and TRUST_CASH (the real cash the
// platform holds for users) is credited. TRUST_CASH grows on a debit, so crediting it
// lowers it — that drop is the cash the buyer already gave up back when they spent those
// credits, so the cash still backing money users can spend is never touched.
//
// Each entry balances on its own within its single currency.
async function postSettlementEntries(
  unit: Unit,
  ctx: WorkerCtx,
  entry: { saga: Saga; usd: Amount; fee: Amount; net: Amount; rateId: string },
): Promise<void> {
  let { saga, usd, fee, net, rateId } = entry;
  await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.PAYOUT_RESERVE, saga.reserve),
      credit(SYSTEM.REVENUE, saga.reserve),
    ],
    meta: { kind: 'payout.settle', sagaId: saga.id, rateId },
  });
  // The gross `usd` leaves the trust account. The rail keeps `payoutFee` and the creator receives
  // `netUsd`; that split is downstream at the external rail, so it is recorded here on the posting
  // for the audit trail rather than posted as ledger legs.
  await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [debit(SYSTEM.USD_CLEARING, usd), credit(SYSTEM.TRUST_CASH, usd)],
    meta: {
      kind: 'payout.settle.cash',
      sagaId: saga.id,
      rateId,
      payoutFee: encodeAmount(fee),
      netUsd: encodeAmount(net),
    },
  });
}

// Convert a CREDIT amount to USD at the given rate, rounding down. The rate is stored as
// whole numbers to stay exact (`rate` scaled by 10^scale), so the real multiplier is
// `rate / 10^scale`: multiply the credit amount by `rate`, then divide by 10^scale.
function convert(amount: Amount, rate: Rate, to: Amount['currency']): Amount {
  return toAmount(to, (amount.minor * rate.rate) / 10n ** BigInt(rate.scale));
}

// How long to wait after submitting before the worker tries to settle, in milliseconds.
// Uses the configured delay for the submitted step, falling back to the default delay;
// the final `?? 0` only guards against both being unset. (requestPayout reads the config
// the same way.)
function submittedSlaMs(ctx: WorkerCtx): number {
  let sla = ctx.config.payoutSla;
  return sla.SUBMITTED ?? sla.DEFAULT ?? 0;
}

// Fail loudly when the step change in `settle` didn't take, which means another copy of
// this worker already settled this payout. Throwing rolls back the ledger entries posted
// alongside it instead of paying the seller twice. The error is a permanent one, so the
// error boundary in advanceOne sets the payout aside rather than retrying a settle that
// would post the entries again.
function assertAdvanced(advanced: boolean, saga: Saga, to: SagaState): void {
  if (!advanced) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `payout saga ${saga.id} lost the CAS advancing ${saga.state} → ${to}.`,
      { detail: { sagaId: saga.id, from: saga.state, to } },
    );
  }
}
