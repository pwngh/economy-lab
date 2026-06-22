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

import { ERROR_CODES, fault, rejected } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { compare, encodeAmount, toAmount } from '#src/money.ts';
import {
  SYSTEM,
  earned,
  isWalletAccount,
  ownerOf,
  promo,
  spendable,
} from '#src/accounts.ts';
import { maturedBalance } from '#src/maturity.ts';
import { feeForPrice } from '#src/pricing.ts';

import type { Amount } from '#src/money.ts';
import type {
  Ctx,
  Operation,
  Outcome,
  Recipient,
  Transaction,
} from '#src/contract.ts';
import type { Leg, Sale, Unit } from '#src/ports.ts';

// How a buyer's payment splits across their two balances. The price is drawn from the
// promo (marketing-grant) balance first, then the rest from the spendable balance.
type SpendPlan = { promoPart: Amount; spendablePart: Amount };

/**
 * Run a marketplace purchase: charge the buyer and pay the sellers, as one balanced
 * ledger posting.
 *
 * The buyer pays first from their promo (marketing-grant) balance, then from their
 * spendable balance. Each part is recorded as its own set of debit/credit lines, the
 * whole thing is appended as one transaction, a summary of the sale is saved under its
 * `orderId` so a later refund can reverse exactly what posted, and the SKU entitlement is
 * granted in the same transaction so paying always confers ownership. The entitlement goes
 * to the buyer, or — when the request carries a `giftTo` recipient — to that recipient: a
 * gift is an ordinary purchase the buyer pays for and the recipient receives (VRChat's
 * `isGift` model), not a wallet-to-wallet transfer.
 *
 * The `orderId` is unique per purchase: if a Sale already exists for it (a second request
 * reusing the same `orderId` under a different idempotency key), the spend is refused with
 * `DUPLICATE_ORDER` so the buyer is never double-charged for one order.
 *
 * By the time this runs, the surrounding middleware has already authorized the buyer,
 * handled retry-deduplication, checked the buyer can afford it, run the risk check, and
 * locked the affected accounts. So this function only needs to validate its own inputs
 * and post. A price that is not positive CREDIT, or recipient shares that do not add up
 * correctly, is a malformed request and is thrown as a fault, not returned as a refusal.
 *
 * @example
 *   let outcome = await spend(
 *     { kind: 'spend', idempotencyKey: 'idem_0', actor: { kind: 'user', userId: 'usr_buyer' },
 *       orderId: 'ord_1', buyerId: 'usr_buyer', sku: 'wrld_pass', price: toAmount('CREDIT', 400n),
 *       recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }] },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; the buyer's promo balance was drawn first, then spendable.
 */
