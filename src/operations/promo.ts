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
 * Issue marketing promo credits to a user. This posts one balanced entry: it raises the
 * user's promo balance by the granted amount, and matches that with an equal entry on the
 * platform's PROMO_FLOAT account so the books still balance.
 *
 * Promo credits never need real USD backing the way topped-up money does, so a grant can't
 * increase the cash the platform must hold in trust. They can be spent but never cashed out
 * (only earned credits are paid out). The grant's `expiresAt` is saved in the entry's
 * metadata so the background worker can later reverse any of it the user hasn't spent.
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

  // Post the two matching lines: debit PROMO_FLOAT and credit the user's promo account,
  // both for the same amount, so the entry balances. The credit raises the user's promo
  // balance; the debit to PROMO_FLOAT (which goes up when debited) records the platform's
  // matching side. The `expiresAt` goes into the entry's metadata so the background
  // worker's expiry job can later find this grant and reverse whatever the user hasn't spent.
  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.PROMO_FLOAT, amount),
      credit(promo(operation.userId), amount),
    ],
    meta: { kind: 'grantPromo', expiresAt },
  });

  // Record the grant alongside the posting, inside the same unit of work, so it commits or
  // rolls back together with the credit. The grant reuses the posting's id, so the
  // promo-expiry sweep can find it and reverse whatever the user hasn't spent once it
  // expires. `open` is idempotent on that id, so a retried grant never duplicates the row.
  await unit.promos.open({
    id: transaction.id,
    userId: operation.userId,
    amount,
    expiresAt,
    reversed: false,
  });

  return { status: 'committed', transaction };
}

// Check the grant amount before posting: it must be in CREDIT and greater than zero. A
// grant that fails either check is a programming or caller mistake, so this throws a fault
// rather than returning a "rejected" outcome (which is reserved for normal business "no"
// answers like insufficient funds).
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

// How far in the future a promo grant may be set to expire, in milliseconds. A grant must
// expire so the promo-expiry sweep can later reclaim whatever the user hasn't spent; this
// ceiling (five years out) stops a caller from minting an effectively never-expiring grant by
// passing an absurd far-future timestamp.
let MAX_EXPIRY_AHEAD_MS = 5 * 365 * 24 * 60 * 60_000;

// Check the grant's expiry before posting: it must be a finite, whole-millisecond timestamp
// that lands strictly after now and no further out than the ceiling above. A value off the
// wire can arrive as NaN, Infinity, or a fraction, and a zero/negative/past expiry would be
// dead on arrival — it would poison the promo-expiry reclaim sweep, which claims any grant
// whose `expiresAt` has already passed. All of these are caller/programming mistakes, so this
// throws a fault (a MALFORMED operation) rather than returning a "rejected" business outcome.
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

// Operations are dispatched to handlers by their `kind` field, so this handler should only
// ever receive a 'grantPromo' operation. Getting any other kind means the dispatch table is
// wired wrong, so this builds a loud fault instead of trying to process it.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
