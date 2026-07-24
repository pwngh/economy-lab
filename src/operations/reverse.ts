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
import { lockAll, postEntry } from '#src/ledger.ts';
import { verifiedPosting } from '#src/chain.ts';
import { negate } from '#src/money.ts';
import {
  assertKind,
  assertOperator,
  assertReason,
  reversalKey,
} from '#src/operations/guards.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Posting, Unit } from '#src/ports.ts';

/**
 * Undoes an earlier transaction by posting its exact opposite: an operator-only manual correction
 * that posts the original's legs with every amount's sign flipped, locking each account it touched
 * first. A transaction is reversed at most once via the shared `reversed:${txnId}` key (the pattern
 * refund and clawback use); a second reverse returns the first reversal as a `duplicate`. Reversing
 * a reversal is refused with `OP.MALFORMED`, as it would just loop the money back out and in.
 *
 * @example
 *   const outcome = await reverse(
 *     { kind: 'reverse', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       txnId: 'txn_1', reason: 'reconciliation: duplicate posting' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; every leg of txn_1 posted with its sign flipped.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/reverse/ Reverse} for
 *   the operator-only undo-by-inverse correction flow.
 */
export async function reverse(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'reverse');
  assertOperator(operation);
  assertReason(operation);

  const original = await loadPosting(unit, ctx, operation.txnId);
  assertNotReversal(operation, original);
  await extendLocks(unit, original.legs);

  // The claim lives inside this posting's db transaction, so a rollback releases it and a retry
  // succeeds.
  const claimKey = reversalKey(operation.txnId);
  const claim = await unit.idempotency.claim(claimKey);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: reverseLegs(original.legs),
    meta: reverseMeta(operation),
  });

  await unit.idempotency.record(claimKey, transaction);

  return { status: 'committed', transaction };
}

// Loads the transaction to undo, re-proved against its own chain links (verifiedPosting) —
// the flipped legs derive money directly, so an in-place edit must fault before it shapes them.
// The operator typed this id, so an unknown one is operator error and throws a fault. Compare
// `refund`, where an unknown order id is an everyday caller decline.
async function loadPosting(
  unit: Unit,
  ctx: Ctx,
  txnId: string,
): Promise<Posting> {
  const posting = await verifiedPosting(
    { ledger: unit.ledger, digest: ctx.digest },
    txnId,
  );
  if (posting === null) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse names a posting that does not exist.',
      { detail: { kind: 'reverse', txnId } },
    );
  }
  return posting;
}

// A reversal must never be reversed: chaining reversals would let an operator adjust a balance
// by an arbitrary amount. A reversal is any posting whose metadata records `kind: 'reverse'`.
function assertNotReversal(
  operation: Extract<Operation, { kind: 'reverse' }>,
  original: Posting,
): void {
  if (original.meta.kind === 'reverse') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse cannot undo a reversal.',
      { detail: { kind: 'reverse', txnId: operation.txnId } },
    );
  }
}

// The framework only locks accounts named in the request, and a reverse request carries just a
// txnId, so the handler locks the accounts discovered from the loaded transaction. `lockAll`
// applies the deadlock-free global lock order, not leg order.
async function extendLocks(
  unit: Unit,
  legs: ReadonlyArray<Leg>,
): Promise<void> {
  await lockAll(
    unit.ledger,
    legs.map((leg) => leg.account),
  );
}

// Same account, sign flipped. The original's legs sum to zero per currency, so the flipped set
// does too.
function reverseLegs(legs: ReadonlyArray<Leg>): Leg[] {
  return legs.map((leg) => ({
    account: leg.account,
    amount: negate(leg.amount),
  }));
}

function reverseMeta(
  operation: Extract<Operation, { kind: 'reverse' }>,
): Record<string, unknown> {
  return {
    kind: 'reverse',
    txnId: operation.txnId,
    reason: operation.reason,
  };
}