export async function spend(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'spend') {
    throw kindMismatch(operation);
  }
  assertSpendShape(operation);
  let price = positiveCredit(operation.price, 'spend.price');
  assertShares(operation);
  assertNoSelfDealing(operation);
  let recipientId = entitlementRecipient(operation);

  // Refuse a second purchase that reuses an orderId already on file.
  //
  // The request carries an idempotency key (the value that makes a retried request run at most
  // once) and the pipeline uses it to drop an exact retry of the SAME request. But two DIFFERENT
  // requests can carry the same orderId under different idempotency keys; both would pass the
  // retry check and both would post, charging the buyer twice. And because a refund finds a sale
  // by its orderId, only the last-written sale's debit and credit lines would be reversible,
  // stranding the first charge. spend runs while the affected accounts are locked, so reading the
  // stored sale here cannot race another writer: if one already exists for this orderId, return a
  // normal business rejection (not a thrown fault — the same shape as FUNDS_IMMATURE below) so a
  // second debit is never posted.
  let existing = await unit.sales.get(operation.orderId);
  if (existing !== null) {
    return rejected('DUPLICATE_ORDER', { orderId: operation.orderId });
  }

  let promoBalance = await unit.ledger.balance(promo(operation.buyerId));
  let plan = planSpend(price, promoBalance);

  // Make sure the spendable-funded part is covered by funds that have finished clearing.
  //
  // Promo credits are drawn first and are spendable immediately, so only the part of the price
  // paid from the buyer's spendable balance has to come from cleared funds. Some spendable
  // credit may still be inside a settlement wait (a holding period before it can be spent). The
  // pipeline's earlier affordability check looks at the raw balance and so can pass even when part
  // of it has not cleared; this stricter check looks only at the cleared (matured) amount and
  // turns the purchase down with FUNDS_IMMATURE if the spendable part would dip into funds that
  // have not yet cleared. Like INSUFFICIENT_FUNDS, this is returned as a normal rejection rather
  // than thrown as a fault.
  let matured = await maturedBalance(
    unit.ledger,
    spendable(operation.buyerId),
    ctx.clock.now(),
    {
      config: ctx.config,
    },
  );
  if (compare(matured, plan.spendablePart) < 0) {
    return rejected('FUNDS_IMMATURE', {
      account: spendable(operation.buyerId),
      required: encodeAmount(plan.spendablePart),
      available: encodeAmount(matured),
    });
  }

  let legs = buildSpendLegs(operation, plan, ctx);

  // Record an age-restricted flag on the posting's metadata when the item is age-restricted.
  // This ledger does NOT block the purchase on age; checking the buyer's identity and age is the
  // job of the external payments/identity provider, not this code. Recording the flag on the
  // posting (which can never be edited after it is written) leaves an audit trail a later review
  // can rely on, without needing a new interface or store. The flag is only added when true, so an
  // ordinary purchase keeps its metadata minimal.
  let meta: Record<string, unknown> = {
    kind: 'spend',
    orderId: operation.orderId,
  };
  if (operation.ageRestricted) {
    meta.ageRestricted = true;
  }
  // Record the gift on the posting's metadata (which can never be edited after it is written),
  // matching VRChat's `isGift` flag, so an audit can see the buyer paid for someone else. Only
  // added for a real gift (recipient differs from the buyer), so an ordinary purchase stays clean.
  if (recipientId !== operation.buyerId) {
    meta.isGift = true;
    meta.giftTo = recipientId;
  }

  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta,
  });
  await unit.sales.put(
    saleOf(operation, plan, transaction, ctx.config.platformFeeBps),
  );

  // Give the recipient ownership of the item in the SAME transaction as the charge, so paying
  // always confers ownership and a charge that gets rolled back grants nothing. For an ordinary
  // purchase the recipient is the buyer; for a gift it is `giftTo`, so the buyer pays but the gift
  // recipient owns the item. The grant is tagged with this order so a later audit or refund can
  // trace the ownership record back to its sale. The store's grant writes (or overwrites) the
  // ownership row and clears any prior revoked mark on it, so re-buying an item after a refund (a
  // refund marks the old ownership revoked) makes ownership active again instead of leaving a
  // stale revoked row behind.
  await unit.entitlements.grant(recipientId, operation.sku, {
    source: 'sale:' + operation.orderId,
  });

  return { status: 'committed', transaction };
}

// Decide how much of the price comes from each balance: take as much as possible from
// the promo balance first (but never more than the price), and charge the remainder to
// the spendable balance. The middleware's earlier affordability check uses this same
// rule, so the up-front check and the actual posting always agree on the split.
function planSpend(price: Amount, promoBalance: Amount): SpendPlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount(price.currency, promoMinor),
    spendablePart: toAmount(price.currency, price.minor - promoMinor),
  };
}

// Build all the debit/credit lines for the posting: one set for the promo-funded part,
// one set for the spendable-funded part. Each set balances on its own (its debits and
// credits add up to zero), so the whole posting balances too.
function buildSpendLegs(
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
  ctx: Ctx,
): Leg[] {
  let legs: Leg[] = [];
  appendPromoLegs(legs, operation, plan);
  appendSpendableLegs(legs, operation, plan, ctx);
  return legs;
}

// The lines for the promo-funded part of the price. Two things happen, each as its own
// balanced pair:
//   1. Spend down the buyer's promo grant: debit the buyer's promo account, credit the
//      house PROMO_FLOAT account that offsets it.
//   2. Pay the sellers for real, out of platform revenue: debit the house REVENUE
//      account, credit each seller's earned balance.
// Because a promo grant isn't real money the buyer paid, the sellers are funded from
// REVENUE rather than from the buyer. This funding pair is separate from the price the
// buyer owes, so it never enters the check that the buyer's outflow equals the price.
// When seller shares don't divide evenly, the leftover (promoPart minus what was paid
// out) is simply not debited from REVENUE, so the house keeps it.
function appendPromoLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
): void {
  if (plan.promoPart.minor === 0n) {
    return;
  }
  legs.push(debit(promo(operation.buyerId), plan.promoPart));
  legs.push(credit(SYSTEM.PROMO_FLOAT, plan.promoPart));

  let distributed = distributeEarned(
    legs,
    plan.promoPart,
    operation.recipients ?? [],
  );
  legs.push(debit(SYSTEM.REVENUE, distributed));
}

