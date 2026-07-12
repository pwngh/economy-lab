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
import { earned, routePlatformLegs, SYSTEM } from '#src/accounts.ts';
import { assertKind } from '#src/operations/guards.ts';

import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Undoes an in-flight payout: the manual version of the worker's give-up undo, and the operation a
 * verified payout-failed webhook applies. The move to FAILED (so the worker never pays it) and the
 * undo posting (reserve back to the seller's earned account) commit together: the credits return
 * only if the saga also stops. This is why it does not use the generic `reverse`, which leaves
 * saga state alone, so a reversed-but-still-RESERVED saga would be paid out anyway.
 *
 * RESERVED, or SUBMITTED aged past `config.maxPayoutAgeMs`, moves to FAILED and posts the undo.
 * SETTLED and still-live SUBMITTED both throw `INVALID_TRANSITION`: returning a reserve already
 * disbursed, or one the provider may still settle, risks a double-pay. One exception: an operation
 * carrying `providerReported` (set only by the payout-failed webhook mapper) may reverse a
 * still-live SUBMITTED payout, because the rail itself has said it will not settle it.
 *
 * @example
 *   const outcome = await reversePayout(
 *     { kind: 'reversePayout', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       userId: 'usr_seller', sagaId: 'pay_1', reason: 'fraud hold' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; the reserve returned to usr_seller's earned, saga FAILED.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/reverse-payout/
 *   Reverse payout} for manually unwinding an in-flight payout saga.
 */
export async function reversePayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'reversePayout');
  assertReason(operation.reason);

  const saga = await loadSaga(unit, operation.sagaId);
  assertUserMatchesSaga(operation.userId, saga);
  refuseSettled(saga);
  refuseLiveSubmitted(operation, saga, ctx);

  // Only RESERVED or SUBMITTED has credits in PAYOUT_RESERVE to return. FAILED was already undone
  // by the worker or an earlier call. Any other state, such as REQUESTED before credits hit the
  // reserve, has nothing to give back. We treat both as already handled.
  if (saga.state !== 'RESERVED' && saga.state !== 'SUBMITTED') {
    return { status: 'duplicate', transaction: noopTransaction() };
  }

  // Move the saga to FAILED only if still in its current state (the worker's give-up change).
  // A false return means another worker advanced it between our read and now, leaving nothing to
  // undo.
  const advanced = await unit.sagas.advance(saga.id, saga.state, 'FAILED', {
    updatedAt: ctx.clock.now(),
  });
  if (!advanced) {
    return { status: 'duplicate', transaction: noopTransaction() };
  }

  // This is the same undo the worker posts. It moves the reserved amount out of PAYOUT_RESERVE
  // back into the seller's earned account. The debit and credit balance in CREDIT. It commits in
  // the same transaction as the state change above, so the two cannot come apart. The reserve
  // debit routes by the user id, the same key the request credited by, so it lands on (and the
  // lock set covered) the shard holding this payout's reserve.
  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: routePlatformLegs(
      [
        debit(SYSTEM.PAYOUT_RESERVE, saga.reserve),
        credit(earned(saga.userId), saga.reserve),
      ],
      operation.userId,
      ctx.config.platformShards,
    ),
    meta: {
      kind: 'reversePayout',
      sagaId: saga.id,
      reason: operation.reason,
      // Recorded when the rail itself reported the failure, so the audit trail shows which undo
      // path posted this: a provider callback rather than an operator's judgment.
      ...(operation.providerReported === true
        ? { providerReported: true }
        : {}),
    },
  });

  return { status: 'committed', transaction };
}

// Loads the saga by id. The operator supplied the id, so a missing saga is a caller error. It
// throws a fault rather than treating the miss as a quiet "nothing to do", matching
// settlePayout's loadSaga and reverse's unknown-txnId handling.
async function loadSaga(unit: Unit, sagaId: string): Promise<Saga> {
  const saga = await unit.sagas.load(sagaId);
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
      'Cannot reverse a settled payout.',
      { detail: { sagaId: saga.id, state: saga.state } },
    );
  }
}

// A SUBMITTED payout is still live until it ages past `maxPayoutAgeMs`, measured from `updatedAt`
// (set on entering SUBMITTED in submitToProvider). This mirrors the worker's force-fail cutoff with
// the same `now - updatedAt` comparison, so a manual reverse is rejected until then. RESERVED is not
// gated here because it was never handed to the provider. A provider-reported failure (the
// payout-failed webhook) waives the gate: the rail has said it will not settle this payout, so
// there is no settlement left to race, and the saga-state compare-and-set still guards against a
// late settle callback arriving anyway.
// See https://economy-lab-docs.pages.dev/economy/reference/operations/reverse-payout/ for why
// reversing a still-settling payout risks a double-pay and how the timeout cutoff opens the window.
function refuseLiveSubmitted(
  operation: Extract<Operation, { kind: 'reversePayout' }>,
  saga: Saga,
  ctx: Ctx,
): void {
  if (operation.providerReported === true) {
    return;
  }
  if (
    saga.state === 'SUBMITTED' &&
    ctx.clock.now() - saga.updatedAt <= ctx.config.maxPayoutAgeMs
  ) {
    throw fault(
      ERROR_CODES.INVALID_TRANSITION,
      'Cannot reverse a payout still within its provider settlement window.',
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

// Requires a non-blank reason, because a correction must record why for auditability. A missing
// or blank reason is malformed and is rejected before anything posts.
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reversePayout requires a non-empty reason.',
      { detail: { kind: 'reversePayout' } },
    );
  }
}

// Receipt for the already-handled path: nothing posted this run and the original receipt is not
// at hand, so return an empty marker rather than mint a fresh id for money that did not move.
function noopTransaction(): Transaction {
  return { id: '', postedAt: 0, legs: [], links: [] };
}
