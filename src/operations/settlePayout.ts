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
import { convertFloor, encodeAmount, toAmount } from '#src/money.ts';
import { assertKind } from '#src/operations/guards.ts';
import { SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Saga, SagaState, Unit } from '#src/ports.ts';

/**
 * Settles a submitted payout. This is the SUBMITTED to SETTLED step, driven by the provider's
 * settlement report instead of the background worker's sweep.
 *
 * This is the worker's `settle` (src/worker/payouts.ts) relocated into a system-actor operation so
 * an inbound provider webhook can trigger it. The money math is identical to the worker's. It runs
 * the same rate and fee conversion. It writes the same two coupled postings: the credit side empties
 * PAYOUT_RESERVE into REVENUE, and the USD side debits USD_CLEARING and credits TRUST_CASH for the
 * gross USD. It applies the same SUBMITTED to SETTLED compare-and-set guard. It enqueues the same
 * `economy.payout.settled` event in the same transaction. The provider's settlement ref and reported
 * amount are carried on the operation for the audit trail. The posted figures are still the
 * rate-derived ones, exactly as the worker computes them, so conservation, backing, and no-overdraft
 * hold unchanged after a settle.
 *
 * This operation is restricted to the system or an operator (see RESTRICTED_TO_PRIVILEGED in
 * economy.ts), because an end user must never settle their own payout.
 *
 * Guards (mirroring the worker):
 * - An unknown sagaId throws a fault. This is a caller or webhook-mapping error, like
 *   reversePayout's loadSaga.
 * - A non-SUBMITTED saga throws INVALID_TRANSITION, because only a submitted payout has a
 *   disbursement to settle.
 * - Losing the SUBMITTED to SETTLED compare-and-set means another worker or settle got there first.
 *   `assertAdvanced` then throws INVALID_TRANSITION, which rolls back the two postings and the event
 *   so the seller is never paid twice.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/settle-payout/ Settle payout} for the webhook-driven SUBMITTED to SETTLED settlement step.
 */
export async function settlePayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'settlePayout');

  let saga = await loadSaga(unit, operation.sagaId);
  refuseNotSubmitted(saga);

  // --- The worker's settle, computed identically (src/worker/payouts.ts `settle`). ---
  let rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  let usd = convertFloor(saga.reserve, rate, 'USD');
  // The payout-rail fee (config.payoutFeeBps) is the rail's cut, not platform revenue. The gross
  // `usd` leaves trust, the rail keeps `fee`, and the creator gets `net`. The split happens at the
  // external rail downstream of USD_CLEARING, so `fee` and `net` are recorded for audit rather than
  // posted as legs.
  let fee = payoutFee(usd, ctx.config.payoutFeeBps);
  let net = toAmount('USD', usd.minor - fee.minor);

  // The credit-side posting empties the reserve into REVENUE and is the primary settle entry. Its
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
  // postings and the state change. This lets the saga's terminal outcome be read straight off the
  // record instead of re-derived from posting meta. `usd` is the same rate-derived figure the
  // USD-side posting moves out of trust.
  let advanced = await unit.sagas.advance(saga.id, 'SUBMITTED', 'SETTLED', {
    updatedAt: ctx.clock.now(),
    payoutUsd: usd,
  });
  assertAdvanced(advanced, saga, 'SETTLED');
  // Queue the "payout settled" event in the same transaction as the postings and state change, so it
  // is saved only if the payout actually settled. If the compare-and-set was rejected because another
  // worker or settle got there first, assertAdvanced above throws and rolls back this event with the
  // entries, so no event emits for a settle that did not take. The event is internal-only and carries
  // the money detail downstream consumers need. settlePayout is not in economy.ts's EVENTS map, so
  // the event is enqueued here rather than by the submit pipeline, which keeps it identical to the
  // worker's.
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

// Loads the saga by id. The webhook mapping or operator supplied the id, so a missing saga is a
// caller or mapping error. It throws a fault rather than treating the miss as a quiet "nothing to
// do", matching reversePayout's loadSaga and reverse's unknown-txnId handling.
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

// Refuses a settle unless the saga is SUBMITTED. A settle only applies to a payout the provider was
// actually handed, which is the one state with a disbursement to report settled. Every other state
// has no such disbursement: REQUESTED or RESERVED is not yet submitted, SETTLED is already done, and
// FAILED is terminal. Refusing here avoids posting a second settle's worth of entries. This mirrors
// the worker's `driveTransition`, which only ever called `settle` on a SUBMITTED saga. It throws
// INVALID_TRANSITION so a redelivered or early webhook gets a clear refusal.
function refuseNotSubmitted(saga: Saga): void {
  if (saga.state !== 'SUBMITTED') {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `cannot settle a payout that is not submitted: ${saga.id}.`,
      { detail: { sagaId: saga.id, state: saga.state } },
    );
  }
}

// Posts the two ledger entries that record a settled payout, one per currency, exactly as the
// worker's `postSettlementEntries`. Each entry balances within its single currency. It returns the
// credit-side posting's transaction, the primary settle entry, for the committed Outcome. The
// USD-side posting commits in the same transaction.
//
// The CREDIT entry empties the reserve into REVENUE. The seller's set-aside credits become platform
// earnings, because the platform now owes the seller real money instead.
//
// The USD entry records cash leaving the platform. It debits USD_CLEARING, which mirrors money
// moving in and out of the trust account, and credits TRUST_CASH, the real cash held for users.
// TRUST_CASH grows on a debit, so crediting it lowers it. That drop is the cash the buyer gave up
// when they spent those credits, so the cash backing spendable money is never touched.
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
  // The gross `usd` leaves the trust account. The rail keeps `payoutFee` and the creator receives
  // `netUsd`. That split happens downstream at the external rail, so it is recorded here on the
  // posting for the audit trail rather than posted as ledger legs.
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

// Computes the payout-rail fee on a gross USD disbursement, rounded down to whole minor units.
// `feeBps` is in basis points, so 150 means 1.5%. The fee is the rail's cut, such as a payment
// processor's, and it is deducted so the creator gets the net. This is the same calculation as the
// worker's `payoutFee`.
function payoutFee(gross: Amount, feeBps: number): Amount {
  return toAmount('USD', (gross.minor * BigInt(feeBps)) / 10_000n);
}

// Fails loudly when the compare-and-set did not take, which means another worker or settle already
// settled this payout. Throwing rolls back the two ledger entries posted alongside it, along with the
// queued event, instead of paying the seller twice. The throw is safe to retry. A redelivered settle
// reloads the saga, finds it no longer SUBMITTED, and is turned away at `refuseNotSubmitted` before
// posting anything. This is the same guard as the worker's `assertAdvanced`.
function assertAdvanced(advanced: boolean, saga: Saga, to: SagaState): void {
  if (!advanced) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `payout saga ${saga.id} lost the CAS advancing ${saga.state} → ${to}.`,
      { detail: { sagaId: saga.id, from: saga.state, to } },
    );
  }
}
