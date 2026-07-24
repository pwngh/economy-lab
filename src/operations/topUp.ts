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
import { credit, debit, postEntries } from '#src/ledger.ts';
import {
  convertCeil,
  encodeAmount,
  requirePositiveCredit,
  toAmount,
} from '#src/money.ts';
import { SYSTEM, routePlatformLegs, spendable } from '#src/accounts.ts';
import { assertKind } from '#src/operations/guards.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Unit } from '#src/ports.ts';

/**
 * Buys credits: the user pays real money and gets spendable credits in return. It posts twice,
 * because one posting can't mix currencies. The first posting raises the buyer's spendable CREDIT.
 * The second records the USD paid, split into backing (held in TRUST_CASH) and the buy-vs-par spread
 * (recognized as REVENUE_USD).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/top-up/ Top-up} for
 *   the issuance and cash postings.
 */
export async function topUp(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'topUp');
  requireSource(operation.source);
  const amount = requirePositiveCredit(operation.amount, 'topUp.amount');
  requireBundleAmount(amount, ctx.config.topUpBundlesMinor);

  // Both conversions round up. The backing rounds up because the solvency check values the whole
  // spendable balance at par and floors it once. Flooring each top-up's backing separately would
  // hold back less than that single floor, so the balance would read as unbacked. The gross paid
  // rounds up to match, which keeps buy at or above par and the margin non-negative.
  const buy = ctx.rates.buy('CREDIT');
  const par = ctx.rates.par('CREDIT');
  const grossUsd = convertCeil(amount, buy, 'USD');
  const backingUsd = convertCeil(amount, par, 'USD');
  const marginUsd = toAmount('USD', grossUsd.minor - backingUsd.minor);

  // A negative margin means the rate source turned misordered after construction. Without this
  // named fault, the skipped spread leg would surface as LEDGER_UNBALANCED, blaming the ledger
  // for a configuration error.
  if (marginUsd.minor < 0n) {
    throw fault(
      ERROR_CODES.CONFIG_INVALID,
      'Rates are misordered: buy is below par.',
      {
        retryable: false,
        detail: { buyRateId: buy.rateId, parRateId: par.rateId },
      },
    );
  }

  // The issuance posts first, so the returned transaction is the buyer's credits going up. Both
  // postings route platform legs by the idempotency key — the key the lock set routed by — so
  // the rows locked are the rows posted. The spread leg is added only when positive, so a
  // purchase at exactly par has just two legs. The CREDIT and USD sides share no account, so
  // postEntries can fuse the pair.
  const cashLegs = [debit(SYSTEM.TRUST_CASH, backingUsd)];
  if (marginUsd.minor > 0n) {
    cashLegs.push(debit(SYSTEM.REVENUE_USD, marginUsd));
  }
  cashLegs.push(credit(SYSTEM.USD_CLEARING, grossUsd));
  const [issuance] = await postEntries(unit.ledger, [
    {
      txnId: ctx.ids.next('txn'),
      legs: routePlatformLegs(
        [
          debit(SYSTEM.STORED_VALUE, amount),
          credit(spendable(operation.userId), amount),
        ],
        operation.idempotencyKey,
        ctx.config.platformShards,
      ),
      meta: { kind: 'topUp', source: operation.source },
    },
    {
      txnId: ctx.ids.next('txn'),
      legs: routePlatformLegs(
        cashLegs,
        operation.idempotencyKey,
        ctx.config.platformShards,
      ),
      meta: { kind: 'topUp.cash', rateId: buy.rateId, parRateId: par.rateId },
    },
  ]);

  return { status: 'committed', transaction: issuance! };
}

// When the deployment lists a purchase catalog, only those bundle amounts exist to buy; any
// other amount is a mispriced grant, not a purchase.
function requireBundleAmount(
  amount: Amount,
  bundles: readonly bigint[] | undefined,
): void {
  if (bundles === undefined || bundles.includes(amount.minor)) {
    return;
  }
  throw fault(
    ERROR_CODES.MALFORMED_OPERATION,
    'topUp.amount is not in the configured purchase catalog.',
    {
      detail: {
        amount: encodeAmount(amount),
        bundles: bundles.map((bundle) =>
          encodeAmount(toAmount('CREDIT', bundle)),
        ),
      },
    },
  );
}

// The source selects the credits' maturity horizon, so a blank value is malformed input.
function requireSource(source: string): void {
  if (source.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'topUp.source must be a non-empty funding source.',
      { detail: { source } },
    );
  }
}
