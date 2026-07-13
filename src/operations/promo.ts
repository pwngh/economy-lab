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
import { assertKind } from '#src/operations/guards.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { requirePositiveCredit } from '#src/money.ts';
import { SYSTEM, promo } from '#src/accounts.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Unit } from '#src/ports.ts';

/**
 * Issue marketing promo credits to a user.
 *
 * Promo credits need no USD backing (unlike topped-up money), so a grant can't increase the cash
 * held in trust. They are spendable but never cashed out, because only earned credits pay out.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/grant-promo/ Grant
 *   promo} for issuing unbacked, expiring marketing credits.
 */
export async function grantPromo(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'grantPromo');
  const amount = requirePositiveCredit(operation.amount, 'grantPromo.amount');
  const expiresAt = futureExpiresAt(
    operation.expiresAt,
    ctx,
    'grantPromo.expiresAt',
  );

  // PROMO_FLOAT is debit-normal, so debiting it offsets the user's credit. See
  // https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/ for the rule.
  // expiresAt rides in the entry metadata so the expiry sweep can find and reverse the unspent
  // portion.
  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.PROMO_FLOAT, amount),
      credit(promo(operation.userId), amount),
    ],
    meta: { kind: 'grantPromo', expiresAt },
  });

  // Same unit of work, so the record commits or rolls back with the credit. It reuses the
  // posting's id, and `open` is idempotent on that id, so a retried grant never duplicates the row.
  await unit.promos.open({
    id: transaction.id,
    userId: operation.userId,
    amount,
    expiresAt,
    reversed: false,
  });

  return { status: 'committed', transaction };
}

// Every grant must expire so the sweep can reclaim unspent credit; the ceiling stops a caller
// from minting an effectively never-expiring grant.
const MAX_EXPIRY_AHEAD_MS = 5 * 365 * 24 * 60 * 60_000;

// Wire values can be NaN, Infinity, or fractional, and a past expiry would be claimed by the
// reclaim sweep at once. Both are caller mistakes, so it throws a fault rather than returning
// `rejected`.
function futureExpiresAt(expiresAt: number, ctx: Ctx, label: string): number {
  const now = ctx.clock.now();
  if (!Number.isInteger(expiresAt) || expiresAt <= now) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${label} must be a whole-millisecond timestamp in the future.`,
      { detail: { label, expiresAt, now } },
    );
  }
  if (expiresAt > now + MAX_EXPIRY_AHEAD_MS) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${label} is too far in the future.`,
      { detail: { label, expiresAt, now, maxAheadMs: MAX_EXPIRY_AHEAD_MS } },
    );
  }
  return expiresAt;
}
