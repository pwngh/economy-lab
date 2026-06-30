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
 * `expiresAt` is stored in the entry metadata so the background worker can later reverse any
 * unspent portion.
 *
 * @example
 *   let outcome = await grantPromo(
 *     { kind: 'grantPromo', idempotencyKey: 'idem_0', actor: { kind: 'system', service: 'marketing' },
 *       userId: 'usr_buyer', amount: toAmount('CREDIT', 500n), expiresAt: 86_400_000 },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; promo(usr_buyer) rose by 500, offset by PROMO_FLOAT.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/grant-promo/ Grant promo} for issuing unbacked, expiring marketing credits.
 */
export async function grantPromo(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'grantPromo');
  let amount = requirePositiveCredit(operation.amount, 'grantPromo.amount');
  let expiresAt = futureExpiresAt(
    operation.expiresAt,
    ctx,
    'grantPromo.expiresAt',
  );

  // PROMO_FLOAT is debit-normal: a debit raises its balance and a credit lowers it, so debiting it
  // here offsets the user's credit.
  // @see https://economy-lab-docs.pages.dev/economy/concepts/accounts-and-double-entry/
  // expiresAt lives in the entry metadata so the expiry job can find this grant and reverse the unspent portion.
  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.PROMO_FLOAT, amount),
      credit(promo(operation.userId), amount),
    ],
    meta: { kind: 'grantPromo', expiresAt },
  });

  // Record the grant in the same unit of work so it commits/rolls back with the credit. It
  // reuses the posting's id so the promo-expiry sweep can find and reverse the unspent portion
  // once it expires. `open` is idempotent on that id, so a retried grant never duplicates the row.
  await unit.promos.open({
    id: transaction.id,
    userId: operation.userId,
    amount,
    expiresAt,
    reversed: false,
  });

  return { status: 'committed', transaction };
}

// Caps how far in the future a grant may expire, in milliseconds. Every grant must expire so the
// sweep can reclaim unspent credit. This ceiling of five years stops a caller from minting an
// effectively never-expiring grant with a far-future timestamp.
let MAX_EXPIRY_AHEAD_MS = 5 * 365 * 24 * 60 * 60_000;

// Requires a finite, whole-millisecond timestamp that is strictly after now and no further out than
// the ceiling above, and returns it unchanged. Values from the wire can be NaN, Infinity, or
// fractional. A past, zero, or negative expiry would be immediately claimed by the reclaim sweep, which
// claims any grant whose `expiresAt` has already passed. These are all caller or programming
// mistakes, so it throws a MALFORMED fault rather than a "rejected" outcome.
function futureExpiresAt(expiresAt: number, ctx: Ctx, label: string): number {
  let now = ctx.clock.now();
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
