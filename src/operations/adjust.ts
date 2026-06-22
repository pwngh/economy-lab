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
import { postEntry } from '#src/ledger.ts';
import { encodeAmount, isZero, toAmount } from '#src/money.ts';
import { SYSTEM, isDebitNormal } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Unit } from '#src/ports.ts';

/**
 * Post a manual correction that an operator runs by hand to set an account's balance
 * right when no ordinary operation can — for example, to close a gap found during
 * reconciliation. Ordinary users cannot run it.
 *
 * It moves `operation.account` up or down by the signed `operation.amount` (a negative
 * amount corrects the balance downward), and books the matching opposite entry to the
 * platform's opening-equity account so the two entries cancel and the books stay
 * balanced. Returns a `committed` Outcome carrying the posted transaction.
 *
 * Bad input is reported by throwing a fault, not by returning a `rejected` Outcome:
 * the actor must be an operator, the amount must be a non-zero CREDIT amount, and the
 * reason must be non-empty.
 *
 * @example
 *   let outcome = await adjust(
 *     { kind: 'adjust', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       account: spendable('usr_alice'), amount: toAmount('CREDIT', 250n),
 *       reason: 'reconciliation: missing genesis lot' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; spendable(usr_alice) rose by 250, balanced to OPENING_EQUITY.
 */
export async function adjust(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'adjust') {
    throw kindMismatch(operation);
  }
  assertOperator(operation);
  assertReason(operation.reason);
  let amount = creditDelta(operation.amount, 'adjust.amount');

  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: buildAdjustLegs(operation.account, amount),
    meta: adjustMeta(operation),
  });

  return { status: 'committed', transaction };
}

// Build the two entries (legs) that make up the adjustment: one moves `account`'s
// balance by the signed amount, and the other posts the exact opposite to the
// opening-equity account, so the two amounts cancel and the posting balances. We do
// not use the `credit`/`debit` helpers here, because the move must read correctly
// whether `account` grows on a debit or on a credit.
function buildAdjustLegs(account: AccountRef, amount: Amount): Leg[] {
  // Every leg amount is stored debit-positive (a debit is positive, a credit is
  // negative). For an account that grows on a debit, that stored amount IS the change
  // to its balance; for an account that grows on a credit, the change is the opposite
  // sign. So to raise `account`'s balance by `amount.minor`, store +amount.minor when
  // it grows on a debit and -amount.minor when it grows on a credit.
  let accountMinor = isDebitNormal(account) ? amount.minor : -amount.minor;
  return [
    { account, amount: toAmount(amount.currency, accountMinor) },
    {
      // The opposite entry carries the negated amount, so the two legs add up to zero.
      account: SYSTEM.OPENING_EQUITY,
      amount: toAmount(amount.currency, -accountMinor),
    },
  ];
}

// The data stored alongside the posting: the (encoded) signed amount and the operator's
// reason. The amount is written through `encodeAmount` rather than as a raw bigint, so
// the bytes hashed into the tamper-evident chain come out the same on every replay and
// the audit trail shows exactly what the operator changed and why.
function adjustMeta(
  operation: Extract<Operation, { kind: 'adjust' }>,
): Record<string, unknown> {
  return {
    kind: 'adjust',
    amount: encodeAmount(operation.amount),
    reason: operation.reason,
  };
}

// Only an operator may run an adjustment. The middleware that wraps this handler
// already checks the actor, but re-checking here means that calling the handler
// directly (for instance from a test) with the wrong actor fails loudly instead of
// quietly writing a privileged correction.
function assertOperator(
  operation: Extract<Operation, { kind: 'adjust' }>,
): void {
  if (operation.actor.kind !== 'operator') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'adjust requires an operator principal.',
      { detail: { kind: operation.kind, actor: operation.actor.kind } },
    );
  }
}

// A manual correction must record why it was made, so it is auditable. A missing or
// blank reason is treated as malformed and rejected before anything is posted.
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'adjust requires a non-empty reason.',
      { detail: { kind: 'adjust' } },
    );
  }
}

// Check the adjustment amount and return it unchanged. It must be in CREDIT (the
// opening-equity account it balances against is a CREDIT account), and it must be
// non-zero (an adjustment that moves nothing is malformed). The amount is signed: a
// negative value is a valid downward correction, so we do NOT require it to be
// positive, only that money actually moves.
function creditDelta(amount: Amount, label: string): Amount {
  if (amount.currency !== 'CREDIT') {
    throw fault(ERROR_CODES.MALFORMED_OPERATION, `${label} must be CREDIT.`, {
      detail: { label, amount: encodeAmount(amount) },
    });
  }
  if (isZero(amount)) {
    throw fault(ERROR_CODES.INVALID_AMOUNT, `${label} must be non-zero.`, {
      detail: { label, amount: encodeAmount(amount) },
    });
  }
  return amount;
}

// Each operation is routed to its handler by `kind`, so reaching this handler with a
// different kind means the wiring is wrong. Fail loudly rather than mishandle it.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
