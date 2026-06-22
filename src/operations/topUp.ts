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
import { encodeAmount, toAmount } from '#src/money.ts';
import { SYSTEM, spendable } from '#src/accounts.ts';

import type { Amount, Currency } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Rate, Unit } from '#src/ports.ts';

/**
 * Buy-credits flow: user pays real money, gets spendable credits.
 *
 * Two ledger postings, since one posting can't mix currencies. First raises the buyer's spendable
 * CREDIT balance; second accounts for the USD paid. The cash splits: backing value goes to
 * TRUST_CASH (real cash held to cover the credits), and the buy-vs-backing spread (VRChat's ~40%
 * "purchase fee") is recognized as USD revenue (REVENUE_USD). The CREDIT `REVENUE` account is
 * untouched, so it stays meaning transaction fees only. The external app-store cut and VAT happen
 * at the cash-in rail before this ledger sees the purchase and aren't modelled (see
 * docs/vrchat-grounding.md).
 *
 * @example
 *   let outcome = await topUp(
 *     { kind: 'topUp', idempotencyKey: 'idem_0', actor: { kind: 'system', service: 'buy' },
 *       userId: 'usr_buyer', amount: toAmount('CREDIT', 1000n), source: 'card' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; spendable(usr_buyer) rose by 1000, REVENUE untouched.
 */
export async function topUp(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'topUp') {
    throw kindMismatch(operation);
  }
  requireSource(operation.source);
  let amount = positiveCredit(operation.amount, 'topUp.amount');

  // Two rates: `buy` is what the user pays per credit (≈120 credits/USD); `par` is each credit's
  // backing/cash-out value (≈200/USD). The cash splits into the backing (held in trust) and the
  // buy-vs-par spread (VRChat's ~40% "purchase fee"), recognized as USD revenue.
  //
  // Both conversions round up (ceil), for two reasons. (1) Backing must round up: the backing check
  // values the whole spendable balance at par as one floor, `floor(total × par)`, so a per-top-up
  // floor would under-cover by the dropped fractions and the books would read unbacked
  // (Σ floor(Nᵢ·par) can be < floor(ΣNᵢ·par)). Ceiling each deposit keeps trust cash covering the
  // requirement. (2) Gross rounds up to match, so `buy ≥ par` keeps margin ≥ 0. Cost: the buyer
  // pays at most one minor unit over the exact price.
  let buy = ctx.rates.buy('CREDIT');
  let par = ctx.rates.par('CREDIT');
  let grossUsd = convertCeil(amount, buy, 'USD'); // what the buyer paid
  let backingUsd = convertCeil(amount, par, 'USD'); // held in trust to back the credits
  let marginUsd = toAmount('USD', grossUsd.minor - backingUsd.minor); // purchase-fee revenue

  // Post the CREDIT issuance first so the returned transaction is the one the buyer cares about:
  // their credits going up. Raises the buyer's spendable balance and records the same amount
  // against STORED_VALUE (running count of all credits in circulation).
  let issuance = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.STORED_VALUE, amount),
      credit(spendable(operation.userId), amount),
    ],
    meta: { kind: 'topUp', source: operation.source },
  });
  // Second posting accounts for the buyer's cash: credits USD_CLEARING the gross paid, splits the
  // debit side into backing held in trust (TRUST_CASH) and purchase-fee revenue (REVENUE_USD, the
  // buy-vs-par spread). The margin leg is added only when positive, so an exact-par purchase stays
  // a two-leg cash move.
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

// Require the amount to be CREDIT and positive, returning it unchanged for inline use. A wrong
// currency or a zero/negative amount is a broken request, not a recoverable decline, so it throws
// a fault rather than returning a declined result.
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

// Require a non-blank funding source. The source selects the credits' maturity horizon (see
// `maturityHorizonMs`), so an empty or whitespace-only source is malformed input (it would key the
// horizon off a meaningless string), thrown as a fault rather than declined.
function requireSource(source: string): void {
  if (source.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'topUp.source must be a non-empty funding source.',
      { detail: { source } },
    );
  }
}

// Convert a CREDIT amount to USD at the given rate, rounding up. The rate is an integer scaled by
// 10^scale, so multiply by rate and divide by 10^scale to recover the real multiplier. The divide
// rounds up (add denominator − 1 before the integer divide) so trust backing always covers the
// per-balance floor the backing check uses; see call sites for why under-rounding breaks it.
function convertCeil(amount: Amount, rate: Rate, to: Currency): Amount {
  let denominator = 10n ** BigInt(rate.scale);
  return toAmount(
    to,
    (amount.minor * rate.rate + denominator - 1n) / denominator,
  );
}

// Operations are routed here by `kind`; a non-'topUp' kind means the routing is wrong. That's a
// programming bug, so throw a fault rather than mishandle the operation.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
