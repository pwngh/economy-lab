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

// The allowed price range for a subscription: 100 to 10,000 credits per month,
// inclusive. The numbers below are in minor units (1 credit = 100 minor units), so
// 10,000 minor = 100 credits and 1,000,000 minor = 10,000 credits. A price outside
// this range is treated as a malformed request.
let MIN_PRICE_MINOR = 10_000n; // 100.00 credits
let MAX_PRICE_MINOR = 1_000_000n; // 10,000.00 credits

// The longest billing period we'll accept, in milliseconds: ten 365-day years. A period this
// long is almost certainly garbage off the wire (a bad unit conversion, an overflow, or seconds
// passed where milliseconds were expected); anything beyond it is treated as a malformed request
// rather than a real subscription. The ceiling also stays far below Number.MAX_SAFE_INTEGER, so
// arithmetic on it (e.g. `postedAt + periodMs`) can't silently lose precision.
let MAX_PERIOD_MS = 10 * 365 * 24 * 60 * 60_000; // 315,360,000,000 ms

// How the first-month price is split across the buyer's two balances: `promoPart` is paid
// from their promo grant, `spendablePart` from the real money they topped up. Promo is
// used first, then spendable covers the rest.
type ChargePlan = { promoPart: Amount; spendablePart: Amount };

/**
 * Charge the first month of a subscription and create its record. Checks the price is in
 * the allowed range, confirms the buyer has enough spendable money, posts the charge (the
 * seller's earnings go up, the platform takes its fee), then saves the `Subscription` that
 * the background worker will renew each later month.
 *
 * Returns a `committed` outcome on success, or a `rejected('INSUFFICIENT_FUNDS')` outcome
 * when the buyer's spendable balance can't cover its share of the price.
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

  // Refuse to open a second ACTIVE subscription to the same (userId, sku, sellerId): the buyer
  // already pays for this seller's sku each period, so a second one would double-bill them. This
  // is an ordinary business "no" — return a rejected outcome and post nothing, not a thrown fault.
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

  // Give the buyer ownership of the SKU inside the same database transaction (`unit`) that
  // posted the first-month charge. Doing both in one transaction guarantees the two stay in
  // lockstep: a buyer who paid always ends up owning the SKU, and if the charge is rolled
  // back the grant is rolled back with it, so a failed charge grants nothing. The grant
  // expires at the end of the month just billed; on each later renewal the background worker
  // extends the grant to the new period end, and revokes it if the subscription lapses — that
  // worker logic lives in a different file. `source` records which subscription this ownership
  // came from, for auditing. If this buyer had a lapsed subscription to the same SKU, the
  // earlier grant row was marked revoked rather than deleted; this grant clears that revoked
  // mark and reactivates ownership instead of leaving the stale revoked row in place.
  await unit.entitlements.grant(operation.userId, operation.sku, {
    expiresAt: transaction.postedAt + operation.periodMs,
    source: 'subscription:' + subscriptionId,
  });

  return { status: 'committed', transaction };
}

// --- Validation -------------------------------------------------------------------

// A buyer may not subscribe to themselves. If `userId` and `sellerId` are the same person, the
// charge would draw the buyer's own non-cashable balances (promo, and spendable that can't be
// paid out) and credit them straight back as EARNED — which IS cash-outable, and is funded by the
// platform's own REVENUE. That turns gift/promo grants into withdrawable cash and drains the
// treasury, so it's a malformed request, not an ordinary business "no": fail loudly with a fault.
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

// Guard the op-specific structured fields the central validateOperation can't reason about:
// the billing period and the SKU. `periodMs` arrives as a plain number off the wire, so it may
// be NaN, Infinity, a fraction, zero, negative, or absurdly large — any of which would corrupt
// the subscription's billing math (e.g. a NaN period end) — so require a finite positive whole
// number within the allowed ceiling. `sku` must be a real, non-blank string, since a blank one
// would key an entitlement grant and ledger metadata to nothing. Each is a programming or wiring
// error, not an ordinary business "no", so it throws a fault rather than returning a refusal.
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

// Check the price and return it unchanged so it can be used inline. A price in the wrong
// currency or outside the allowed range is a programming or wiring error, not a normal
// "no" answer, so it throws a fault here rather than returning a declined result.
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

// Decide how the price is split between the buyer's promo and spendable balances. Use as
// much promo as is available (but never more than the price), and charge the rest to
// spendable. This is the same promo-first rule the marketplace `spend` operation uses.
function planCharge(price: Amount, promoBalance: Amount): ChargePlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount('CREDIT', promoMinor),
    spendablePart: toAmount('CREDIT', price.minor - promoMinor),
  };
}

// Confirm the buyer has enough spendable money to cover the spendable share of the price.
// The middleware's up-front funds check only runs for `spend`, so subscribe has to do its
// own check here. If the balance is short, return an INSUFFICIENT_FUNDS rejection (a normal
// business "no", returned as data); otherwise return null and let the posting proceed.
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

// Post the first-month charge as one balanced ledger entry, made up of debit and credit
// lines (legs) that add up to zero. The promo-funded part and the spendable-funded part
// each contribute their own legs.
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

// Build the ledger lines for the part of the price paid from the buyer's promo grant.
// Promo credits aren't real money, so two things happen. First, the promo grant is drawn
// down: debit the buyer's promo account and credit PROMO_FLOAT, the account that offsets
// outstanding promo grants. Second, the seller is paid real earnings from the platform's
// own revenue: debit REVENUE and credit the seller's earned account. The whole promo
// amount goes to the seller — the fee is charged only on the spendable (real-money) part,
// the same way `spend` works.
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

// Build the ledger lines for the part of the price paid from the buyer's spendable (real)
// money. Debit the buyer's spendable account for the full spendable part, credit the seller
// the amount left after the platform fee, and credit the platform's REVENUE the fee itself.
// The seller's net plus the fee equal the spendable part exactly, so nothing is lost.
function appendSpendableLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'subscribe' }>,
  spendablePart: Amount,
  ctx: Ctx,
): void {
  if (spendablePart.minor === 0n) {
    return;
  }
  // `feeForPrice` (in pricing.ts) is the one place the transaction fee is computed: it takes the
  // exact basis-point fee and rounds it UP to a whole credit (VRChat's documented rule), capped at
  // the charge. Spend, first-month subscribe, and renewal all call it, so they round identically.
  let feeMinor = feeForPrice(spendablePart.minor, ctx.config.platformFeeBps);
  let netMinor = spendablePart.minor - feeMinor;
  legs.push(debit(spendable(operation.userId), spendablePart));
  legs.push(credit(earned(operation.sellerId), toAmount('CREDIT', netMinor)));
  legs.push(credit(SYSTEM.REVENUE, toAmount('CREDIT', feeMinor)));
}

// --- The subscription record ------------------------------------------------------

// Save the subscription record so the background worker can keep renewing it. It starts
// ACTIVE with period 1, because month one was just billed; the next charge falls due one
// period later. From then on the worker bills each period — this handler only ever charges
// the first month.
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
  // Hand the id back so the caller can record it on the entitlement grant's `source` field,
  // linking the buyer's SKU ownership to the subscription that created it.
  return subscription.id;
}

// This handler should only ever be called with a `subscribe` operation. Being handed any
// other kind means the operations were wired up wrong, so fail loudly with a fault rather
// than risk posting the wrong money.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