// The lines for the spendable-funded part of the price: debit the buyer's spendable
// balance for that part, then add the credit lines from the injected fee policy. The
// fee policy splits the part across the sellers' earned balances and the house REVENUE
// account (which keeps the platform fee plus any rounding leftover), so this part of
// the price is fully accounted for down to the last minor unit.
function appendSpendableLegs(
  legs: Leg[],
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
  ctx: Ctx,
): void {
  if (plan.spendablePart.minor === 0n) {
    return;
  }
  legs.push(debit(spendable(operation.buyerId), plan.spendablePart));
  for (let leg of ctx.pricing({
    price: plan.spendablePart,
    recipients: operation.recipients ?? [],
    feeBps: ctx.config.platformFeeBps,
    buyerId: operation.buyerId,
    sku: operation.sku,
  })) {
    legs.push(leg);
  }
}

// Credit each seller's earned balance with its share of `amount`, rounding each share
// down, and return the total actually paid out. The leftover (amount minus the paid-out
// total) is the caller's to handle: the caller debits REVENUE by only this returned
// total, so the unpaid leftover stays with the house and the promo funding pair still
// balances.
function distributeEarned(
  legs: Leg[],
  amount: Amount,
  recipients: ReadonlyArray<Recipient>,
): Amount {
  let distributed = 0n;
  for (let recipient of recipients) {
    let share = (amount.minor * BigInt(recipient.shareBps)) / 10_000n;
    distributed += share;
    // A share that rounds down to zero credits the seller nothing, so add no leg for it. A
    // zero-amount leg is a no-op the ledger drops anyway; skipping it keeps the entry clean.
    if (share > 0n) {
      legs.push(
        credit(earned(recipient.sellerId), toAmount(amount.currency, share)),
      );
    }
  }
  return toAmount(amount.currency, distributed);
}

// Build the sale summary to save, keyed by `orderId` (a different key from the idempotency key
// used for retry-deduplication) so a later refund can look it up and reverse exactly these debit
// and credit lines. The recorded fee is the platform's cut of the spendable-funded part of the
// price — the slice the platform's REVENUE account keeps off that part.
//
// The fee comes from `feeForPrice`, the SAME helper the pricing policy uses when it posts the
// REVENUE credit, so the fee recorded here always equals the fee actually credited to REVENUE.
// Computing the fee independently here (as the old code did) understated it whenever the exact
// cut was not a whole credit, because posting rounds the fee UP to a whole credit. The
// promo-funded part is charged no fee, so the recorded fee covers only the spendable part.
function saleOf(
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
  transaction: Transaction,
  feeBps: number,
): Sale {
  let feeMinor = feeForPrice(plan.spendablePart.minor, feeBps);
  return {
    orderId: operation.orderId,
    buyerId: operation.buyerId,
    // Whoever received the item — the buyer, or the gift recipient — so a refund revokes the right
    // user's ownership. `giftTo` was already validated non-blank in the handler.
    recipientId: operation.giftTo ?? operation.buyerId,
    sku: operation.sku,
    price: operation.price,
    fee: toAmount(operation.price.currency, feeMinor),
    legs: transaction.legs.map((leg) => ({ ...leg })),
    txnId: transaction.id,
    postedAt: transaction.postedAt,
  };
}

// Who should receive the purchased SKU: the gift recipient (`giftTo`) if this is a gift,
// otherwise the buyer. A `giftTo` that is present but blank is a malformed request — it would
// grant ownership to an empty user id — so it is thrown as a fault, the same way a bad price is.
function entitlementRecipient(
  operation: Extract<Operation, { kind: 'spend' }>,
): string {
  if (operation.giftTo === undefined) {
    return operation.buyerId;
  }
  if (operation.giftTo.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'spend.giftTo must be a non-empty user id.',
      { detail: { orderId: operation.orderId } },
    );
  }
  return operation.giftTo;
}

// Require the price to be a positive amount in CREDIT. A spend is always priced in
// CREDIT, so a non-CREDIT or non-positive price is a malformed request, thrown as a
// fault rather than returned as an ordinary refusal.
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

