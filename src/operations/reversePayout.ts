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
import { earned, SYSTEM } from '#src/accounts.ts';

import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Undo a payout that has not yet paid out real money. An operator runs this by hand to pull
 * back a single in-flight payout; it is the manual version of the undo the background payout
 * worker performs automatically when it gives up on a payout.
 *
 * Each payout is tracked by a saga — a small state record (REQUESTED, RESERVED, SUBMITTED,
 * SETTLED, FAILED) that the background worker steps forward one stage at a time. Requesting a
 * payout moved the seller's earned credits (the money the platform owes them as a seller) out
 * of their account into PAYOUT_RESERVE, the escrow holding pending payouts. Left alone, the
 * background worker would eventually pay those credits out to the platform. To pull a payout
 * back, two things must happen together: the saga must move to its final FAILED state (so the
 * worker never pays it out), and the reserved credits must return to the seller's earned
 * account. This handler does both in one transaction, using the same guarded state change the
 * worker uses to give up, so the credits are returned only if the saga is also stopped — never
 * one without the other.
 *
 * Why this is NOT the generic `reverse` operation: `reverse` posts the opposite entry of a
 * named transaction but does not touch saga state, so reversing the reservation entry of a
 * RESERVED payout would leave the saga RESERVED and the worker would still pay it out — the
 * seller would get the money back AND the payout would go through. This operation moves the
 * saga to FAILED and posts the undo together, in one transaction, so that cannot happen.
 *
 * Refusals and edge cases:
 * - SETTLED → throws `INVALID_TRANSITION`: the payout already paid out real money, so there is
 *   no reserve left to return; undoing it would credit the seller a second time. Posts nothing.
 * - SUBMITTED but not yet aged past `config.maxPayoutAgeMs` (measured from `updatedAt`, set when
 *   it entered SUBMITTED) → throws `INVALID_TRANSITION`: the disbursement is in the provider's
 *   hands and may STILL settle externally, so handing the reserve back now risks a double-pay.
 *   This mirrors the worker's own SUBMITTED-timeout cutoff; once a payout ages past it the
 *   provider is presumed never to have paid and the reverse is allowed. Posts nothing.
 * - RESERVED, or SUBMITTED aged past the cutoff → moves the saga to FAILED and posts the undo
 *   (debit PAYOUT_RESERVE, credit the seller's earned account, for the full reserved amount).
 * - The guarded state change can fail if another worker already moved this saga forward between
 *   our read and now → returns `duplicate`, posting nothing, since the reserve was already
 *   spent or returned by whoever moved it first.
 * - An unknown sagaId means the operator mistyped it, so this throws a fault rather than
 *   returning a quiet "nothing to do" — the same way `reverse` treats an unknown transaction id.
 *
 * The `economy.payout.reversed` event (what observers see when a payout is reversed) is emitted
 * elsewhere, by the submit pipeline when this transaction commits, not by this handler.
 *
 * @example
 *   let outcome = await reversePayout(
 *     { kind: 'reversePayout', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       userId: 'usr_seller', sagaId: 'pay_1', reason: 'fraud hold' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; the reserve returned to usr_seller's earned, saga FAILED.
 */
export async function reversePayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'reversePayout') {
    throw kindMismatch(operation);
  }
  assertReason(operation.reason);

  let saga = await loadSaga(unit, operation.sagaId);
  assertUserMatchesSaga(operation.userId, saga);
  refuseSettled(saga);
  refuseLiveSubmitted(saga, ctx);

  // Only a payout still in flight (RESERVED or SUBMITTED) has credits sitting in PAYOUT_RESERVE
  // to return. A FAILED saga was already undone (by the worker or an earlier call), so doing it
  // again would be a repeat — report it as already-handled. Any other state (such as REQUESTED,
  // before the credits were ever moved into reserve) has nothing in reserve to give back, so
  // undoing it would pull out money that isn't there — treat it as nothing to do.
  if (saga.state !== 'RESERVED' && saga.state !== 'SUBMITTED') {
    return { status: 'duplicate', transaction: noopTransaction() };
  }

  // Move the saga from its current state to the final FAILED state, but only if it is still in
  // that current state — the same guarded change the worker uses when it gives up on a payout.
  // A false return means another worker already moved this saga forward between our read and now,
  // so there is nothing left for us to undo.
  let advanced = await unit.sagas.advance(saga.id, saga.state, 'FAILED', {
    updatedAt: ctx.clock.now(),
  });
  if (!advanced) {
    return { status: 'duplicate', transaction: noopTransaction() };
  }

  // Post the exact same undo the worker posts when it gives up: move the reserved amount out of
  // PAYOUT_RESERVE and back into the seller's earned account. The two lines below (a debit and a
  // credit, the entries that make up one posting) are in CREDIT and cancel out. This posting
  // commits in the same transaction as the state change above, so the two cannot come apart.
  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.PAYOUT_RESERVE, saga.reserve),
      credit(earned(saga.userId), saga.reserve),
    ],
    meta: {
      kind: 'payout.reversePayout',
      sagaId: saga.id,
      reason: operation.reason,
    },
  });

  return { status: 'committed', transaction };
}

