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
import {
  credit,
  debit,
  postEntry,
  balance as ledgerBalance,
} from '#src/ledger.ts';
import { encodeAmount, requirePositiveCredit, toAmount } from '#src/money.ts';
import { assertKind } from '#src/operations/guards.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Unit } from '#src/ports.ts';

/**
 * Reclaim credits after a bank chargeback. The USD movement (dollars clawed back at the payment
 * processor) happens outside this ledger; this handler books only the credit side of the loss.
 *
 * Pulls `operation.amount` of credits from the user's spendable balance, capped at the current
 * balance (the smaller of requested and held). The rest becomes a debt to the platform in
 * RECEIVABLE. The full amount is credited to STORED_VALUE (credits in circulation), which the
 * original top-up raised when it issued these credits. The loss therefore un-issues them rather
 * than booking REVENUE the platform never earned, and REVENUE stays untouched. Every line is in
 * CREDIT, so no currency is mixed. The two debits sum to the STORED_VALUE credit, so the posting
 * nets to zero.
 *
 * When an `orderId` is present, the chargeback is mutually exclusive with a refund of the same
 * order through the shared `reversed:${orderId}` key. The handler claims the key before posting. A
 * lost claim means a refund or an earlier clawback already reversed the order, so it returns that
 * transaction as a `duplicate`. After a successful post it records the key, which blocks a later
 * refund of the order.
 *
 * Returns a `committed` Outcome, or `duplicate` on a lost claim. A non-CREDIT or non-positive
 * amount is a programming error, thrown as a fault.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/clawback/ Clawback} for the chargeback reversal and split accounting.
 */
export async function handleClawback(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'clawback');
  let amount = requirePositiveCredit(operation.amount, 'clawback.amount');

  // Claim the shared `reversed:${orderId}` key so clawback and refund stay mutually exclusive. A
  // lost claim means the order was already reversed. Return that reversal's transaction as a
  // duplicate instead of double-reversing.
  if (operation.orderId !== undefined) {
    let orderId = presentOrderId(operation.orderId);
    let claim = await unit.idempotency.claim(reversalKey(orderId));
    if (!claim.claimed) {
      return { status: 'duplicate', transaction: claim.transaction };
    }
  }

  let held = await ledgerBalance(unit.ledger, spendable(operation.userId));
  let split = splitClawback(amount, held);
  let legs = buildClawbackLegs(operation.userId, amount, split);

  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: clawbackMeta(operation, split),
  });

  // Record the reversal under the shared order key so a later refund finds it claimed and returns
  // this transaction as its duplicate. This runs inside the posting's transaction, so a rollback
  // leaves the order un-reversed and retryable.
  if (operation.orderId !== undefined) {
    await unit.idempotency.record(reversalKey(operation.orderId), transaction);
  }

  return { status: 'committed', transaction };
}

// Builds the order-scoped idempotency key that both clawback and refund stake, so reversing an
// order once blocks the other. Must stay identical to refund's key.
function reversalKey(orderId: string): string {
  return `reversed:${orderId}`;
}

// Requires a non-blank `orderId` and returns it unchanged. The id is optional, since an untied
// chargeback omits it, but a present-but-blank value is malformed. Every blank id collapses to the
// same `reversed:` key, which would falsely tie unrelated chargebacks to one marker. Throws a fault
// so the bad key never reaches `claim`.
function presentOrderId(orderId: string): string {
  if (orderId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'clawback.orderId must be a non-empty order id when present.',
    );
  }
  return orderId;
}

// Splits the clawback into the part still recoverable from the spendable balance and the part
// already spent. `recovered` is capped at what the user holds, treating a negative balance as zero,
// so the later debit cannot drive the balance below zero. `shortfall` is the leftover the platform
// is owed.
function splitClawback(
  amount: Amount,
  held: Amount,
): { recovered: Amount; shortfall: Amount } {
  let available = held.minor > 0n ? held.minor : 0n;
  let recoveredMinor = available < amount.minor ? available : amount.minor;
  return {
    recovered: toAmount(amount.currency, recoveredMinor),
    shortfall: toAmount(amount.currency, amount.minor - recoveredMinor),
  };
}

// Builds the ledger lines. Debits `recovered` from spendable, debits `shortfall` as a debt in
// RECEIVABLE, and credits the full amount to STORED_VALUE so the reclaimed credits are un-issued
// rather than booked as earnings. The two debits sum to the STORED_VALUE credit, so the posting
// nets to zero, all in CREDIT with no currency mixing. A zero piece, meaning nothing to reclaim or
// no shortfall, is omitted rather than posted as a zero line.
function buildClawbackLegs(
  userId: string,
  amount: Amount,
  split: { recovered: Amount; shortfall: Amount },
): Leg[] {
  let legs: Leg[] = [];
  if (split.recovered.minor > 0n) {
    legs.push(debit(spendable(userId), split.recovered));
  }
  if (split.shortfall.minor > 0n) {
    legs.push(debit(SYSTEM.RECEIVABLE, split.shortfall));
  }
  legs.push(credit(SYSTEM.STORED_VALUE, amount));
  return legs;
}

// Builds the metadata stored with the posting. It holds the two split amounts plus any chargeback
// references the caller passed: order id, idempotency key, and reason. Amounts use the `encodeAmount`
// text form rather than raw bigints, so the record re-reads and re-hashes byte-for-byte the same
// every time.
function clawbackMeta(
  operation: Extract<Operation, { kind: 'clawback' }>,
  split: { recovered: Amount; shortfall: Amount },
): Record<string, unknown> {
  let meta: Record<string, unknown> = {
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
