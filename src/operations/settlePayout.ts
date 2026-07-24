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
import { credit, debit, lockAll, postEntries } from '#src/ledger.ts';
import { encodeAmount, mulDiv, toAmount } from '#src/money.ts';
import {
  assertKind,
  assertSagaAnchored,
  loadSaga,
  noopTransaction,
} from '#src/operations/guards.ts';
import { pendingOutbox } from '#src/outbox.ts';
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

  const saga = await loadSaga(unit, operation);
  // A raced or redelivered settle: the disbursement is already recorded, so answer duplicate
  // the way reversePayout answers for an already-failed saga. An at-least-once rail re-sends
  // settlements under fresh event ids; that is normal traffic, not a fault.
  if (saga.state === 'SETTLED') {
    return { status: 'duplicate', transaction: noopTransaction() };
  }
  refuseNotSubmitted(saga);

  // The quote requestPayout priced and sealed into the reserve posting's hashed metadata — the
  // same USD the worker submitted to the rail. The saga row is re-proved against that anchor
  // first, so an edited row cannot settle a different amount out of trust.
  const usd = await assertSagaAnchored(
    { ledger: unit.ledger, digest: ctx.digest },
    saga,
  );
  // The payout-rail fee (config.payoutFeeBps) is the rail's cut, not platform revenue. The gross
  // `usd` leaves trust, the rail keeps `fee`, and the seller gets `net`. The split happens at the
  // external rail downstream of USD_CLEARING, so `fee` and `net` are recorded for audit rather than
  // posted as legs.
  const fee = payoutFee(usd, ctx.config.payoutFeeBps);
  const net = toAmount('USD', usd.minor - fee.minor);

  const transaction = await postSettlementEntries(unit, ctx, {
    saga,
    usd,
    fee,
    net,
    rateId: saga.rateId,
  });
  // Record the gross USD on the saga in the same transaction as the postings and state change, so
  // the terminal outcome reads straight off the record instead of being re-derived from posting meta.
  const advanced = await unit.sagas.advance(saga.id, 'SUBMITTED', 'SETTLED', {
    updatedAt: ctx.clock.now(),
    payoutUsd: usd,
  });
  assertAdvanced(advanced, saga, 'SETTLED');
  // Queue the "payout settled" event in the same transaction as the postings and state change, so a
  // lost CAS (assertAdvanced throws) rolls it back with the entries and no event emits for a settle
  // that did not take. settlePayout is not in economy.ts's EVENTS map, so it is enqueued here rather
  // than by the submit pipeline, keeping it identical to the worker's.
  await unit.outbox.enqueue(
    pendingOutbox(ctx.ids, {
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
        rateId: saga.rateId,
      },
      audience: 'internal',
    }),
  );

  return { status: 'committed', transaction };
}

// Only SUBMITTED has a disbursement to report settled. A webhook that raced the submit sweep
// (REQUESTED or RESERVED) is retryable: the sweep will submit and the redelivery settles then.
// A FAILED saga already returned its reserve, so a settle claim against it is a real conflict
// for an operator, never a retry.
function refuseNotSubmitted(saga: Saga): void {
  if (saga.state !== 'SUBMITTED') {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      'Cannot settle a payout that is not submitted.',
      {
        detail: { sagaId: saga.id, state: saga.state },
        retryable: saga.state !== 'FAILED',
      },
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
  // The CREDIT and USD sides share no account, so postEntries can fuse the pair.
  const [transaction] = await postEntries(unit.ledger, [
    {
      txnId: ctx.ids.next('txn'),
      legs: [
        debit(reserveRef, saga.reserve),
        credit(SYSTEM.REVENUE, saga.reserve),
      ],
      meta: { kind: 'settlePayout', sagaId: saga.id, rateId },
    },
    {
      txnId: ctx.ids.next('txn'),
      legs: [debit(SYSTEM.USD_CLEARING, usd), credit(SYSTEM.TRUST_CASH, usd)],
      meta: {
        kind: 'settlePayout.cash',
        sagaId: saga.id,
        rateId,
        payoutFee: encodeAmount(fee),
        netUsd: encodeAmount(net),
      },
    },
  ]);
  return transaction!;
}

// Rail fee on the gross USD disbursement, rounded down. `feeBps` is basis points (150 = 1.5%).
function payoutFee(gross: Amount, feeBps: number): Amount {
  return toAmount('USD', mulDiv(gross.minor, BigInt(feeBps), 10_000n, 'floor'));
}

// A lost CAS throws, rolling back the two entries and the queued event. Safe to retry: a
// redelivered settle finds the saga no longer SUBMITTED and is refused before posting anything.
// See https://economy-lab-docs.pages.dev/economy/concepts/payout-saga/ for how a compare-and-set
// posts its money in the same transaction, so a re-driven step takes effect at most once.
function assertAdvanced(advanced: boolean, saga: Saga, to: SagaState): void {
  if (!advanced) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      'The payout was advanced by another actor first.',
      { detail: { sagaId: saga.id, from: saga.state, to }, retryable: true },
    );
  }
}
