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

import type { Ctx, Operation, Transaction } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Narrows `operation` to the expected `kind`. A mismatch means the dispatch is miswired, so it
 * throws a fault rather than process an operation it cannot handle.
 */
export function assertKind<K extends Operation['kind']>(
  operation: Operation,
  kind: K,
): asserts operation is Extract<Operation, { kind: K }> {
  if (operation.kind !== kind) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `Handler received the wrong operation kind: ${operation.kind}.`,
      { detail: { kind: operation.kind, expected: kind } },
    );
  }
}

/**
 * Requires an operator principal. The submit pipeline already authorizes the actor (authorize in
 * economy.ts), so re-checking here matters only when a handler is called directly, such as from a
 * test. It throws rather than write a privileged change under the wrong actor.
 */
export function assertOperator(operation: Operation): void {
  if (operation.actor.kind !== 'operator') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${operation.kind} requires an operator principal.`,
      { detail: { kind: operation.kind, actor: operation.actor.kind } },
    );
  }
}

/**
 * Requires a non-blank reason on a manual correction, because a correction must record why for
 * auditability. A missing or blank reason is malformed and throws before anything posts.
 */
export function assertReason(
  operation: Extract<Operation, { reason: string }>,
): void {
  if (operation.reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${operation.kind} requires a non-empty reason.`,
      { detail: { kind: operation.kind } },
    );
  }
}

/**
 * Loads the saga a payout operation names by `sagaId`. An operator or webhook mapping supplied the
 * id, so a missing saga is a caller error: it throws a fault rather than treating the miss as a
 * quiet "nothing to do", matching reverse's unknown-txnId handling.
 */
export async function loadSaga(
  unit: Unit,
  operation: Extract<Operation, { sagaId: string }>,
): Promise<Saga> {
  const saga = await unit.sagas.load(operation.sagaId);
  if (saga === null) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${operation.kind} names a payout that does not exist.`,
      { detail: { kind: operation.kind, sagaId: operation.sagaId } },
    );
  }
  return saga;
}

/**
 * Builds the `reversed:<id>` idempotency key that marks an order or transaction as undone. Refund
 * and clawback stake it per orderId, which keeps the two reversal paths mutually exclusive, and
 * reverse stakes it per txnId; one builder keeps the key family identical across all three.
 */
export function reversalKey(id: string): string {
  return `reversed:${id}`;
}

/**
 * Receipt for an operation that changes state but moves no money: a committed result must carry a
 * Transaction, so this returns one with empty legs and links.
 */
export function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
    meta: {},
  };
}

/**
 * Receipt for the already-handled path: nothing posted this run and the original receipt is not
 * at hand, so return an empty marker rather than mint a fresh id for money that did not move.
 */
export function noopTransaction(): Transaction {
  return { id: '', postedAt: 0, legs: [], links: [], meta: {} };
}
