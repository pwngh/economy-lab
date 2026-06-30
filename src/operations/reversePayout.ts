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
import { assertKind } from '#src/operations/guards.ts';

import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Undoes an in-flight payout by hand: the manual version of the worker's give-up undo. The move to
 * FAILED (so the worker never pays it) and the undo posting (reserve back to the seller's earned
 * account) commit together: the credits return only if the saga also stops. This is why it does not
 * use the generic `reverse`, which leaves saga state alone, so a reversed-but-still-RESERVED saga
 * would be paid out anyway.
 *
 * RESERVED, or SUBMITTED aged past `config.maxPayoutAgeMs`, moves to FAILED and posts the undo.
 * SETTLED and still-live SUBMITTED both throw `INVALID_TRANSITION`: returning a reserve already
 * disbursed, or one the provider may still settle, risks a double-pay.
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
  assertKind(operation, 'reversePayout');
  assertReason(operation.reason);

  let saga = await loadSaga(unit, operation.sagaId);
  assertUserMatchesSaga(operation.userId, saga);
  refuseSettled(saga);
  refuseLiveSubmitted(saga, ctx);

  // Only RESERVED or SUBMITTED has credits in PAYOUT_RESERVE to return. FAILED was already undone
  // by the worker or an earlier call. Any other state, such as REQUESTED before credits hit the
  // reserve, has nothing to give back. We treat both as already handled.
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

  // This is the same undo the worker posts. It moves the reserved amount out of PAYOUT_RESERVE
  // back into the seller's earned account. The debit and credit balance in CREDIT. It commits in
  // the same transaction as the state change above, so the two cannot come apart.
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

// Loads the saga by id. The operator typed the id, so a missing saga is operator error. It throws
// a fault rather than a normal "no", matching how `reverse` handles an unknown txnId.
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
// saga.userId. If the two differ, we would credit an unlocked account, which is open to a
// concurrent write. Reject the mismatch so the locked account is the one we credit. The posting
// uses saga.userId either way.
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

// A SUBMITTED payout is still live until it ages past `maxPayoutAgeMs`, measured from `updatedAt`
// (set on entering SUBMITTED in submitToProvider). This mirrors the worker's force-fail cutoff with
// the same `now - updatedAt` comparison, so a manual reverse is rejected until then. RESERVED is not
// gated here because it was never handed to the provider.
// See https://economy-lab-docs.pages.dev/economy/reference/operations/reverse-payout/ for why
// reversing a still-settling payout risks a double-pay and how the timeout cutoff opens the window.
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

// Requires a non-blank reason so the reversal records why it happened, for audit. A missing or
// whitespace-only reason is operator error, matching `reverse`.
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
