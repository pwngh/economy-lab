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

/**
 * Asserts that `operation` has the expected `kind`, narrowing its type for the rest of the handler.
 * Operations route to handlers by `kind`, so a mismatch means the dispatch is miswired. The handler
 * throws a fault rather than process an operation it cannot handle.
 */
export function assertKind<K extends Operation['kind']>(
  operation: Operation,
  kind: K,
): asserts operation is Extract<Operation, { kind: K }> {
  if (operation.kind !== kind) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `handler received the wrong operation kind: ${operation.kind}.`,
      { detail: { kind: operation.kind, expected: kind } },
    );
  }
}

/**
 * Requires an operator principal. The submit middleware already authorizes the actor, so re-checking
 * here matters only when a handler is called directly, such as from a test. It throws rather
 * than write a privileged change under the wrong actor.
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
 * Builds the transaction for an operation that changes state but moves no money. A committed result
 * must carry a Transaction, so this returns a receipt with a fresh id and a commit time but empty leg
 * and link lists, because nothing was posted to the ledger.
 */
export function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}
