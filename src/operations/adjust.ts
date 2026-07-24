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
import {
  assertKind,
  assertOperator,
  assertReason,
} from '#src/operations/guards.ts';
import { postEntry } from '#src/ledger.ts';
import { encodeAmount, isZero, toAmount } from '#src/money.ts';
import { SYSTEM, isDebitNormal } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Unit } from '#src/ports.ts';

/**
 * Operator-only manual correction, for cases no ordinary operation covers (e.g. closing a gap
 * found during reconciliation). Moves `operation.account` by the signed `operation.amount`
 * (negative corrects downward) and books the opposite entry to platform opening-equity so the two
 * cancel and the books stay balanced. Returns a `committed` Outcome.
 *
 * Bad input throws a fault, not a `rejected` Outcome: actor must be operator, amount a non-zero
 * CREDIT, reason non-empty.
 *
 * @example
 * const outcome = await adjust(
 *   { kind: 'adjust', idempotencyKey: 'idem_0',
 *     actor: { kind: 'operator', operatorId: 'op_1' },
 *     account: spendable('usr_alice'), amount: toAmount('CREDIT', 250n),
 *     reason: 'reconciliation: missing genesis lot' },
 *   unit, ctx,
 * );
 * // outcome.status === 'committed'; spendable(usr_alice) rose by 250, balanced to OPENING_EQUITY.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/adjust/ Adjust} for
 *   when and how operators book manual corrections.
 */
export async function adjust(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'adjust');
  assertOperator(operation);
  assertReason(operation);
  const amount = creditDelta(operation.amount, 'adjust.amount');

  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: buildAdjustLegs(operation.account, amount),
    meta: adjustMeta(operation),
  });

  return { status: 'committed', transaction };
}

// Bypasses the `credit`/`debit` helpers because the move must read correctly whether `account`
// grows on a debit or on a credit.
function buildAdjustLegs(account: AccountRef, amount: Amount): Leg[] {
  // Legs are stored debit-positive, so the stored sign equals the balance change only for a
  // debit-normal account; a credit-normal account needs the sign flipped.
  const accountMinor = isDebitNormal(account) ? amount.minor : -amount.minor;
  return [
    { account, amount: toAmount(amount.currency, accountMinor) },
    {
      account: SYSTEM.OPENING_EQUITY,
      amount: toAmount(amount.currency, -accountMinor),
    },
  ];
}

// The amount goes through `encodeAmount` so the hashed bytes stay stable.
function adjustMeta(
  operation: Extract<Operation, { kind: 'adjust' }>,
): Record<string, unknown> {
  return {
    kind: 'adjust',
    amount: encodeAmount(operation.amount),
    reason: operation.reason,
  };
}

// Must be CREDIT because the opening-equity account it balances against is CREDIT, and non-zero.
// The amount is signed: a negative value is a valid downward correction.
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
