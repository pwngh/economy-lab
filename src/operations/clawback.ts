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
 * Reclaim credits after a bank chargeback. When a buyer disputes a top-up and the bank
 * reverses the charge, the dollars are clawed back from the platform at the payment
 * processor; that USD movement happens outside this ledger. This handler books only the
 * credit side of that loss.
 *
 * It tries to pull `operation.amount` of credits back out of the user's spendable balance.
 * If the user has already spent some, only what is still there can be reclaimed
 * (the smaller of the requested amount and the current balance); the rest becomes a debt
 * the platform is now owed, recorded in the RECEIVABLE account. The full amount is credited
 * to STORED_VALUE, the account that tracks how many credits are in circulation: the original
 * top-up raised that count when it issued these credits, so reversing the top-up lowers it
 * again. That way the loss un-issues the credits instead of being booked into REVENUE as
 * earnings the platform never made; REVENUE is never touched. Every line in the posting is in
 * CREDIT (no mixing of currencies), and the two debits add up to exactly the STORED_VALUE
 * credit, so the posting nets to zero.
 *
 * When the operation carries an `orderId`, this is an order-tied chargeback that must be
 * mutually exclusive with a refund of the same order. Before posting, it claims the shared
 * `reversed:${orderId}` key; if a refund (or an earlier clawback) already reversed that
 * order, the claim is lost and it returns the recorded reversing transaction as a
 * `duplicate` rather than reversing the order a second time. The same key is recorded after
 * a successful post, so a later refund of that order is in turn blocked.
 *
 * Returns a `committed` Outcome with the posted transaction, or a `duplicate` Outcome on a
 * lost order claim. An amount that is not in CREDIT or is not positive is a programming
 * error, thrown as a fault, never returned as a normal "no" answer.
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

  // An order-tied clawback shares the `reversed:${orderId}` key with refund, so at most one
  // of the two can ever reverse a given order. Claiming it inside this transaction makes the
  // two paths mutually exclusive: a lost claim means the order was already reversed, so return
  // that reversal's transaction as a duplicate instead of double-reversing.
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

  // Record the reversal under the shared order key so a later refund of the same order finds
  // it claimed and returns this transaction as its duplicate. Done inside the posting's
  // transaction, so a rollback leaves the order un-reversed and freely retryable.
  if (operation.orderId !== undefined) {
    await unit.idempotency.record(reversalKey(operation.orderId), transaction);
  }

  return { status: 'committed', transaction };
}

// The order-scoped idempotency key a clawback and a refund of the same order both stake, so
// reversing an order once (by either path) blocks the other. Kept identical to refund's key so
// the two are genuinely mutually exclusive.
function reversalKey(orderId: string): string {
  return `reversed:${orderId}`;
}

// `orderId` is optional — an untied chargeback simply omits it — but a present-but-blank value
// is a malformed request, not an untied one. Every blank id collapses to the same `reversed:`
// key, so it would falsely tie unrelated chargebacks to one shared marker. Rejected as a fault
// so the bad key never reaches `claim`. Returned unchanged so it can be used inline.
function presentOrderId(orderId: string): string {
  if (orderId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'clawback.orderId must be a non-empty order id when present.',
    );
  }
  return orderId;
}

// Split the amount being clawed back into the part we can still take from the user's
// spendable balance and the part they already spent. `recovered` is capped at what the user
// actually has (treating a negative balance as zero), so the later debit can never drive the
// balance below zero; `shortfall` is whatever is left over, which the platform is now owed.
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

// Build the debit and credit lines for the posting. Take `recovered` out of the user's
// spendable balance, record `shortfall` as a debt in RECEIVABLE, and credit the full amount
// to STORED_VALUE — the account that counts credits in circulation, which the matching top-up
// raised when it issued these credits — so the reclaimed credits are un-issued rather than
// booked as house earnings. The two debits add up to the amount and STORED_VALUE is credited
// that same amount, so the lines net to zero, and every line is in CREDIT (no currency mixing).
// A piece that is zero (nothing left to reclaim, or no shortfall) is left out rather than
// posted as a zero line.
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

// Build the metadata stored with the posting: the two split amounts plus any chargeback
// references the caller passed (order id, idempotency key, reason). Amounts are turned into
// their text form with `encodeAmount` rather than stored as raw bigints, so this record can
// be re-read and re-hashed later and come out byte-for-byte the same every time.
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

// Check the amount is in CREDIT and positive, returning it unchanged so it can be used
// inline. A wrong currency or a zero/negative amount is a malformed request, not a normal
// "no" answer, so each throws a fault rather than returning a rejection.
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

// Reaching this handler with any kind other than `clawback` can only mean the dispatcher
// that routes operations to handlers sent it to the wrong place. Fail loudly with a fault
// rather than quietly posting the wrong thing.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
