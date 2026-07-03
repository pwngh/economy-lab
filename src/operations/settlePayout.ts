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
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { convertFloor, encodeAmount, toAmount } from '#src/money.ts';
import { assertKind } from '#src/operations/guards.ts';
import { platformShard, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Saga, SagaState, Unit } from '#src/ports.ts';

/**
 * Settles a submitted payout (SUBMITTED to SETTLED), driven by the provider's settlement report.
 *
 * A system-actor operation, so the provider's inbound webhook can trigger it. The worker sweep
 * never settles; it only re-drives and force-fails stale payouts (src/worker/payouts.ts).
 * Restricted to system or operator (RESTRICTED_TO_PRIVILEGED in economy.ts): an end
 * user must never settle their own payout. Losing the SUBMITTED to SETTLED CAS rolls back the two
 * postings and the event, so the seller is never paid twice.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/settle-payout/ Settle
 *   payout} for the webhook-driven SUBMITTED to SETTLED settlement step.
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/processor/ Processor} for the
 *   settlement and dispute callback contract.
 */
export async function settlePayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'settlePayout');

  const saga = await loadSaga(unit, operation.sagaId);
  refuseNotSubmitted(saga);

  const rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  const usd = convertFloor(saga.reserve, rate, 'USD');
  // The payout-rail fee (config.payoutFeeBps) is the rail's cut, not platform revenue. The gross
  // `usd` leaves trust, the rail keeps `fee`, and the seller gets `net`. The split happens at the
  // external rail downstream of USD_CLEARING, so `fee` and `net` are recorded for audit rather than
  // posted as legs.
  const fee = payoutFee(usd, ctx.config.payoutFeeBps);
  const net = toAmount('USD', usd.minor - fee.minor);

  // The credit-side posting empties the reserve into REVENUE and is the primary settle entry. Its
  // transaction is the one returned as the committed Outcome. The USD-side posting commits in the
  // same transaction alongside it.
  const transaction = await postSettlementEntries(unit, ctx, {
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
  const advanced = await unit.sagas.advance(saga.id, 'SUBMITTED', 'SETTLED', {
    updatedAt: ctx.clock.now(),
    payoutUsd: usd,
  });
  assertAdvanced(advanced, saga, 'SETTLED');
  // Queue the "payout settled" event in the same transaction as the postings and state change, so a
  // lost CAS (assertAdvanced throws) rolls it back with the entries and no event emits for a settle
  // that did not take. settlePayout is not in economy.ts's EVENTS map, so it is enqueued here rather
  // than by the submit pipeline, keeping it identical to the worker's.
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
  const saga = await unit.sagas.load(sagaId);
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

// Posts the two ledger entries that record a settled payout, one per currency. Each entry
// balances within its single currency. It returns the credit-side posting's transaction, the
// primary settle entry, for the committed Outcome. The USD-side posting commits in the same
// transaction.
// See https://economy-lab-docs.pages.dev/economy/reference/operations/settle-payout/ for what each
// entry does: the reserve clears into REVENUE, and the gross USD leaves TRUST_CASH via USD_CLEARING.
async function postSettlementEntries(
  unit: Unit,
  ctx: Ctx,
  entry: { saga: Saga; usd: Amount; fee: Amount; net: Amount; rateId: string },
): Promise<Transaction> {
  const { saga, usd, fee, net, rateId } = entry;
  // The lock set only knew the sagaId, so it locked the bare reserve; the reserve actually sits on
  // the shard routed by the saga's user — lock that one too before debiting it. The other platform
  // legs stay bare: worker cadence, and unlike the reserve they may go negative safely.
  const reserveRef = platformShard(
    SYSTEM.PAYOUT_RESERVE,
    saga.userId,
    ctx.config.platformShards,
  );
  if (reserveRef !== SYSTEM.PAYOUT_RESERVE) {
    await lockAll(unit.ledger, [reserveRef]);
  }
  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(reserveRef, saga.reserve),
      credit(SYSTEM.REVENUE, saga.reserve),
    ],
    meta: { kind: 'payout.settle', sagaId: saga.id, rateId },
  });
  // The gross `usd` leaves the trust account. The rail keeps `payoutFee` and the seller receives
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
// processor's, and it is deducted so the seller gets the net.
function payoutFee(gross: Amount, feeBps: number): Amount {
  return toAmount('USD', (gross.minor * BigInt(feeBps)) / 10_000n);
}

// Throws when the CAS did not take (another worker or settle got there first), rolling back the
// two entries and the queued event so the seller is not paid twice. Safe to retry: a redelivered
// settle reloads the saga, finds it no longer SUBMITTED, and is turned away at `refuseNotSubmitted`
// before posting anything.
// See https://economy-lab-docs.pages.dev/economy/concepts/lifecycles/ for how a compare-and-set
// posts its money in the same transaction, so a re-driven step takes effect at most once.
function assertAdvanced(advanced: boolean, saga: Saga, to: SagaState): void {
  if (!advanced) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `payout saga ${saga.id} lost the CAS advancing ${saga.state} -> ${to}.`,
      { detail: { sagaId: saga.id, from: saga.state, to } },
    );
  }
}
