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
 * The buy-credits flow: a user pays real money and gets spendable credits.
 *
 * It records two separate ledger postings, because a single posting can never mix two
 * currencies. The first raises the buyer's spendable CREDIT balance; the second accounts for the
 * USD the buyer paid. That cash splits: the credits' backing value goes into the platform's trust
 * account (TRUST_CASH, the real cash held to cover them), and the rest — the buy-vs-backing spread,
 * VRChat's ~40% "purchase fee" — is recognized as the platform's USD revenue (REVENUE_USD). The
 * CREDIT `REVENUE` account is still untouched here, so it keeps meaning transaction fees only. The
 * external app-store cut and VAT happen at the cash-in rail before this ledger sees the purchase
 * and are not modelled (see docs/vrchat-grounding.md).
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

  // A purchase reads two rates. `buy` is what the user pays per credit (≈120 credits/USD); `par`
  // is each credit's backing/cash-out value (≈200/USD). The user's cash splits in two: the backing
  // (held in trust to cover the credits) and the spread between the two rates — VRChat's ~40%
  // "purchase fee" — recognized as the platform's USD revenue.
  //
  // Both convert rounds UP (ceil), for two reasons. (1) Backing MUST round up: the backing check
  // values the WHOLE spendable balance at par as one floor, `floor(total × par)`, so depositing a
  // per-top-up floor would under-cover by the dropped fractions and the books would read unbacked
  // (Σ floor(Nᵢ·par) can be < floor(ΣNᵢ·par)). Ceiling each deposit guarantees trust cash always
  // covers the requirement. (2) Gross rounds up to match, so `buy ≥ par` keeps the margin ≥ 0. The
  // cost is the buyer paying at most one minor unit over the exact price — conservative and safe.
  let buy = ctx.rates.buy('CREDIT');
  let par = ctx.rates.par('CREDIT');
  let grossUsd = convertCeil(amount, buy, 'USD'); // what the buyer paid
  let backingUsd = convertCeil(amount, par, 'USD'); // held in trust to back the credits
  let marginUsd = toAmount('USD', grossUsd.minor - backingUsd.minor); // purchase-fee revenue

  // Post the CREDIT issuance first so the transaction this function returns is the one the
  // buyer cares about: their credits going up. It raises the buyer's spendable balance and
  // records the same amount against STORED_VALUE, the running count of all credits in
  // circulation.
  let issuance = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: [
      debit(SYSTEM.STORED_VALUE, amount),
      credit(spendable(operation.userId), amount),
    ],
    meta: { kind: 'topUp', source: operation.source },
  });
  // The second posting accounts for the buyer's cash: it credits USD_CLEARING the gross the buyer
  // paid, and splits the debit side into the backing held in trust (TRUST_CASH) and the platform's
  // purchase-fee revenue (REVENUE_USD, the buy-vs-par spread). The margin leg is added only when it
  // is positive, so an exact-par purchase stays a clean two-leg cash move.
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

// Check that the requested amount is in CREDIT and is greater than zero, returning it
// unchanged so it can be used inline. A top-up that asks for some other currency, or for
// zero or a negative amount, is a broken request, not a normal "no" answer the caller can
// recover from, so this throws a fault rather than returning a declined result.
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

// Require the funding source to be a non-blank string. The source selects how long the new
// credits must wait before they mature (see `maturityHorizonMs`), so an empty or whitespace-only
// source is malformed input — it would pick a maturity horizon off a meaningless key — and is
// thrown as a fault rather than declined.
function requireSource(source: string): void {
  if (source.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'topUp.source must be a non-empty funding source.',
      { detail: { source } },
    );
  }
}

// Convert a CREDIT amount to USD using the given exchange rate, rounding UP. The rate is stored as
// a whole number scaled up by 10^scale (so it can be held exactly as an integer), so multiplying by
// the rate and dividing by 10^scale recovers the real multiplier. The division rounds UP (add
// denominator − 1 before the integer divide) so the trust backing always covers the per-balance
// floor the backing check uses; see the call sites for why under-rounding the backing breaks it.
function convertCeil(amount: Amount, rate: Rate, to: Currency): Amount {
  let denominator = 10n ** BigInt(rate.scale);
  return toAmount(
    to,
    (amount.minor * rate.rate + denominator - 1n) / denominator,
  );
}

// Operations are routed to this handler by their `kind`, so if one arrives whose kind is not
// 'topUp', the routing was set up wrong. That is a programming bug, so this throws a fault to
// surface it loudly rather than quietly mishandling the operation.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
