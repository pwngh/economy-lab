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
import { convertCeil, requirePositiveCredit, toAmount } from '#src/money.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';
import { assertKind } from '#src/operations/guards.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Unit } from '#src/ports.ts';

/**
 * Buys credits: the user pays real money and gets spendable credits in return. It posts twice,
 * because one posting can't mix currencies. The first posting raises the buyer's spendable CREDIT.
 * The second records the USD paid, split into backing (held in TRUST_CASH) and the buy-vs-par spread
 * (recognized as REVENUE_USD).
 *
 * @example
 *   let outcome = await topUp(
 *     { kind: 'topUp', idempotencyKey: 'idem_0', actor: { kind: 'system', service: 'buy' },
 *       userId: 'usr_buyer', amount: toAmount('CREDIT', 1000n), source: 'card' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; spendable(usr_buyer) rose by 1000.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/top-up/ Top-up}
 */
export async function topUp(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'topUp');
  requireSource(operation.source);
  let amount = requirePositiveCredit(operation.amount, 'topUp.amount');

  // Both conversions round up. The backing rounds up because the solvency check values the whole
  // spendable balance at par and floors it once. Flooring each top-up's backing separately would
  // hold back less than that single floor, so the balance would read as unbacked. The gross paid
  // rounds up to match, which keeps buy at or above par and the margin non-negative.
  let buy = ctx.rates.buy('CREDIT');
  let par = ctx.rates.par('CREDIT');
  let grossUsd = convertCeil(amount, buy, 'USD');
  let backingUsd = convertCeil(amount, par, 'USD');
  let marginUsd = toAmount('USD', grossUsd.minor - backingUsd.minor);

  // The issuance posts first, so the returned transaction is the one the buyer cares about: their
  // credits going up. Its matching debit records against STORED_VALUE, the running count of credits
  // in circulation.
  let issuance = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.STORED_VALUE, amount),
      credit(spendable(operation.userId), amount),
    ],
    meta: { kind: 'topUp', source: operation.source },
  });
  // The cash posting credits the gross paid to USD_CLEARING and splits the debit into backing
  // (TRUST_CASH) and the buy-vs-par spread (REVENUE_USD). The spread leg is added only when it is
  // positive, so a purchase at exactly par has just two legs.
  let cashLegs = [debit(SYSTEM.TRUST_CASH, backingUsd)];
  if (marginUsd.minor > 0n) {
    cashLegs.push(debit(SYSTEM.REVENUE_USD, marginUsd));
  }
  cashLegs.push(credit(SYSTEM.USD_CLEARING, grossUsd));
  await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: cashLegs,
    meta: { kind: 'topUp.cash', rateId: buy.rateId, parRateId: par.rateId },
  });

  return { status: 'committed', transaction: issuance };
}

// Requires a non-blank funding source. The source selects the credits' maturity horizon
// (`maturityHorizonMs`), so a blank or whitespace-only value is malformed input.
function requireSource(source: string): void {
  if (source.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'topUp.source must be a non-empty funding source.',
      { detail: { source } },
    );
  }
}
