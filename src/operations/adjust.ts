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
 * Operator-only manual correction, for cases no ordinary operation covers (e.g. closing
 * a gap found during reconciliation).
 *
 * Moves `operation.account` by the signed `operation.amount` (negative corrects downward)
 * and books the opposite entry to the platform opening-equity account so the two cancel
 * and the books stay balanced. Returns a `committed` Outcome with the posted transaction.
 *
 * Bad input throws a fault rather than returning a `rejected` Outcome: actor must be an
 * operator, amount a non-zero CREDIT amount, reason non-empty.
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
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/adjust/ Adjust} for when and how operators book manual corrections.
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

// Two legs: one moves `account` by the signed amount, the other posts the opposite to
// opening-equity so they cancel. Avoid the `credit`/`debit` helpers since the move must
// read correctly whether `account` grows on a debit or a credit.
function buildAdjustLegs(account: AccountRef, amount: Amount): Leg[] {
  // Leg amounts are stored debit-positive (debit positive, credit negative). For a
  // debit-normal account the stored amount is the balance change; for a credit-normal
  // account it's the opposite sign. So to raise `account` by `amount.minor`, store
  // +amount.minor when debit-normal and -amount.minor when credit-normal.
  let accountMinor = isDebitNormal(account) ? amount.minor : -amount.minor;
  return [
    { account, amount: toAmount(amount.currency, accountMinor) },
    {
      // Negated amount, so the two legs sum to zero.
      account: SYSTEM.OPENING_EQUITY,
      amount: toAmount(amount.currency, -accountMinor),
    },
  ];
}

// Data stored with the posting: encoded signed amount and operator reason. Encode via
// `encodeAmount` rather than raw bigint so the bytes hashed into the tamper-evident chain
// are stable across replays, and the audit trail records what changed and why.
function adjustMeta(
  operation: Extract<Operation, { kind: 'adjust' }>,
): Record<string, unknown> {
  return {
    kind: 'adjust',
    amount: encodeAmount(operation.amount),
    reason: operation.reason,
  };
}

// Only an operator may adjust. The wrapping middleware already checks the actor;
// re-checking here means calling the handler directly (e.g. from a test) with the wrong
// actor fails loudly instead of quietly writing a privileged correction.
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

// A correction must record why, for auditability. Missing or blank reason is malformed
// and rejected before anything posts.
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'adjust requires a non-empty reason.',
      { detail: { kind: 'adjust' } },
    );
  }
}

// Validate the amount and return it unchanged. Must be CREDIT (the opening-equity account
// it balances against is CREDIT) and non-zero (an adjustment that moves nothing is
// malformed). Signed: a negative value is a valid downward correction, so positivity
// isn't required, only that money moves.
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

// Operations route to handlers by `kind`, so a different kind here means the wiring is
// wrong. Fail loudly rather than mishandle it.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
