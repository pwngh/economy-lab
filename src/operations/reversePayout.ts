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
 * Undo an in-flight payout by hand. Manual version of the undo the background payout worker
 * does automatically when it gives up.
 *
 * The saga's FAILED transition (so the worker never pays it) and the undo posting (reserve back
 * to the seller's earned account) commit together in one transaction, so the credits return only
 * if the saga also stops. Not the generic `reverse`, which posts the opposite entry but leaves
 * saga state alone: reversing a RESERVED reservation would leave it RESERVED and the worker would
 * still pay it, so the seller would get the money back and the payout would go through anyway.
 *
 * Refusals and edge cases:
 * - SETTLED → throws `INVALID_TRANSITION`: already paid out real money, no reserve left to
 *   return; undoing would credit the seller twice. Posts nothing.
 * - SUBMITTED not yet aged past `config.maxPayoutAgeMs` (from `updatedAt`, set on entering
 *   SUBMITTED) → throws `INVALID_TRANSITION`: disbursement is in the provider's hands and may
 *   still settle externally, so returning the reserve now risks a double-pay. Mirrors the
 *   worker's SUBMITTED-timeout cutoff; past it, the provider is presumed never to have paid and
 *   the reverse is allowed. Posts nothing.
 * - RESERVED, or SUBMITTED aged past the cutoff → moves the saga to FAILED and posts the undo
 *   (debit PAYOUT_RESERVE, credit the seller's earned account, full reserved amount).
 * - Guarded state change loses to a concurrent worker → returns `duplicate`, posts nothing; the
 *   reserve was already spent or returned by whoever moved it first.
 * - Unknown sagaId is operator typo → throws a fault rather than a quiet "nothing to do", as
 *   `reverse` does for an unknown transaction id.
 *
 * The `economy.payout.reversed` event is emitted by the submit pipeline on commit, not here.
 *
 * @example
 *   let outcome = await reversePayout(
 *     { kind: 'reversePayout', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       userId: 'usr_seller', sagaId: 'pay_1', reason: 'fraud hold' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; the reserve returned to usr_seller's earned, saga FAILED.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/reverse-payout/ Reverse payout} for manually unwinding an in-flight payout saga.
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

  // Only RESERVED or SUBMITTED has credits in PAYOUT_RESERVE to return. FAILED was already undone
  // (worker or an earlier call); any other state (e.g. REQUESTED, before credits hit reserve) has
  // nothing to give back. Treat both as already-handled.
  if (saga.state !== 'RESERVED' && saga.state !== 'SUBMITTED') {
    return { status: 'duplicate', transaction: noopTransaction() };
  }

  // Move the saga to FAILED only if still in its current state (the worker's give-up change).
  // A false return means another worker advanced it between our read and now, leaving nothing to
  // undo.
  let advanced = await unit.sagas.advance(saga.id, saga.state, 'FAILED', {
    updatedAt: ctx.clock.now(),
  });
  if (!advanced) {
    return { status: 'duplicate', transaction: noopTransaction() };
  }

  // Same undo the worker posts: move the reserved amount out of PAYOUT_RESERVE back into the
  // seller's earned account. Debit + credit balance in CREDIT. Commits in the same transaction
  // as the state change above, so the two can't come apart.
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

// Load the saga by id. The operator typed it, so a missing saga is operator error: throw a fault
// rather than a normal "no" (matching `reverse`'s unknown-txnId).
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

// The framework locks the accounts named by operation.userId, but the undo posting credits
// saga.userId. If they differ, we'd credit an unlocked account, open to a concurrent write.
// Reject the mismatch so the locked account is the one we credit; the posting uses saga.userId
// either way.
function assertUserMatchesSaga(userId: string, saga: Saga): void {
  if (userId !== saga.userId) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reversePayout userId does not match the payout it names.',
      { detail: { sagaId: saga.id, userId, sagaUserId: saga.userId } },
    );
  }
}

// A settled payout already disbursed real money; its reserve was consumed into REVENUE, leaving
// nothing to return. Reversing would credit the seller twice, so throw rather than return "no".
function refuseSettled(saga: Saga): void {
  if (saga.state === 'SETTLED') {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      `cannot reverse a settled payout: ${saga.id}.`,
      { detail: { sagaId: saga.id, state: saga.state } },
    );
  }
}

// A SUBMITTED payout's disbursement is in the provider's hands and may still settle externally;
// reversing now and then having the provider pay would double-pay the seller. The worker treats
// SUBMITTED as live until it ages past `maxPayoutAgeMs` (from `updatedAt`, set on entering
// SUBMITTED in submitToProvider), then force-fails it. Mirror that cutoff with the same
// `now - updatedAt` comparison: reject a manual reverse before the payout ages past it. Past the
// cutoff the provider is presumed never to have paid, so reversing is allowed (and matches the
// worker). RESERVED was never handed to the provider, so it has no live settlement to race and
// isn't gated here.
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

// A reversal must record its reason for audit. Missing or whitespace-only is operator error
// (matching `reverse`).
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reversePayout requires a non-empty reason.',
      { detail: { kind: 'reversePayout' } },
    );
  }
}

// On a lost guarded state change there's no ledger posting, but the `duplicate` result still has
// to carry a transaction. Return an empty placeholder with no entries.
function noopTransaction(): Transaction {
  return { id: '', postedAt: 0, legs: [], links: [] };
}

// Operations route to handlers by `kind`, so a wrong kind here means broken routing; throw rather
// than act on an operation this code wasn't built for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
