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

import { rejected, fault, ERROR_CODES } from '#src/errors.ts';
import { assertKind } from '#src/operations/guards.ts';
import { planSpend } from '#src/operations/spend.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { compare, encodeAmount, toAmount } from '#src/money.ts';
import { promo, spendable, earned, SYSTEM } from '#src/accounts.ts';
import { maturedAtLeast, maturedAvailableAt } from '#src/maturity.ts';
import { feeForPrice } from '#src/pricing.ts';

import type { Amount } from '#src/money.ts';
import type { Config } from '#src/config.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { SpendPlan } from '#src/operations/spend.ts';
import type { Leg, Subscription, Unit } from '#src/ports.ts';

// The longest accepted billing period is ten 365-day years, in milliseconds. A longer period is
// treated as garbage off the wire (a bad unit conversion, an overflow, or seconds used for ms)
// and rejected as malformed. This ceiling also stays well below Number.MAX_SAFE_INTEGER, so
// `postedAt + periodMs` cannot lose precision.
const MAX_PERIOD_MS = 10 * 365 * 24 * 60 * 60_000; // 315,360,000,000 ms

/**
 * Charge the first month of a subscription and create its record: validate the price, post the
 * charge (seller earns, platform takes its fee), then save the `Subscription` the background
 * worker renews each later month. Returns `committed`, or a `rejected` outcome for a duplicate
 * active subscription (`ALREADY_SUBSCRIBED`) or a short spendable balance (`INSUFFICIENT_FUNDS`).
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/subscribe/ Subscribe}
 *   for the first-month charge and renewal handoff.
 */
export async function subscribe(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'subscribe');
  rejectSelfSubscription(operation);
  validateFields(operation);
  const price = validatedPrice(operation.price, ctx.config);

  // Refuse a second ACTIVE subscription to the same (userId, sku, sellerId), because a second one
  // would double-bill. This is an ordinary business "no", so return a rejected outcome and post
  // nothing rather than throw a fault.
  const existing = await unit.subscriptions.activeFor(
    operation.userId,
    operation.sku,
    operation.sellerId,
  );
  if (existing !== null) {
    return rejected('ALREADY_SUBSCRIBED', {
      userId: operation.userId,
      sku: operation.sku,
      sellerId: operation.sellerId,
      subscriptionId: existing.id,
    });
  }

  // Promo draws first; planSpend (spend.ts) is the one implementation of the split rule.
  const promoBalance = await unit.ledger.balance(promo(operation.userId));
  const plan = planSpend(price, promoBalance);

  const shortfall = await screenSpendable(unit, ctx, operation.userId, plan);
  if (shortfall) {
    return shortfall;
  }

  const transaction = await postCharge(operation, plan, unit, ctx);
  const subscriptionId = await openSubscription(
    operation,
    transaction,
    unit,
    ctx,
  );

  // Same transaction (`unit`) as the charge. A lapsed subscription's old grant row was marked
  // revoked rather than deleted; this grant clears that mark and reactivates ownership.
  // See https://economy-lab-docs.pages.dev/economy/reference/operations/subscribe/ for the
  // same-transaction grant and renewal handoff.
  await unit.entitlements.grant(operation.userId, operation.sku, {
    expiresAt: transaction.postedAt + operation.periodMs,
    source: 'subscription:' + subscriptionId,
  });

  return { status: 'committed', transaction };
}

// --- Validation -------------------------------------------------------------------

// A self-subscription would credit the buyer's own non-payable promo/spendable back as payable
// EARNED funded by platform REVENUE — laundering — so it's malformed, not a business "no".
function rejectSelfSubscription(
  operation: Extract<Operation, { kind: 'subscribe' }>,
): void {
  if (operation.userId === operation.sellerId) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.userId and subscribe.sellerId must differ; a buyer cannot subscribe to themselves.',
      { detail: { userId: operation.userId, sellerId: operation.sellerId } },
    );
  }
}

// Op-specific guards the central validateOperation can't cover. A NaN, fractional, non-positive,
// or over-ceiling `periodMs` corrupts the billing math, and a blank `sku` would key an entitlement
// grant to nothing; both are wiring errors, so throw a fault.
function validateFields(
  operation: Extract<Operation, { kind: 'subscribe' }>,
): void {
  const periodMs = operation.periodMs;
  if (
    !Number.isInteger(periodMs) ||
    periodMs <= 0 ||
    periodMs > MAX_PERIOD_MS
  ) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.periodMs must be a finite positive integer no larger than the ten-year ceiling.',
      { detail: { periodMs, max: MAX_PERIOD_MS } },
    );
  }
  if (typeof operation.sku !== 'string' || operation.sku.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.sku must be a non-empty string.',
      { detail: { sku: operation.sku } },
    );
  }
}

