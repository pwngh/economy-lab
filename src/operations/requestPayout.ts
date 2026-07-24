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
import {
  compare,
  convertFloor,
  encodeAmount,
  rateGte,
  toAmount,
} from '#src/money.ts';
import { earned, routePlatformLegs, SYSTEM } from '#src/accounts.ts';
import { maturedAtLeast, maturityBlocker } from '#src/maturity.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
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
      minimum: toAmount('CREDIT', ctx.config.payoutMinimumEarnedMinor),
      amount,
    });
  }
  // Minimum gap between a user's payout requests. `lastPayoutAt` is the max `updatedAt` over
  // their sagas; strict `<`, so a request exactly the interval later passes. Rejection, not
  // throw, so the caller can surface `retryAt`.
  const last = await unit.sagas.lastPayoutAt(operation.userId);
  if (
    last !== null &&
    ctx.clock.now() - last < ctx.config.payoutMinIntervalMs
  ) {
    return rejected('PAYOUT_TOO_SOON', {
      retryAt: last + ctx.config.payoutMinIntervalMs,
    });
  }

  if (ctx.payees !== undefined) {
    const verification = await ctx.payees.status(operation.userId);
    if (verification.state !== 'CLEARED') {
      return rejected('PAYEE_UNVERIFIED', { userId: operation.userId });
    }
  }

  const available = await unit.ledger.balance(earned(operation.userId));
  if (compare(available, amount) < 0) {
    return rejected('INSUFFICIENT_FUNDS', {
      account: earned(operation.userId),
      need: amount,
      have: available,
    });
  }

  // Stricter than the raw balance: only earned credit past its settlement wait is payable.
  // Rejection, not throw. See
  // https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/ for the maturity rule.
  const cleared = await maturedAtLeast(
    unit.ledger,
    earned(operation.userId),
    ctx.clock.now(),
    { config: ctx.config, amount, live: available },
  );
  if (!cleared) {
    return rejected(
      'FUNDS_IMMATURE',
      await maturityBlocker(
        unit.ledger,
        earned(operation.userId),
        ctx.clock.now(),
        {
          config: ctx.config,
          amount,
          live: available,
        },
      ),
    );
  }

  const quote = await priceQuote(ctx, amount);
  const transaction = await reserveAndOpen(unit, ctx, {
    operation,
    amount,
    quote,
  });

  return { status: 'committed', transaction };
}

// Posts the reserve and opens the saga anchored to it. The saga id is minted before the posting
// so the metadata can name the saga it opens; the reserve credit routes by the user id (settle
// and reverse know only the saga, which knows the user); and everything the worker will trust
// from the unhashed saga row — quote included — is sealed into this posting, so every later step
// re-proves the row against it.
async function reserveAndOpen(
  unit: Unit,
  ctx: Ctx,
  input: {
    operation: Extract<Operation, { kind: 'requestPayout' }>;
    amount: Amount;
    quote: { rateId: string; payoutUsd: Amount };
  },
): Promise<Transaction> {
  const { operation, amount } = input;
  const { rateId, payoutUsd } = input.quote;
  const sagaId = ctx.ids.next('pay');
  const txnId = ctx.ids.next('txn');
  const transaction = await postEntry(unit.ledger, {
    txnId,
    legs: routePlatformLegs(
      [
        debit(earned(operation.userId), amount),
        credit(SYSTEM.PAYOUT_RESERVE, amount),
      ],
      operation.userId,
      ctx.config.platformShards,
    ),
    meta: {
      kind: 'requestPayout',
      rateId,
      sagaId,
      payoutUsd: encodeAmount(payoutUsd),
    },
  });
  const opened = { id: sagaId, reserve: amount, rateId, payoutUsd, txnId };
  await unit.sagas.open(sagaOf(operation, opened, ctx));
  return transaction;
}

// Prices the payout once: this quote is the USD the worker submits to the rail and settle posts
// out of trust; neither re-fetches a rate. A payout rate above par would disburse more USD per
// credit than was ever collected for it, and the loss would only surface later as aggregate
// solvency drift — refuse it by name at the one place the payout is priced.
async function priceQuote(
  ctx: Ctx,
  amount: Amount,
): Promise<{ rateId: string; payoutUsd: Amount }> {
  const rate = await ctx.rates.payout('CREDIT', 'USD', ctx.clock.now());
  const par = ctx.rates.par('CREDIT');
  if (!rateGte(par, rate)) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Rates are misordered: payout is above par.',
      {
        retryable: false,
        detail: { parRateId: par.rateId, payoutRateId: rate.rateId },
      },
    );
  }
  return { rateId: rate.rateId, payoutUsd: convertFloor(amount, rate, 'USD') };
}

// Opens in RESERVED because the credits were set aside in the same DB transaction. `payoutUsd`
// is the quote priced above, and `rateId` names the rate that priced it; `dueAt` is the
// worker's first submit attempt. See
// https://economy-lab-docs.pages.dev/economy/concepts/payout-saga/ for the saga states.
function sagaOf(
  operation: Extract<Operation, { kind: 'requestPayout' }>,
  opened: {
    id: string;
    reserve: Amount;
    rateId: string;
    payoutUsd: Amount;
    txnId: string;
  },
  ctx: Ctx,
): Saga {
  const now = ctx.clock.now();
  return {
    id: opened.id,
    userId: operation.userId,
    reserve: opened.reserve,
    rateId: opened.rateId,
    txnId: opened.txnId,
    state: 'RESERVED',
    providerRef: null,

    reason: null,
    payoutUsd: opened.payoutUsd,
    attempts: 0,
    dueAt: now + pendingSlaMs(ctx),
    updatedAt: now,
  };
}

// Falls back to DEFAULT rather than 0 so an unset config doesn't make every payout due
// immediately and flood the worker's sweep.
function pendingSlaMs(ctx: Ctx): number {
  const sla = ctx.config.payoutSla;
  return sla.PENDING ?? sla.DEFAULT ?? 0;
}

// A USD or non-positive amount is a malformed request, so it throws a fault rather than declining.
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
