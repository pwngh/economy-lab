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
import { assertKind } from '#src/operations/guards.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { compare, encodeAmount, toAmount } from '#src/money.ts';
import { earned, routePlatformLegs, SYSTEM } from '#src/accounts.ts';
import { maturedAtLeast } from '#src/maturity.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Saga, Unit } from '#src/ports.ts';

/**
 * Starts a payout for a seller: reserves `amount` of earned credits into PAYOUT_RESERVE and opens
 * the saga in RESERVED for a worker to finish in USD. The two lines posted here are both CREDIT and
 * cancel out; the worker posts the USD side later. Only earned credit is payable. Insufficient
 * earned credit returns a `rejected` result; a malformed amount (not CREDIT, or not positive) throws.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/request-payout/
 *   Request payout} for the full payout request lifecycle.
 */
export async function requestPayout(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'requestPayout');
  const amount = payableCredit(operation.amount);

  if (amount.minor < ctx.config.payoutMinimumEarnedMinor) {
    return rejected('BELOW_MINIMUM', {
      account: earned(operation.userId),
      minimum: encodeAmount(
        toAmount('CREDIT', ctx.config.payoutMinimumEarnedMinor),
      ),
      requested: encodeAmount(amount),
    });
  }
  // Enforces a minimum gap (ctx.config.payoutMinIntervalMs) between a user's payout requests.
  // lastPayoutAt is the max `updatedAt` over this user's sagas; `null` means no prior payout, so a
  // first request passes. Strict `<`, so a request exactly the interval later is allowed. Runs
  // before the balance read so the cheap rejection comes first, and returns a rejection (not a
  // throw) so the caller can surface `retryAfter`.
  const last = await unit.sagas.lastPayoutAt(operation.userId);
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

  if (ctx.payees !== undefined) {
    const verification = await ctx.payees.status(operation.userId);
    if (verification.state !== 'CLEARED') {
      return rejected('PAYEE_UNVERIFIED', {
        account: earned(operation.userId),
        state: verification.state,
      });
    }
  }

  const available = await unit.ledger.balance(earned(operation.userId));
  if (compare(available, amount) < 0) {
    return rejected('INSUFFICIENT_FUNDS', {
      account: earned(operation.userId),
      required: encodeAmount(amount),
      available: encodeAmount(available),
    });
  }

  // A second, stricter gate after the raw balance: only earned credit past its settlement wait
  // is payable. maturedAtLeast asks the cheaper "is the cleared part at least `amount`?" and
  // stops early. Like INSUFFICIENT_FUNDS it returns a rejection rather than throwing.
  // See https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/ for why fresh
  // earnings clear on a delay and how the matured tail is measured.
  const cleared = await maturedAtLeast(
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

  const rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  // The reserve credit routes by the user id, not the idempotency key: settle and reverse know
  // only the saga, and the saga knows the user, so this is the shard their later debit finds.
  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: routePlatformLegs(
      [
        debit(earned(operation.userId), amount),
        credit(SYSTEM.PAYOUT_RESERVE, amount),
      ],
      operation.userId,
      ctx.config.platformShards,
    ),
    meta: { kind: 'requestPayout', rateId: rate.rateId },
  });
  await unit.sagas.open(sagaOf(operation, amount, rate.rateId, ctx));

  return { status: 'committed', transaction };
}

// Builds the saga record. It opens in RESERVED because the credits were set aside in the same
// DB transaction as this record. `rateId` locks the CREDIT-to-USD rate so the worker later pays
// at the rate that applied at request time, and `dueAt` is when the worker first tries to submit.
// See https://economy-lab-docs.pages.dev/economy/concepts/payout-saga/ for the payout saga's
// states and how the worker advances RESERVED to SUBMITTED to SETTLED.
function sagaOf(
  operation: Extract<Operation, { kind: 'requestPayout' }>,
  reserve: Amount,
  rateId: string,
  ctx: Ctx,
): Saga {
  const now = ctx.clock.now();
  return {
    id: ctx.ids.next('pay'),
    userId: operation.userId,
    reserve,
    rateId,
    state: 'RESERVED',
    providerRef: null,

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
  const sla = ctx.config.payoutSla;
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
      'requestPayout.amount must be positive.',
      { detail: { amount: encodeAmount(amount) } },
    );
  }
  return amount;
}