// Validate the structured shape of the spend request — the fields the central guard cannot know
// about. These are programming/client errors (a well-formed client never sends them), so each is
// thrown as a fault, not returned as an ordinary refusal:
//   - `sku` must name an item to buy; a blank one would grant ownership of nothing.
//   - `orderId` must be present; it is the unique key for duplicate-order protection (the
//     DUPLICATE_ORDER guard reads the stored Sale by it), and a blank one collapses that — two
//     different purchases sharing a blank order id would both look like one order.
//   - No two recipients may name the same `sellerId`: a duplicate would split the same seller's
//     cut across two earned-credit lines under one id, double-counting them in the share math.
//   - No recipient may be a house/system account. Recipients are credited to their EARNED
//     (cash-outable) balance; only a real user wallet may receive that. `earned(sellerId)` must
//     therefore be a user wallet account (NOT a `vrchat:`-prefixed house account), and its owner
//     must be non-blank. (Self-dealing and share-bounds are checked separately and left intact.)
function assertSpendShape(
  operation: Extract<Operation, { kind: 'spend' }>,
): void {
  if (typeof operation.sku !== 'string' || operation.sku.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'spend.sku must be a non-empty string.',
      { detail: { kind: operation.kind, orderId: operation.orderId } },
    );
  }
  if (
    typeof operation.orderId !== 'string' ||
    operation.orderId.trim() === ''
  ) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'spend.orderId must be a non-empty string.',
      { detail: { kind: operation.kind } },
    );
  }

  let seen = new Set<string>();
  for (let recipient of operation.recipients ?? []) {
    if (seen.has(recipient.sellerId)) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'spend.recipients may not name the same sellerId twice.',
        {
          detail: {
            kind: operation.kind,
            orderId: operation.orderId,
            sellerId: recipient.sellerId,
          },
        },
      );
    }
    seen.add(recipient.sellerId);

    // A recipient is paid into its EARNED (cash-outable) balance, so its sellerId must resolve to a
    // real user wallet account. A house/system account (e.g. `vrchat:revenue`) is not a wallet
    // owner; routing a sale's earnings there would credit a platform account as if it were a seller.
    let account = earned(recipient.sellerId);
    if (!isWalletAccount(account) || ownerOf(account).trim() === '') {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'spend.recipients sellerId must be a user wallet, not a house account.',
        {
          detail: {
            kind: operation.kind,
            orderId: operation.orderId,
            sellerId: recipient.sellerId,
          },
        },
      );
    }
  }
}

// Require the recipient shares to add up to exactly 10000 basis points (100%), and each
// individual share to be a sane fraction of the net. An empty recipient list is allowed and
// means the platform keeps the whole net (REVENUE takes everything). Any other total is a
// malformed request, caught here so a miswired split can never silently leave part of the
// price stuck with nobody.
//
// The sum check alone is not enough: shares like [-5000, 15000] still sum to 10000, but a
// negative share would credit a seller a negative amount (a hidden debit) and a >100% share
// would try to pay out more of the part than exists. Each share must therefore be strictly
// positive and at most the whole 10000 bps on its own, so a single recipient can never be
// handed more than the full net and no recipient can be assigned a negative cut.
function assertShares(operation: Extract<Operation, { kind: 'spend' }>): void {
  let recipients = operation.recipients ?? [];
  if (recipients.length === 0) {
    return;
  }
  for (let recipient of recipients) {
    if (recipient.shareBps <= 0 || recipient.shareBps > 10_000) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'each recipient share must be > 0 and <= 10000 basis points.',
        {
          detail: {
            kind: operation.kind,
            sellerId: recipient.sellerId,
            shareBps: recipient.shareBps,
          },
        },
      );
    }
  }
  let total = recipients.reduce(
    (sum, recipient) => sum + recipient.shareBps,
    0,
  );
  if (total !== 10_000) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'recipient shares must sum to 10000.',
      { detail: { kind: operation.kind, total } },
    );
  }
}

// Refuse a spend in which the buyer names themselves as a sale recipient. A spend pays each
// recipient's earned (cash-outable) balance out of platform REVENUE for the promo-funded part
// and out of the buyer's payment for the spendable part. If the buyer is also a recipient, the
// buyer converts their own non-cashable spendable/promo credit into cash-outable EARNED credit
// — laundering grant/top-up balance into withdrawable money funded by the house. The buyer and
// the seller must always be different parties, so this is a malformed request thrown as a fault.
function assertNoSelfDealing(
  operation: Extract<Operation, { kind: 'spend' }>,
): void {
  for (let recipient of operation.recipients ?? []) {
    if (recipient.sellerId === operation.buyerId) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'a spend recipient may not be the buyer (self-dealing).',
        {
          detail: { kind: operation.kind, buyerId: operation.buyerId },
        },
      );
    }
  }
}

// The middleware routes each request to the handler for its `kind`, so this handler
// being called with anything other than a spend is a wiring bug. Throw a loud fault
// instead of silently mishandling the request.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
