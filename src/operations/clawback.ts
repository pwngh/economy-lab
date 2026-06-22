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
import { encodeAmount, toAmount } from '#src/money.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Unit } from '#src/ports.ts';

/**
 * Reclaim credits after a bank chargeback. The USD movement (dollars clawed back at the payment
 * processor) happens outside this ledger; this handler books only the credit side of the loss.
 *
 * Pulls `operation.amount` of credits from the user's spendable balance, capped at what's still
 * there (smaller of requested and current balance). The rest becomes a debt to the platform in
 * RECEIVABLE. The full amount is credited to STORED_VALUE (credits in circulation), which the
 * original top-up raised when it issued these credits, so the loss un-issues them rather than
 * booking REVENUE the platform never earned. REVENUE is untouched. Every line is in CREDIT (no
 * currency mixing) and the two debits sum to the STORED_VALUE credit, so the posting nets to zero.
 *
 * With an `orderId`, the chargeback is mutually exclusive with a refund of the same order via the
 * shared `reversed:${orderId}` key. Claim it before posting; a lost claim means a refund (or earlier
 * clawback) already reversed the order, so return that transaction as a `duplicate`. The key is
 * recorded after a successful post, blocking a later refund of the order.
 *
 * Returns a `committed` Outcome, or `duplicate` on a lost claim. A non-CREDIT or non-positive
 * amount is a programming error, thrown as a fault.
 */
export async function handleClawback(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'clawback') {
    throw kindMismatch(operation);
  }
  let amount = positiveCredit(operation.amount, 'clawback.amount');

  // Claim the shared `reversed:${orderId}` key so clawback and refund are mutually exclusive. A
  // lost claim means the order was already reversed; return that reversal's transaction as a
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
  // this transaction as its duplicate. Inside the posting's transaction, so a rollback leaves the
  // order un-reversed and retryable.
  if (operation.orderId !== undefined) {
    await unit.idempotency.record(reversalKey(operation.orderId), transaction);
  }

  return { status: 'committed', transaction };
}

// Order-scoped idempotency key staked by both clawback and refund, so reversing an order once
// blocks the other. Must stay identical to refund's key.
function reversalKey(orderId: string): string {
  return `reversed:${orderId}`;
}

// `orderId` is optional (an untied chargeback omits it), but a present-but-blank value is
// malformed: every blank id collapses to the same `reversed:` key, falsely tying unrelated
// chargebacks to one marker. Reject as a fault so the bad key never reaches `claim`. Returned
// unchanged for inline use.
function presentOrderId(orderId: string): string {
  if (orderId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'clawback.orderId must be a non-empty order id when present.',
    );
  }
  return orderId;
}

// Split the clawback into the part still recoverable from spendable balance and the part already
// spent. `recovered` is capped at what the user has (negative balance treated as zero), so the
// later debit can't drive the balance below zero; `shortfall` is the leftover the platform is owed.
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

// Build the debit and credit lines. Debit `recovered` from spendable balance, record `shortfall`
// as a debt in RECEIVABLE, and credit the full amount to STORED_VALUE (credits in circulation,
// raised by the matching top-up) so the reclaimed credits are un-issued rather than booked as
// earnings. The two debits sum to the amount and STORED_VALUE is credited that amount, so the
// lines net to zero, all in CREDIT (no currency mixing). A zero piece (nothing to reclaim, or no
// shortfall) is omitted rather than posted as a zero line.
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

// Metadata stored with the posting: the two split amounts plus any chargeback references the caller
// passed (order id, idempotency key, reason). Amounts use `encodeAmount` text form rather than raw
// bigints, so the record re-reads and re-hashes byte-for-byte the same every time.
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

// Check the amount is CREDIT and positive, returning it unchanged for inline use. A wrong currency
// or zero/negative amount is malformed, so each throws a fault rather than returning a rejection.
function positiveCredit(amount: Amount, label: string): Amount {
  if (amount.currency !== 'CREDIT') {
    throw fault(ERROR_CODES.MALFORMED_OPERATION, `${label} must be CREDIT.`, {
      detail: { label, amount: encodeAmount(amount) },
    });
  }
  if (amount.minor <= 0n) {
    throw fault(ERROR_CODES.INVALID_AMOUNT, `${label} must be positive.`, {
      detail: { label, amount: encodeAmount(amount) },
    });
  }
  return amount;
}

// A kind other than `clawback` here means the dispatcher misrouted the operation. Fail loudly
// rather than quietly posting the wrong thing.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
