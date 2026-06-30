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
import { maturedAtLeast } from '#src/maturity.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Starts a payout for a seller. It reserves `amount` of their earned credits and opens a saga
 * that a background worker later finishes by paying real USD.
 *
 * This handler does the caller-driven bookkeeping only. It moves earned credits into
 * PAYOUT_RESERVE and opens the saga in RESERVED. The worker then submits to the payment
 * provider, settles, and posts the USD side. (PAYOUT_RESERVE holds credits owed out as a
 * payout. It is separate from HELD, which holds funds for in-app purchases.)
 *
 * The caller handles two outcomes. Not enough earned credit returns a `rejected` result to
 * inspect rather than an exception. A malformed request, where the amount is not CREDIT or is
 * not positive, throws a fault because it is a programming error.
 *
 * Only earned credit is payable. It is paid as USD on settle and is never made spendable
 * in-app. The two ledger lines posted here are both CREDIT and cancel out. The worker posts
 * the USD later.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/request-payout/ Request payout} for the full payout request lifecycle.
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
  // Enforces a minimum gap between one user's payout requests. The gap is
  // ctx.config.payoutMinIntervalMs, which defaults to 24h with a legal limit of 14 days.
  // lastPayoutAt is the max `updatedAt` over this user's sagas in any state, which is their
  // most recent request time. A `null` means no prior payout, so a first request passes. The
  // comparison is a strict `<`, so a request exactly `payoutMinIntervalMs` later is allowed.
  // This runs before the balance read so the cheap rejection comes first, matching the
  // minimum-before-balance ordering above. It returns a rejection rather than throwing, so the
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
  // maturing, so this is a second, stricter gate. The check only asks whether the cleared part
  // is at least `amount`, so it calls maturedAtLeast, which stops as soon as the matured tail
  // covers `amount` rather than summing the whole open tail. Like INSUFFICIENT_FUNDS it returns
  // a rejection rather than throwing. No `signal` is threaded here, matching the raw balance
  // read.
  let cleared = await maturedAtLeast(
    unit.ledger,
    earned(operation.userId),
    ctx.clock.now(),
    { config: ctx.config, amount },
  );
  if (!cleared) {
    return rejected('FUNDS_IMMATURE', {
      account: earned(operation.userId),
      required: encodeAmount(amount),
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

// Builds the saga record. The saga opens in RESERVED because the credits were set aside in
// the same DB transaction as this record.
//
// The fields work as follows. `reserve` is the earned credits held in PAYOUT_RESERVE for this
// payout. `rateId` is the audited CREDIT-to-USD rate, so the worker pays at the rate that
// applied when the request was made. `dueAt` is when the worker should first try submitting to
// the provider.
//
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

// Returns the delay in milliseconds before the worker's first submit attempt. It uses the
// PENDING SLA if set, otherwise DEFAULT. Falling back to DEFAULT rather than 0 keeps an unset
// config from making the payout due immediately and flooding the worker's sweep.
function pendingSlaMs(ctx: Ctx): number {
  let sla = ctx.config.payoutSla;
  return sla.PENDING ?? sla.DEFAULT ?? 0;
}

// Validates the requested amount and returns it unchanged. The amount must be CREDIT and
// positive. A USD or zero/negative amount is a malformed request, so it throws a fault rather
// than declining.
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

// Builds the fault thrown when this handler is called with the wrong operation kind. This only
// happens through a wiring mistake, so it is a thrown fault rather than a declined result.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `requestPayout handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