// Load the saga to reverse, by its id. The operator typed this id, so a missing saga is operator
// error: throw a fault rather than return a normal "no" (matching `reverse`'s unknown-txnId).
async function loadSaga(unit: Unit, sagaId: string): Promise<Saga> {
  let saga = await unit.sagas.load(sagaId);
  if (saga === null) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reversePayout names a payout that does not exist.',
      { detail: { kind: 'reversePayout', sagaId } },
    );
  }
  return saga;
}

// The operation names both the sagaId and the userId whose earned account the reserve returns to.
// Before running, the framework locks the accounts named by operation.userId so no other write
// can touch them mid-operation — but the undo posting below credits the account from saga.userId.
// If an operator passes a userId that does not match the saga's seller, the account we credit
// would be one that was never locked, leaving it open to a concurrent write. Reject the mismatch
// up front so the locked account is guaranteed to be the one we credit; the posting always uses
// saga.userId either way.
function assertUserMatchesSaga(userId: string, saga: Saga): void {
  if (userId !== saga.userId) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reversePayout userId does not match the payout it names.',
      { detail: { sagaId: saga.id, userId, sagaUserId: saga.userId } },
    );
  }
}

// Refuse to reverse a settled payout: it already disbursed real money, so its reserve was
// consumed into REVENUE and there is nothing of ours to return. Reversing anyway would credit the
// seller a second time, so this is a thrown fault, never a routine "no".
function refuseSettled(saga: Saga): void {
  if (saga.state === 'SETTLED') {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `cannot reverse a settled payout: ${saga.id}.`,
      { detail: { sagaId: saga.id, state: saga.state } },
    );
  }
}

// Refuse to hand the reserve back while a SUBMITTED payout may STILL settle externally. Once a
// payout enters SUBMITTED the disbursement is already in the provider's hands; if an operator
// reverses it now and the provider then pays out, the seller gets the money twice — a double-pay.
// The background worker treats a SUBMITTED payout as live until it has been waiting longer than
// `maxPayoutAgeMs` (measured from `updatedAt`, set when it entered SUBMITTED in submitToProvider),
// only then force-failing it. Mirror that exact cutoff here: reject a manual reverse of a
// SUBMITTED payout that has not yet aged past `maxPayoutAgeMs`, using the same `now - updatedAt`
// comparison the worker uses, so a hand-run reverse can't race a live provider settlement. Once a
// payout has aged past the cutoff the provider is presumed never to have paid, so reversing it is
// allowed (and matches what the worker would itself do). A RESERVED payout was never handed to the
// provider, so it has no live settlement to race and is not gated here.
function refuseLiveSubmitted(saga: Saga, ctx: Ctx): void {
  if (
    saga.state === 'SUBMITTED' &&
    ctx.clock.now() - saga.updatedAt <= ctx.config.maxPayoutAgeMs
  ) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `cannot reverse a submitted payout still within its provider settlement window: ${saga.id}.`,
      {
        detail: {
          sagaId: saga.id,
          state: saga.state,
          ageMs: ctx.clock.now() - saga.updatedAt,
          maxPayoutAgeMs: ctx.config.maxPayoutAgeMs,
        },
      },
    );
  }
}

// A reversal must record why it happened, so an audit can see who pulled back which payout and on
// what grounds. A missing or whitespace-only reason is operator error (matching `reverse`).
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reversePayout requires a non-empty reason.',
      { detail: { kind: 'reversePayout' } },
    );
  }
}

// When the guarded state change loses to another worker, this handler posts no ledger entry —
// but the `duplicate` result still has to carry a transaction. There is no real posting to
// return, since whoever won already did the work, so this returns an empty placeholder
// transaction with no entries of its own.
function noopTransaction(): Transaction {
  return { id: '', postedAt: 0, legs: [], links: [] };
}

// Operations are routed to handlers by their `kind`, so reaching this handler with any other kind
// means the routing is wired wrong; throw a loud fault rather than act on an operation this code
// wasn't built for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
