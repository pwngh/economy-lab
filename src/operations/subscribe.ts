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

// A subscription price must be 100 to 10,000 credits per month, inclusive, expressed in minor
// units (1 credit = 100 minor). A price outside this range is a malformed request.
let MIN_PRICE_MINOR = 10_000n; // 100.00 credits
let MAX_PRICE_MINOR = 1_000_000n; // 10,000.00 credits

// The longest accepted billing period is ten 365-day years, in milliseconds. A longer period is
// treated as garbage off the wire (a bad unit conversion, an overflow, or seconds used for ms)
// and rejected as malformed. This ceiling also stays well below Number.MAX_SAFE_INTEGER, so
// `postedAt + periodMs` cannot lose precision.
let MAX_PERIOD_MS = 10 * 365 * 24 * 60 * 60_000; // 315,360,000,000 ms

// Splits the first-month price across the buyer's two balances. `promoPart` is funded from their
// promo grant, and `spendablePart` is funded from topped-up real money. Promo is drawn first, and
// spendable covers the rest.
type ChargePlan = { promoPart: Amount; spendablePart: Amount };

/**
 * Charge the first month of a subscription and create its record. Validates the price range,
 * confirms enough spendable money, posts the charge (seller earns, platform takes its fee),
 * then saves the `Subscription` the background worker renews each later month.
 *
 * Returns a `committed` outcome on success, `rejected('ALREADY_SUBSCRIBED')` when an active
 * subscription to the same (userId, sku, sellerId) already exists, or
 * `rejected('INSUFFICIENT_FUNDS')` when the buyer's spendable balance can't cover its share.
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
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/subscribe/ Subscribe} for the first-month charge and renewal handoff.
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

  // Refuse a second ACTIVE subscription to the same (userId, sku, sellerId), because a second one
  // would double-bill. This is an ordinary business "no", so return a rejected outcome and post
  // nothing rather than throw a fault.
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

// Rejects a buyer who tries to subscribe to themselves. When `userId` equals `sellerId`, the
// charge draws the buyer's non-cashable balances (promo and non-payable spendable) and credits
// them back as EARNED, which is cash-outable and funded by platform REVENUE. That would turn
// gift and promo grants into withdrawable cash and drain the treasury, so this is malformed
// rather than a business "no". Throw a fault.
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

// Guards the two op-specific fields the central validateOperation cannot reason about: the period
// and the SKU. `periodMs` arrives as a plain number, so it may be NaN, Infinity, fractional, zero,
// negative, or absurdly large. Any of those corrupts the billing math (for example, a NaN period
// end), so require a finite positive integer within the ceiling. `sku` must be non-blank, because
// a blank one would key an entitlement grant and ledger metadata to nothing. Both are wiring
// errors, so throw a fault.
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

// Validates the price and returns it unchanged for inline use. A wrong currency or an
// out-of-range amount is a wiring error, not a business "no", so it throws a fault rather than
// returning a decline.
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

// Splits the price between promo and spendable. It uses as much promo as is available, capped at
// the price, and charges the rest to spendable. This is the same promo-first rule the marketplace
// `spend` op uses.
function planCharge(price: Amount, promoBalance: Amount): ChargePlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount('CREDIT', promoMinor),
    spendablePart: toAmount('CREDIT', price.minor - promoMinor),
  };
}

// Confirms the buyer has enough spendable money for the spendable share. The middleware's up-front
// funds check only runs for `spend`, so subscribe checks here. A short balance returns an
// INSUFFICIENT_FUNDS rejection, which is a business "no" carried as data. A sufficient balance
// returns null, and posting proceeds.
//
// This is a courtesy pre-check, not the enforcer. The database's per-user non-negative CHECK is
// what actually blocks an overdraft. This check exists only to return a kind INSUFFICIENT_FUNDS
// rejection before the engine would reject the entry.
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

// Posts the first-month charge as one balanced ledger entry whose debit and credit legs sum to
// zero. The promo-funded part and the spendable-funded part each contribute their own legs.
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

// Appends the ledger legs for the promo-funded part. Promo credits are not real money, so this
// takes two steps. First, it draws down the grant: it debits the buyer's promo and credits
// PROMO_FLOAT, the account that offsets outstanding promo grants. Second, it pays the seller real
// earnings from platform revenue: it debits REVENUE and credits the seller's earned. The whole
// promo amount goes to the seller, because the fee applies only to the spendable (real-money)
// part, as in `spend`.
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

// Appends the ledger legs for the spendable (real-money) part. It debits the buyer's spendable for
// the full part, credits the seller the amount after the fee, and credits REVENUE the fee. The net
// and the fee add up to the spendable part exactly.
function appendSpendableLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'subscribe' }>,
  spendablePart: Amount,
  ctx: Ctx,
): void {
  if (spendablePart.minor === 0n) {
    return;
  }
  // `feeForPrice` (pricing.ts) is the one place the transaction fee is computed. It takes the exact
  // basis-point fee, rounds it up to a whole credit (credits are the indivisible billing unit), and
  // caps it at the charge. Spend, first-month subscribe, and renewal all call it, so they all round
  // identically.
  let feeMinor = feeForPrice(spendablePart.minor, ctx.config.platformFeeBps);
  let netMinor = spendablePart.minor - feeMinor;
  legs.push(debit(spendable(operation.userId), spendablePart));
  legs.push(credit(earned(operation.sellerId), toAmount('CREDIT', netMinor)));
  legs.push(credit(SYSTEM.REVENUE, toAmount('CREDIT', feeMinor)));
}

// --- The subscription record ------------------------------------------------------

// Saves the subscription record for the background worker to renew. This handler only charges the
// first month, which was just billed. The worker bills every period after that.
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