// A wrong currency or out-of-band price is a wiring error, so throw a fault rather than decline.
// The band is config (SUBSCRIPTION_PRICE_MIN/MAX_MINOR), defaulting to 100 to 10,000 credits.
function validatedPrice(price: Amount, config: Config): Amount {
  if (price.currency !== 'CREDIT') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.price must be CREDIT.',
      { detail: { amount: encodeAmount(price) } },
    );
  }
  const min = config.subscriptionPriceMinMinor;
  const max = config.subscriptionPriceMaxMinor;
  if (price.minor < min || price.minor > max) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.price is outside the configured price band.',
      {
        detail: {
          amount: encodeAmount(price),
          min: encodeAmount(toAmount('CREDIT', min)),
          max: encodeAmount(toAmount('CREDIT', max)),
        },
      },
    );
  }
  return price;
}

// --- The funds plan ---------------------------------------------------------------

// The submit pipeline's funds check (screenFunds) only runs for `spend`, so subscribe checks here.
// A pre-check only: the database's per-user non-negative CHECK is what blocks overdrafts.
async function screenSpendable(
  unit: Unit,
  ctx: Ctx,
  userId: string,
  plan: SpendPlan,
): Promise<Extract<Outcome, { status: 'rejected' }> | null> {
  const have = await unit.ledger.balance(spendable(userId));
  if (compare(have, plan.spendablePart) < 0) {
    return rejected('INSUFFICIENT_FUNDS', {
      account: spendable(userId),
      required: encodeAmount(plan.spendablePart),
      available: encodeAmount(have),
    });
  }
  // The same maturity gate spend runs: the spendable-funded part must be covered by cleared
  // funds, so a first-period charge cannot draw on card credits still inside the chargeback
  // window. Promo draws first and is not gated.
  const cleared = await maturedAtLeast(
    unit.ledger,
    spendable(userId),
    ctx.clock.now(),
    { config: ctx.config, amount: plan.spendablePart, live: have },
  );
  if (!cleared) {
    const availableAt = await maturedAvailableAt(
      unit.ledger,
      spendable(userId),
      ctx.clock.now(),
      { config: ctx.config, amount: plan.spendablePart, live: have },
    );
    return rejected('FUNDS_IMMATURE', {
      account: spendable(userId),
      required: encodeAmount(plan.spendablePart),
      ...(availableAt === null ? {} : { availableAt }),
    });
  }
  return null;
}

// --- Posting ----------------------------------------------------------------------

async function postCharge(
  operation: Extract<Operation, { kind: 'subscribe' }>,
  plan: SpendPlan,
  unit: Unit,
  ctx: Ctx,
): Promise<Transaction> {
  const legs: Leg[] = [];
  appendPromoLegs(legs, operation, plan.promoPart);
  appendSpendableLegs(legs, operation, plan.spendablePart, ctx);

  return postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: {
      kind: 'subscribe',
      sku: operation.sku,
      sellerId: operation.sellerId,
    },
  });
}

// Promo credits are not the buyer's money, so the seller is paid real earnings from REVENUE while
// PROMO_FLOAT offsets the drawn-down grant. No fee on the promo part, as in `spend`.
function appendPromoLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'subscribe' }>,
  promoPart: Amount,
): void {
  if (promoPart.minor === 0n) {
    return;
  }
  legs.push(debit(promo(operation.userId), promoPart));
  legs.push(credit(SYSTEM.PROMO_FLOAT, promoPart));
  legs.push(debit(SYSTEM.REVENUE, promoPart));
  legs.push(credit(earned(operation.sellerId), promoPart));
}

function appendSpendableLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'subscribe' }>,
  spendablePart: Amount,
  ctx: Ctx,
): void {
  if (spendablePart.minor === 0n) {
    return;
  }
  // `feeForPrice` (pricing.ts) owns the fee rounding rule. Spend, first-month subscribe, and
  // renewal all call it, so they all round identically.
  const feeMinor = feeForPrice(spendablePart.minor, ctx.config.platformFeeBps);
  const netMinor = spendablePart.minor - feeMinor;
  legs.push(debit(spendable(operation.userId), spendablePart));
  legs.push(credit(earned(operation.sellerId), toAmount('CREDIT', netMinor)));
  legs.push(credit(SYSTEM.REVENUE, toAmount('CREDIT', feeMinor)));
}

// --- The subscription record ------------------------------------------------------

async function openSubscription(
  operation: Extract<Operation, { kind: 'subscribe' }>,
  transaction: Transaction,
  unit: Unit,
  ctx: Ctx,
): Promise<string> {
  const now = transaction.postedAt;
  const subscription: Subscription = {
    id: ctx.ids.next('sub'),
    userId: operation.userId,
    sellerId: operation.sellerId,
    sku: operation.sku,
    price: operation.price,
    periodMs: operation.periodMs,
    state: 'ACTIVE',
    period: 1,
    attempts: 0,
    nextDueAt: now + operation.periodMs,
    updatedAt: now,
  };
  await unit.subscriptions.open(subscription);
  return subscription.id;
}
