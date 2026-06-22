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
import { credit, debit, postEntry } from '#src/ledger.ts';
import { compare, encodeAmount, toAmount } from '#src/money.ts';
import { promo, spendable, earned, SYSTEM } from '#src/accounts.ts';
import { feeForPrice } from '#src/pricing.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Leg, Subscription, Unit } from '#src/ports.ts';

// Allowed subscription price: 100 to 10,000 credits/month inclusive, in minor units
// (1 credit = 100 minor). Outside this range is a malformed request.
let MIN_PRICE_MINOR = 10_000n; // 100.00 credits
let MAX_PRICE_MINOR = 1_000_000n; // 10,000.00 credits

// Longest accepted billing period, in ms: ten 365-day years. Anything longer is treated as
// garbage off the wire (bad unit conversion, overflow, seconds-for-ms) and rejected as malformed.
// Also stays well below Number.MAX_SAFE_INTEGER so `postedAt + periodMs` can't lose precision.
let MAX_PERIOD_MS = 10 * 365 * 24 * 60 * 60_000; // 315,360,000,000 ms

// Split of the first-month price across the buyer's balances: `promoPart` from their promo
// grant, `spendablePart` from topped-up real money. Promo first, spendable covers the rest.
type ChargePlan = { promoPart: Amount; spendablePart: Amount };

/**
 * Charge the first month of a subscription and create its record. Validates the price range,
 * confirms enough spendable money, posts the charge (seller earns, platform takes its fee),
 * then saves the `Subscription` the background worker renews each later month.
 *
 * Returns a `committed` outcome on success, or `rejected('INSUFFICIENT_FUNDS')` when the
 * buyer's spendable balance can't cover its share.
 *
 * @example
 *   // Inside an open transaction (`unit`), bill month one and open the record:
 *   let outcome = await handleSubscribe(
 *     { kind: 'subscribe', idempotencyKey: 'idem_1', actor: { kind: 'user', userId: 'usr_a' },
 *       userId: 'usr_a', sellerId: 'usr_s', sku: 'club_pass',
 *       price: toAmount('CREDIT', 50_000n), periodMs: 2_592_000_000 },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; the seller earned the net, the platform took the fee.
 */
export async function handleSubscribe(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'subscribe') {
    throw kindMismatch(operation);
  }
  rejectSelfSubscription(operation);
  validateFields(operation);
  let price = validatedPrice(operation.price);

  // Refuse a second ACTIVE subscription to the same (userId, sku, sellerId); a second one would
  // double-bill. Ordinary business "no": return a rejected outcome and post nothing, not a fault.
  let existing = await unit.subscriptions.activeFor(
    operation.userId,
    operation.sku,
    operation.sellerId,
  );
  if (existing !== null) {
    return rejected('ALREADY_SUBSCRIBED', {
      detail: {
        userId: operation.userId,
        sku: operation.sku,
        sellerId: operation.sellerId,
        subscriptionId: existing.id,
      },
    });
  }

  let promoBalance = await unit.ledger.balance(promo(operation.userId));
  let plan = planCharge(price, promoBalance);

  let shortfall = await screenSpendable(unit, operation.userId, plan);
  if (shortfall) {
    return shortfall;
  }

  let transaction = await postCharge(operation, plan, unit, ctx);
  let subscriptionId = await openSubscription(
    operation,
    transaction,
    unit,
    ctx,
  );

  // Grant SKU ownership in the same transaction (`unit`) that posted the first-month charge, so
  // the two stay in lockstep: a paying buyer always owns the SKU, and a rolled-back charge rolls
  // back the grant too. The grant expires at the end of the month just billed; later renewals
  // extend it and a lapse revokes it (worker logic in a different file). `source` records which
  // subscription this ownership came from, for auditing. If this buyer had a lapsed subscription
  // to the same SKU, the old grant row was marked revoked rather than deleted; this clears that
  // mark and reactivates ownership instead of leaving the stale row.
  await unit.entitlements.grant(operation.userId, operation.sku, {
    expiresAt: transaction.postedAt + operation.periodMs,
    source: 'subscription:' + subscriptionId,
  });

  return { status: 'committed', transaction };
}

// --- Validation -------------------------------------------------------------------

// A buyer may not subscribe to themselves. If `userId` === `sellerId`, the charge draws the
// buyer's non-cashable balances (promo, non-payable spendable) and credits them back as EARNED,
// which is cash-outable and funded by platform REVENUE. That turns gift/promo grants into
// withdrawable cash and drains the treasury, so it's malformed, not a business "no": throw a fault.
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

