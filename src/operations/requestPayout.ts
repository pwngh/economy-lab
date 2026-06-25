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
 * Start a payout for a seller: reserve `amount` of their earned credits and open a saga
 * that a background worker later finishes by paying real USD.
 *
 * Caller-driven bookkeeping only: move earned credits into PAYOUT_RESERVE and open the saga
 * RESERVED. The worker submits to the payment provider, settles, and posts the USD side.
 * (PAYOUT_RESERVE holds credits owed out as a payout; separate from HELD, which holds funds
 * for in-app purchases.)
 *
 * Two outcomes the caller handles:
 * - Not enough earned credit: a returned `rejected` result to inspect, not an exception.
 * - Malformed request (amount isn't CREDIT, or isn't positive): a thrown fault, since that's
 *   a programming error.
 *
 * Only earned credit is payable; it's paid as USD on settle and never made spendable in-app.
 * The two ledger lines posted here are both CREDIT and cancel out; the worker posts USD later.
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
  // Minimum gap between one user's payout requests (ctx.config.payoutMinIntervalMs; default
  // 24h, legal limit 14 days). lastPayoutAt is the max `updatedAt` over this user's sagas in
  // any state, i.e. their most recent request time; `null` means no prior payout, so a first
  // request passes. Strict `<`: a request exactly `payoutMinIntervalMs` later is allowed.
  // Checked before the balance read so the cheap rejection comes first, matching the
  // minimum-before-balance ordering above. Returns a rejection rather than throwing, so the
  // caller can surface `retryAfter`.
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

  // Only earned credit past its settlement wait is payable: a chargeback window must elapse
  // before paying real USD against it. The raw balance above can pass while part is still
  // maturing, so this is a second, stricter gate. Like INSUFFICIENT_FUNDS it returns a
  // rejection rather than throwing. No `signal` threaded here, matching the raw balance read.
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

// Build the saga record. Opens RESERVED because the credits were set aside in the same DB
// transaction as this record.
// - `reserve`: earned credits held in PAYOUT_RESERVE for this payout.
// - `rateId`: audited CREDIT-to-USD rate, so the worker pays at the rate that applied when
//   the request was made.
// - `dueAt`: when the worker should first try submitting to the provider.
// The worker's periodic sweep picks up due sagas and advances them to SUBMITTED, then SETTLED.
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
    // Terminal-outcome fields, set only once the payout reaches SETTLED (payoutUsd) or FAILED
    // (reason); null on a freshly requested payout.
    reason: null,
    payoutUsd: null,
    attempts: 0,
    dueAt: now + pendingSlaMs(ctx),
    updatedAt: now,
  };
}

// Delay (ms) before the worker's first submit attempt. PENDING if set, else DEFAULT. Falling
// back to DEFAULT rather than 0 keeps an unset config from making the payout due immediately
// and flooding the worker's sweep.
function pendingSlaMs(ctx: Ctx): number {
  let sla = ctx.config.payoutSla;
  return sla.PENDING ?? sla.DEFAULT ?? 0;
}

// Validate the requested amount and return it unchanged. Must be CREDIT and positive; a USD
// or zero/negative amount is a malformed request, so throw a fault rather than declining.
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

// Fault thrown when this handler is called with the wrong operation kind. Only happens via a
// wiring mistake, so it's a thrown fault, not a declined result.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `requestPayout handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
