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

import { ERROR_CODES, fault } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Rate, Saga, SagaState, Unit } from '#src/ports.ts';

/**
 * Settle a submitted payout: the SUBMITTED -> SETTLED step, driven by the provider's settlement
 * report instead of the background worker's sweep.
 *
 * This is the worker's `settle` (src/worker/payouts.ts) relocated into a system-actor operation so
 * an inbound provider webhook can trigger it. The money math is byte-for-byte the worker's: the same
 * rate/fee conversion, the same two coupled postings (credit side empties PAYOUT_RESERVE into
 * REVENUE; USD side debits USD_CLEARING / credits TRUST_CASH for the gross USD), the same
 * SUBMITTED -> SETTLED compare-and-set guard, and the same `economy.payout.settled` event enqueued
 * in the same transaction. The provider's settlement ref and reported amount ride along on the
 * operation for the audit trail; the posted figures are still the rate-derived ones, exactly as the
 * worker computes them, so conservation/backing/no-overdraft hold unchanged after a settle.
 *
 * System- or operator-only (see RESTRICTED_TO_PRIVILEGED in economy.ts): an end user must never
 * settle their own payout.
 *
 * Guards (mirroring the worker):
 * - Unknown sagaId → thrown fault (caller/webhook-mapping error, like reversePayout's loadSaga).
 * - Not SUBMITTED → thrown INVALID_TRANSITION: only a submitted payout has a disbursement to settle.
 * - Lost the SUBMITTED -> SETTLED compare-and-set (another worker/settle got there first) →
 *   `assertAdvanced` throws INVALID_TRANSITION, rolling back the two postings and the event so the
 *   seller is never paid twice.
 */
export async function settlePayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'settlePayout') {
    throw kindMismatch(operation);
  }

  let saga = await loadSaga(unit, operation.sagaId);
  refuseNotSubmitted(saga);

  // --- The worker's settle, byte-for-byte (src/worker/payouts.ts `settle`). ---
  let rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  let usd = convert(saga.reserve, rate, 'USD');
  // The payout-rail fee (the rail's processing cut, e.g. a payment processor at ≈1.5%, see
  // config.payoutFeeBps) is the rail's cut of the disbursement, not the platform's revenue: the
  // gross `usd` leaves the trust account, the rail keeps `fee`, the creator receives `net`. Fee +
  // net are recorded for the audit trail; the split happens at the external rail, downstream of
  // USD_CLEARING.
  let fee = payoutFee(usd, ctx.config.payoutFeeBps);
  let net = toAmount('USD', usd.minor - fee.minor);

  // The credit-side posting (empty the reserve into REVENUE) is the primary settle entry; its
  // transaction is the one returned as the committed Outcome. The USD-side posting commits in the
  // same transaction alongside it.
  let transaction = await postSettlementEntries(unit, ctx, {
    saga,
    usd,
    fee,
    net,
    rateId: rate.rateId,
  });
  // Record the gross USD disbursed on the saga as it settles, in the same transaction as the
  // postings and the state change, so the saga's terminal outcome is read straight off the record
  // instead of re-derived from posting meta. `usd` is the same rate-derived figure
  // the USD-side posting moves out of trust.
  let advanced = await unit.sagas.advance(saga.id, 'SUBMITTED', 'SETTLED', {
    updatedAt: ctx.clock.now(),
    payoutUsd: usd,
  });
  assertAdvanced(advanced, saga, 'SETTLED');
  // Queue the "payout settled" event in the same transaction as the postings and state change, so it
  // is saved iff the payout actually settled. If the compare-and-set was rejected because another
  // worker/settle got there first, assertAdvanced above throws and rolls back this event with the
  // entries, so no event emits for a settle that didn't take. Internal-only: carries the money detail
  // downstream consumers need. (settlePayout is not in economy.ts's EVENTS map, so this is enqueued
  // here rather than by the submit pipeline, keeping the event byte-for-byte the worker's.)
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
    reason: null,
  });

  return { status: 'committed', transaction };
}

