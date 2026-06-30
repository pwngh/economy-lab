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
 * Undoes an in-flight payout by hand. This is the manual version of the undo that the background
 * payout worker does automatically when it gives up.
 *
 * Two things commit together in one transaction: the saga's transition to FAILED, so the worker
 * never pays it, and the undo posting that moves the reserve back to the seller's earned account.
 * The credits return only if the saga also stops. This is why the operation does not use the
 * generic `reverse`. That helper posts the opposite entry but leaves saga state alone. Reversing a
 * RESERVED reservation would leave it RESERVED, the worker would still pay it, and the seller would
 * get the money back while the payout went through anyway.
 *
 * Refusals and edge cases:
 * - SETTLED throws `INVALID_TRANSITION`. The payout already disbursed real money, so no reserve is
 *   left to return. Undoing would credit the seller twice. Posts nothing.
 * - SUBMITTED that has not yet aged past `config.maxPayoutAgeMs` throws `INVALID_TRANSITION`. The
 *   age is measured from `updatedAt`, set on entering SUBMITTED. The disbursement is in the
 *   provider's hands and may still settle externally, so returning the reserve now risks a
 *   double-pay. This mirrors the worker's SUBMITTED-timeout cutoff. Past the cutoff, the provider
 *   is presumed never to have paid and the reverse is allowed. Posts nothing.
 * - RESERVED, or SUBMITTED aged past the cutoff, moves the saga to FAILED and posts the undo
 *   (debit PAYOUT_RESERVE, credit the seller's earned account, full reserved amount).
 * - A guarded state change that loses to a concurrent worker returns `duplicate` and posts
 *   nothing. The reserve was already spent or returned by whoever moved it first.
 * - An unknown sagaId is an operator typo. It throws a fault rather than a quiet "nothing to do",
 *   as `reverse` does for an unknown transaction id.
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

// A SUBMITTED payout's disbursement is in the provider's hands and may still settle externally. If
// we reverse now and the provider then pays, the seller is double-paid. The worker treats
// SUBMITTED as live until it ages past `maxPayoutAgeMs`, measured from `updatedAt` (set on entering
// SUBMITTED in submitToProvider), then force-fails it. We mirror that cutoff with the same
// `now - updatedAt` comparison and reject a manual reverse before the payout ages past it. Past the
// cutoff the provider is presumed never to have paid, so reversing is allowed and matches the
// worker. RESERVED was never handed to the provider, so it has no live settlement to race and is
// not gated here.
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
