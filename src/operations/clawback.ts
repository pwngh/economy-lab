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

import { fault, ERROR_CODES } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { encodeAmount, requirePositiveCredit, toAmount } from '#src/money.ts';
import { assertKind, reversalKey } from '#src/operations/guards.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Unit } from '#src/ports.ts';

/**
 * Reclaim credits after a bank chargeback. The USD movement happens outside this ledger; this books
 * only the credit side of the loss.
 *
 * Pulls `amount` from spendable, capped at what the user holds, with the rest a debt in RECEIVABLE.
 * The full amount credits STORED_VALUE so the loss un-issues the credits rather than booking REVENUE
 * the platform never earned; the two debits sum to that credit, so the all-CREDIT posting nets zero.
 *
 * A present `orderId` shares the `reversed:${orderId}` key to stay mutually exclusive with a refund
 * of the same order; a lost claim returns that reversal's transaction as `duplicate`. Returns
 * `committed` or `duplicate`. A bad amount throws a fault.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/clawback/ Clawback}
 *   for the chargeback reversal and split accounting.
 */
export async function clawback(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'clawback');
  const amount = requirePositiveCredit(operation.amount, 'clawback.amount');

  if (operation.orderId !== undefined) {
    const orderId = presentOrderId(operation.orderId);
    const claim = await unit.idempotency.claim(reversalKey(orderId));
    if (!claim.claimed) {
      return { status: 'duplicate', transaction: claim.transaction };
    }
  }

  const held = await unit.ledger.balance(spendable(operation.userId));
  const split = splitClawback(amount, held);
  const legs = buildClawbackLegs(operation.userId, amount, split);

  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: clawbackMeta(operation, split),
  });

  // Runs inside the posting's transaction, so a rollback leaves the order un-reversed and
  // retryable.
  if (operation.orderId !== undefined) {
    await unit.idempotency.record(reversalKey(operation.orderId), transaction);
  }

  return { status: 'committed', transaction };
}

// A blank id would collapse to the same `reversed:` key and falsely tie unrelated chargebacks to
// one marker, so a present-but-blank orderId is a fault.
function presentOrderId(orderId: string): string {
  if (orderId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'clawback.orderId must be a non-empty order id when present.',
    );
  }
  return orderId;
}

// `recovered` is capped at what the user holds, treating a negative balance as zero, so the debit
// cannot drive the balance below zero. `shortfall` is the leftover the platform is owed.
function splitClawback(
  amount: Amount,
  held: Amount,
): { recovered: Amount; shortfall: Amount } {
  const available = held.minor > 0n ? held.minor : 0n;
  const recoveredMinor = available < amount.minor ? available : amount.minor;
  return {
    recovered: toAmount(amount.currency, recoveredMinor),
    shortfall: toAmount(amount.currency, amount.minor - recoveredMinor),
  };
}

// A zero piece is omitted rather than posted as a zero line.
function buildClawbackLegs(
  userId: string,
  amount: Amount,
  split: { recovered: Amount; shortfall: Amount },
): Leg[] {
  const legs: Leg[] = [];
  if (split.recovered.minor > 0n) {
    legs.push(debit(spendable(userId), split.recovered));
  }
  if (split.shortfall.minor > 0n) {
    legs.push(debit(SYSTEM.RECEIVABLE, split.shortfall));
  }
  legs.push(credit(SYSTEM.STORED_VALUE, amount));
  return legs;
}

// Split amounts go through `encodeAmount` so the hashed bytes stay stable.
function clawbackMeta(
  operation: Extract<Operation, { kind: 'clawback' }>,
  split: { recovered: Amount; shortfall: Amount },
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    kind: 'clawback',
    recovered: encodeAmount(split.recovered),
    shortfall: encodeAmount(split.shortfall),
  };
  if (operation.orderId !== undefined) {
    meta.orderId = operation.orderId;
  }
  if (operation.key !== undefined) {
    meta.key = operation.key;
  }
  if (operation.reason !== undefined) {
    meta.reason = operation.reason;
  }
  return meta;
}