// Guard the op-specific fields central validateOperation can't reason about: period and SKU.
// `periodMs` arrives as a plain number, so it may be NaN, Infinity, fractional, zero, negative,
// or absurdly large (any of which corrupts billing math, e.g. a NaN period end); require a
// finite positive integer within the ceiling. `sku` must be non-blank, since a blank one would
// key an entitlement grant and ledger metadata to nothing. Both are wiring errors: throw a fault.
function validateFields(
  operation: Extract<Operation, { kind: 'subscribe' }>,
): void {
  let periodMs = operation.periodMs;
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

// Validate the price and return it unchanged for inline use. Wrong currency or out-of-range
// is a wiring error, not a business "no", so throw a fault rather than return a decline.
function validatedPrice(price: Amount): Amount {
  if (price.currency !== 'CREDIT') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.price must be CREDIT.',
      { detail: { amount: encodeAmount(price) } },
    );
  }
  if (price.minor < MIN_PRICE_MINOR || price.minor > MAX_PRICE_MINOR) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'subscribe.price is outside the 100–10000 credit/month band.',
      {
        detail: {
          amount: encodeAmount(price),
          min: encodeAmount(toAmount('CREDIT', MIN_PRICE_MINOR)),
          max: encodeAmount(toAmount('CREDIT', MAX_PRICE_MINOR)),
        },
      },
    );
  }
  return price;
}

// --- The funds plan ---------------------------------------------------------------

// Split the price between promo and spendable: use as much promo as available (capped at the
// price), charge the rest to spendable. Same promo-first rule as the marketplace `spend` op.
function planCharge(price: Amount, promoBalance: Amount): ChargePlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount('CREDIT', promoMinor),
    spendablePart: toAmount('CREDIT', price.minor - promoMinor),
  };
}

// Confirm enough spendable money for the spendable share. The middleware's up-front funds check
// only runs for `spend`, so subscribe checks here. Short balance returns an INSUFFICIENT_FUNDS
// rejection (business "no", as data); otherwise null and posting proceeds.
async function screenSpendable(
  unit: Unit,
  userId: string,
  plan: ChargePlan,
): Promise<Extract<Outcome, { status: 'rejected' }> | null> {
  let have = await unit.ledger.balance(spendable(userId));
  if (compare(have, plan.spendablePart) < 0) {
    return rejected('INSUFFICIENT_FUNDS', {
      account: spendable(userId),
      required: encodeAmount(plan.spendablePart),
      available: encodeAmount(have),
    });
  }
  return null;
}

// --- Posting ----------------------------------------------------------------------

// Post the first-month charge as one balanced ledger entry: debit/credit legs summing to zero.
// The promo-funded and spendable-funded parts each contribute their own legs.
async function postCharge(
  operation: Extract<Operation, { kind: 'subscribe' }>,
  plan: ChargePlan,
  unit: Unit,
  ctx: Ctx,
): Promise<Transaction> {
  let legs: Leg[] = [];
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

// Ledger lines for the promo-funded part. Promo credits aren't real money, so: (1) draw down
// the grant, debit the buyer's promo and credit PROMO_FLOAT (offsets outstanding promo grants);
// (2) pay the seller real earnings from platform revenue, debit REVENUE and credit the seller's
// earned. The whole promo amount goes to the seller; the fee applies only to the spendable
// (real-money) part, as in `spend`.
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

// Ledger lines for the spendable (real-money) part. Debit the buyer's spendable for the full
// part, credit the seller the amount after fee, credit REVENUE the fee. Net plus fee equal the
// spendable part exactly.
function appendSpendableLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'subscribe' }>,
  spendablePart: Amount,
  ctx: Ctx,
): void {
  if (spendablePart.minor === 0n) {
    return;
  }
  // `feeForPrice` (pricing.ts) is the one place the transaction fee is computed: exact basis-point
  // fee rounded up to a whole credit (VRChat's documented rule), capped at the charge. Spend,
  // first-month subscribe, and renewal all call it, so they round identically.
  let feeMinor = feeForPrice(spendablePart.minor, ctx.config.platformFeeBps);
  let netMinor = spendablePart.minor - feeMinor;
  legs.push(debit(spendable(operation.userId), spendablePart));
  legs.push(credit(earned(operation.sellerId), toAmount('CREDIT', netMinor)));
  legs.push(credit(SYSTEM.REVENUE, toAmount('CREDIT', feeMinor)));
}

// --- The subscription record ------------------------------------------------------

// Save the subscription record for the background worker to renew. Starts ACTIVE at period 1
// (month one was just billed); next charge falls due one period later. From then on the worker
// bills each period; this handler only ever charges the first month.
async function openSubscription(
  operation: Extract<Operation, { kind: 'subscribe' }>,
  transaction: Transaction,
  unit: Unit,
  ctx: Ctx,
): Promise<string> {
  let now = transaction.postedAt;
  let subscription: Subscription = {
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
  // Return the id so the caller can record it on the grant's `source`, linking SKU ownership
  // to the subscription that created it.
  return subscription.id;
}

// This handler only handles `subscribe` ops. Any other kind means the operations were wired
// up wrong, so throw a fault rather than risk posting the wrong money.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
