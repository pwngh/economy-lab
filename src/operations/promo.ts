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
import { credit, debit, postEntry } from '#src/ledger.ts';
import { encodeAmount } from '#src/money.ts';
import { SYSTEM, promo } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Unit } from '#src/ports.ts';

/**
 * Issue marketing promo credits to a user. Posts one balanced entry: raise the user's promo
 * balance by the granted amount, offset by an equal entry on the platform's PROMO_FLOAT account.
 *
 * Promo credits need no USD backing (unlike topped-up money), so a grant can't increase the cash
 * held in trust. Spendable but never cashed out (only earned credits pay out). `expiresAt` is
 * stored in the entry metadata so the background worker can later reverse any unspent portion.
 *
 * @example
 *   let outcome = await grantPromo(
 *     { kind: 'grantPromo', idempotencyKey: 'idem_0', actor: { kind: 'system', service: 'marketing' },
 *       userId: 'usr_buyer', amount: toAmount('CREDIT', 500n), expiresAt: 86_400_000 },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; promo(usr_buyer) rose by 500, offset by PROMO_FLOAT.
 */
export async function grantPromo(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'grantPromo') {
    throw kindMismatch(operation);
  }
  let amount = positiveCredit(operation.amount, 'grantPromo.amount');
  let expiresAt = futureExpiresAt(
    operation.expiresAt,
    ctx,
    'grantPromo.expiresAt',
  );

  // PROMO_FLOAT is debit-normal, so debiting it raises its balance to offset the user's credit.
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

// Amount must be CREDIT and positive. A failure here is a caller/programming mistake, so throw
// a fault rather than a "rejected" outcome (rejected is for business "no" answers like
// insufficient funds).
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

// Max expiry distance for a grant, in ms. Every grant must expire so the sweep can reclaim
// unspent credit; this ceiling (five years) stops a caller from minting an effectively
// never-expiring grant via an absurd far-future timestamp.
let MAX_EXPIRY_AHEAD_MS = 5 * 365 * 24 * 60 * 60_000;

// Expiry must be a finite, whole-ms timestamp strictly after now and no further out than the
// ceiling above. Off-the-wire values can be NaN, Infinity, or fractional; a zero/negative/past
// expiry would immediately poison the reclaim sweep, which claims any grant whose `expiresAt`
// has already passed. All caller/programming mistakes, so throw a MALFORMED fault, not a
// "rejected" outcome.
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

// Operations dispatch to handlers by `kind`, so this one should only ever see 'grantPromo'.
// Any other kind means the dispatch table is wired wrong, so build a loud fault.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