// Load the saga by id. The webhook mapping (or operator) supplied it, so a missing saga is a
// caller/mapping error: throw a fault rather than a quiet "nothing to do" (matching reversePayout's
// loadSaga and reverse's unknown-txnId).
async function loadSaga(unit: Unit, sagaId: string): Promise<Saga> {
  let saga = await unit.sagas.load(sagaId);
  if (saga === null) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'settlePayout names a payout that does not exist.',
      { detail: { kind: 'settlePayout', sagaId } },
    );
  }
  return saga;
}

// A settle only applies to a payout the provider was actually handed (SUBMITTED), the one state with
// a disbursement to report settled. Any other state — REQUESTED/RESERVED not yet submitted, already
// SETTLED, or FAILED — has none, so refuse rather than post a second settle's worth of entries.
// Mirrors the worker's `driveTransition`, which only ever called `settle` on a SUBMITTED saga. Thrown
// as INVALID_TRANSITION so a redelivered or early webhook is a clear refusal.
function refuseNotSubmitted(saga: Saga): void {
  if (saga.state !== 'SUBMITTED') {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `cannot settle a payout that is not submitted: ${saga.id}.`,
      { detail: { sagaId: saga.id, state: saga.state } },
    );
  }
}

// Post the two ledger entries recording a settled payout, one per currency, exactly as the worker's
// `postSettlementEntries`. Each balances within its single currency. Returns the credit-side posting's
// transaction (the primary settle entry) for the committed Outcome; the USD-side posting commits in
// the same transaction.
//
// CREDIT entry: empty the reserve into REVENUE. The seller's set-aside credits become platform
// earnings, since the platform now owes the seller real money instead.
//
// USD entry: cash leaving the platform. Debit USD_CLEARING (mirrors money in/out of the trust
// account), credit TRUST_CASH (real cash held for users). TRUST_CASH grows on a debit, so crediting
// lowers it; that drop is the cash the buyer gave up when they spent those credits, so the cash
// backing spendable money is never touched.
async function postSettlementEntries(
  unit: Unit,
  ctx: Ctx,
  entry: { saga: Saga; usd: Amount; fee: Amount; net: Amount; rateId: string },
): Promise<Transaction> {
  let { saga, usd, fee, net, rateId } = entry;
  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.PAYOUT_RESERVE, saga.reserve),
      credit(SYSTEM.REVENUE, saga.reserve),
    ],
    meta: { kind: 'payout.settle', sagaId: saga.id, rateId },
  });
  // Gross `usd` leaves the trust account. The rail keeps `payoutFee` and the creator receives
  // `netUsd`; that split is downstream at the external rail, recorded here on the posting for the
  // audit trail rather than posted as ledger legs.
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
  return transaction;
}

// Payout-rail fee on a gross USD disbursement, rounded down to whole minor units. `feeBps` is in
// basis points (150 = 1.5%); the rail's cut (e.g. a payment processor's), deducted so the creator
// gets the net. Same calculation as the worker's `payoutFee`.
function payoutFee(gross: Amount, feeBps: number): Amount {
  return toAmount('USD', (gross.minor * BigInt(feeBps)) / 10_000n);
}

// Convert a CREDIT amount to USD at the given rate, rounding down. The rate is stored as integers
// for exactness (`rate` scaled by 10^scale), so the real multiplier is `rate / 10^scale`: multiply
// the credit amount by `rate`, then divide by 10^scale. Same conversion as the worker's `convert`.
function convert(amount: Amount, rate: Rate, to: Amount['currency']): Amount {
  return toAmount(to, (amount.minor * rate.rate) / 10n ** BigInt(rate.scale));
}

// Fail loudly when the compare-and-set didn't take, meaning another worker/settle already settled
// this payout. Throwing rolls back the two ledger entries posted alongside it (and the queued event)
// instead of paying the seller twice. The throw is safe to retry: a redelivered settle reloads the
// saga, finds it no longer SUBMITTED, and is turned away at `refuseNotSubmitted` before posting
// anything. Same guard as the worker's `assertAdvanced`.
function assertAdvanced(advanced: boolean, saga: Saga, to: SagaState): void {
  if (!advanced) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `payout saga ${saga.id} lost the CAS advancing ${saga.state} → ${to}.`,
      { detail: { sagaId: saga.id, from: saga.state, to } },
    );
  }
}

// Operations route to handlers by `kind`, so a wrong kind here means broken routing; throw rather
// than act on an operation this code wasn't built for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `settlePayout handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
