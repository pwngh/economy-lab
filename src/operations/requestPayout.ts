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

import { fault, rejected, ERROR_CODES } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { compare, encodeAmount, toAmount } from '#src/money.ts';
import { earned, SYSTEM } from '#src/accounts.ts';
import { maturedBalance } from '#src/maturity.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Start a payout for a seller: set aside `amount` of the credits they have earned, then
 * open a record (a "saga") that a background worker later finishes by paying the seller
 * in real USD.
 *
 * This function is the only part a caller drives directly. It does just the bookkeeping:
 * move the earned credits into the PAYOUT_RESERVE account and open the saga in the
 * RESERVED state. A background worker takes it from there — submitting to the payment
 * provider, then settling and posting the USD side. (PAYOUT_RESERVE is the platform's
 * holding account for credits owed out as a payout; it is separate from HELD, which holds
 * funds for in-app purchases.)
 *
 * Two outcomes a caller must handle:
 * - The seller doesn't have enough earned credit: a returned `rejected` result, not an
 *   exception. The caller inspects it.
 * - The request itself is wrong (amount isn't CREDIT, or isn't positive): a thrown fault,
 *   because that's a programming error, not a normal "no".
 *
 * Only earned credit can be paid out. It's paid as USD when the worker settles, and is
 * never made spendable inside the app. The two ledger lines this function posts are both
 * in CREDIT and cancel out, so the books stay balanced; the USD side is posted later by
 * the worker.
 */
export async function requestPayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'requestPayout') {
    throw kindMismatch(operation);
  }
  let amount = payableCredit(operation.amount);

  if (amount.minor < ctx.config.payoutMinimumEarnedMinor) {
    return rejected('BELOW_MINIMUM', {
      account: earned(operation.userId),
      minimum: encodeAmount(
        toAmount('CREDIT', ctx.config.payoutMinimumEarnedMinor),
      ),
      requested: encodeAmount(amount),
    });
  }
  // Enforce the shortest gap allowed between one user's payout requests
  // (ctx.config.payoutMinIntervalMs; default 24h, legal limit 14 days). lastPayoutAt is the
  // maximum `updatedAt` over all of this user's sagas in any state — equal to their most
  // recent request time. `null` means no prior payout, so a first request always passes.
  // The boundary is strict `<`: a request exactly `payoutMinIntervalMs` later is allowed.
  // This is checked before the balance read so a cheap rejection comes first, matching the
  // minimum-before-balance ordering above. It RETURNS a rejection (an expected "no") rather
  // than throwing, so the caller can surface `retryAfter`.
  let last = await unit.sagas.lastPayoutAt(operation.userId);
  if (
    last !== null &&
    ctx.clock.now() - last < ctx.config.payoutMinIntervalMs
  ) {
    return rejected('PAYOUT_TOO_SOON', {
      account: earned(operation.userId),
      lastRequestedAt: last,
      retryAfter: last + ctx.config.payoutMinIntervalMs,
    });
  }

  let available = await unit.ledger.balance(earned(operation.userId));
  if (compare(available, amount) < 0) {
    return rejected('INSUFFICIENT_FUNDS', {
      account: earned(operation.userId),
      required: encodeAmount(amount),
      available: encodeAmount(available),
    });
  }

  // Only earned credit that has cleared its settlement wait can be paid out: a chargeback
  // window must elapse before the platform pays real USD against those credits. The raw
  // balance above can be enough while part of it is still maturing, so this is a second,
  // stricter gate. Like INSUFFICIENT_FUNDS it RETURNS a rejection (a normal "no") rather
  // than throwing. No `signal` is threaded here, matching the raw balance read just above.
  let matured = await maturedBalance(
    unit.ledger,
    earned(operation.userId),
    ctx.clock.now(),
    {
      config: ctx.config,
    },
  );
  if (compare(matured, amount) < 0) {
    return rejected('FUNDS_IMMATURE', {
      account: earned(operation.userId),
      required: encodeAmount(amount),
      available: encodeAmount(matured),
    });
  }

  let rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(earned(operation.userId), amount),
      credit(SYSTEM.PAYOUT_RESERVE, amount),
    ],
    meta: { kind: 'requestPayout', rateId: rate.rateId },
  });
  await unit.sagas.open(sagaOf(operation, amount, rate.rateId, ctx));

  return { status: 'committed', transaction };
}

// Build the saga record for this payout. It opens in the RESERVED state because the
// credits were already set aside in the same database transaction as this record.
// Fields worth calling out:
// - `reserve`: the earned credits held in PAYOUT_RESERVE for this payout.
// - `rateId`: identifies the audited CREDIT-to-USD rate to use, so the worker pays out at
//   the rate that applied when the request was made.
// - `dueAt`: when the worker should first try to submit this to the payment provider.
// The worker's periodic sweep picks up due sagas and moves them on to SUBMITTED, then
// SETTLED.
function sagaOf(
  operation: Extract<Operation, { kind: 'requestPayout' }>,
  reserve: Amount,
  rateId: string,
  ctx: Ctx,
): Saga {
  let now = ctx.clock.now();
  return {
    id: ctx.ids.next('pay'),
    userId: operation.userId,
    reserve,
    rateId,
    state: 'RESERVED',
    providerRef: null,
    attempts: 0,
    dueAt: now + pendingSlaMs(ctx),
    updatedAt: now,
  };
}

// How long to wait before the worker's first attempt to submit this payout to the
// provider, in milliseconds. Read from config: use the PENDING delay if set, otherwise the
// DEFAULT. Falling back to DEFAULT (rather than 0) keeps an unset config from making the
// payout due immediately and flooding the worker's sweep.
function pendingSlaMs(ctx: Ctx): number {
  let sla = ctx.config.payoutSla;
  return sla.PENDING ?? sla.DEFAULT ?? 0;
}

// Check that the requested amount is payable and return it unchanged. Only earned credit
// can be paid out, so the amount must be in CREDIT and must be positive. A USD amount or a
// zero/negative amount is a malformed request, so this throws a fault rather than returning
// a declined result.
function payableCredit(amount: Amount): Amount {
  if (amount.currency !== 'CREDIT') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'requestPayout.amount must be earned CREDIT.',
      { detail: { amount: encodeAmount(amount) } },
    );
  }
  if (amount.minor <= 0n) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'requestPayout.amount must be a strictly positive amount.',
      { detail: { amount: encodeAmount(amount) } },
    );
  }
  return amount;
}

// Build the fault thrown when this handler is somehow called with the wrong kind of
// operation. That can only happen through a wiring mistake in the code, so it's a thrown
// fault, not a declined result.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `requestPayout handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
