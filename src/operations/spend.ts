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
import { assertKind } from '#src/operations/guards.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { encodeAmount, requirePositiveCredit, toAmount } from '#src/money.ts';
import {
  SYSTEM,
  earned,
  isWalletAccount,
  ownerOf,
  promo,
  spendable,
} from '#src/accounts.ts';
import { maturedAtLeast } from '#src/maturity.ts';
import { revenueForSplit } from '#src/pricing.ts';

import type { Amount } from '#src/money.ts';
import type {
  Ctx,
  Operation,
  Outcome,
  Recipient,
  Transaction,
} from '#src/contract.ts';
import type { Leg, Sale, Unit } from '#src/ports.ts';

// How a payment splits across the buyer's two balances: promo (marketing-grant) first,
// remainder from spendable.
type SpendPlan = { promoPart: Amount; spendablePart: Amount };

/**
 * Run a marketplace purchase: charge the buyer and pay the sellers as one balanced
 * ledger posting.
 *
 * Buyer pays from promo (marketing-grant) balance first, then spendable; each part is its own
 * set of debit/credit lines in one transaction. A sale summary is saved under `orderId` so a
 * later refund can reverse exactly what posted, and the SKU entitlement is granted in the same
 * transaction so paying always confers ownership. Entitlement goes to the buyer, or to `giftTo`
 * when present: a gift is an ordinary purchase the buyer pays for and the recipient receives
 * (modelled as an `isGift` flag on the purchase), not a wallet-to-wallet transfer.
 *
 * `orderId` is unique per purchase. If a Sale already exists for it (a second request reusing
 * the same `orderId` under a different idempotency key), the spend is refused with
 * `DUPLICATE_ORDER` so the buyer is never double-charged for one order.
 *
 * Middleware has already authorized the buyer, deduplicated retries, checked affordability, run
 * the risk check, and locked the affected accounts, so this function only validates its own
 * inputs and posts. A non-positive or non-CREDIT price, or recipient shares that don't add up,
 * is a malformed request thrown as a fault, not a refusal.
 *
 * @example
 *   let outcome = await spend(
 *     { kind: 'spend', idempotencyKey: 'idem_0', actor: { kind: 'user', userId: 'usr_buyer' },
 *       orderId: 'ord_1', buyerId: 'usr_buyer', sku: 'wrld_pass', price: toAmount('CREDIT', 400n),
 *       recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }] },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; the buyer's promo balance was drawn first, then spendable.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/spend/ Spend} for the
 * purchase flow, balance draw order, and split accounting this handler posts.
 */
export async function spend(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'spend');
  assertSpendShape(operation);
  let price = requirePositiveCredit(operation.price, 'spend.price');
  assertShares(operation);
  assertNoSelfDealing(operation);
  let recipientId = entitlementRecipient(operation);

  // Refuse a second purchase that reuses an orderId already on file.
  //
  // The idempotency key drops exact retries, but two different requests can carry the same orderId
  // under different keys; both pass the retry check and post, charging the buyer twice. Since a
  // refund finds a sale by orderId, only the last-written sale's lines would be reversible,
  // stranding the first charge. spend runs with the affected accounts locked, so reading the stored
  // sale here can't race another writer. If one exists, return a business rejection (not a fault,
  // same shape as FUNDS_IMMATURE below) so no second debit posts.
  let existing = await unit.sales.get(operation.orderId);
  if (existing !== null) {
    return rejected('DUPLICATE_ORDER', { orderId: operation.orderId });
  }

  let promoBalance = await unit.ledger.balance(promo(operation.buyerId));
  let plan = planSpend(price, promoBalance);

  // Require the spendable-funded part to be covered by cleared (matured) funds. Promo draws first,
  // so only the spendable part is checked; the pipeline's affordability check sees the raw balance
  // and can pass on funds still in a settlement wait. Refuse with FUNDS_IMMATURE (a rejection, not a
  // fault, like INSUFFICIENT_FUNDS) rather than dip into uncleared funds.
  let cleared = await maturedAtLeast(
    unit.ledger,
    spendable(operation.buyerId),
    ctx.clock.now(),
    { config: ctx.config, amount: plan.spendablePart },
  );
  if (!cleared) {
    return rejected('FUNDS_IMMATURE', {
      account: spendable(operation.buyerId),
      required: encodeAmount(plan.spendablePart),
    });
  }

  let legs = buildSpendLegs(operation, plan, ctx);

  // Flag age-restricted items on the posting metadata. This ledger doesn't block on age; the
  // external payments/identity provider checks identity and age. Recording the flag on the
  // immutable posting leaves an audit trail without a new interface or store. Only added when true.
  let meta: Record<string, unknown> = {
    kind: 'spend',
    orderId: operation.orderId,
  };
  if (operation.ageRestricted) {
    meta.ageRestricted = true;
  }
  // Flag a gift on the immutable posting metadata (the `isGift` flag) so an audit can see
  // the buyer paid for someone else. Only added when the recipient differs from the buyer.
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

  // Grant the recipient ownership in the same transaction as the charge, so paying always confers
  // ownership and a rolled-back charge grants nothing. Recipient is the buyer for an ordinary
  // purchase, `giftTo` for a gift. Tagged with this order so an audit or refund can trace the
  // ownership record back to its sale. grant writes (or overwrites) the ownership row and clears
  // any prior revoked mark, so re-buying after a refund (which marks the old ownership revoked)
  // makes ownership active again instead of leaving a stale revoked row.
  await unit.entitlements.grant(recipientId, operation.sku, {
    source: 'sale:' + operation.orderId,
  });

  return { status: 'committed', transaction };
}

// Split the price across balances: take as much as possible from promo first (capped at the
// price), charge the remainder to spendable. The middleware's affordability check uses this same
// rule, so the up-front check and the posting agree on the split.
function planSpend(price: Amount, promoBalance: Amount): SpendPlan {
  let available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  let promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount(price.currency, promoMinor),
    spendablePart: toAmount(price.currency, price.minor - promoMinor),
  };
}

// Build the debit/credit lines: one set for the promo-funded part, one for the spendable-funded
// part. Each set balances on its own (debits and credits sum to zero), so the whole posting does.
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

// Lines for the promo-funded part, two balanced pairs:
//   1. Spend down the buyer's promo grant: debit the buyer's promo account, credit the house
//      PROMO_FLOAT account that offsets it.
//   2. Pay the sellers out of platform revenue: debit house REVENUE, credit each seller's earned
//      balance.
// A promo grant isn't real money the buyer paid, so the sellers are funded from REVENUE rather
// than the buyer. This funding pair is separate from the price the buyer owes, so it never enters
// the check that buyer outflow equals the price. When seller shares don't divide evenly, the
// leftover (promoPart minus what was paid out) is not debited from REVENUE, so the house keeps it.
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

// Lines for the spendable-funded part: debit the buyer's spendable balance for that part, then add
// the credit lines from the injected fee policy. The policy splits the part across the sellers'
// earned balances and house REVENUE (which keeps the platform fee plus any rounding leftover), so
// the part is fully accounted for to the last minor unit.
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

// Credit each seller's earned balance with its share of `amount`, rounding each share down, and
// return the total paid out. The caller debits REVENUE by only this returned total, so the
// rounding leftover stays with the house and the promo funding pair still balances.
function distributeEarned(
  legs: Leg[],
  amount: Amount,
  recipients: ReadonlyArray<Recipient>,
): Amount {
  let distributed = 0n;
  for (let recipient of recipients) {
    let share = (amount.minor * BigInt(recipient.shareBps)) / 10_000n;
    distributed += share;
    // A share that rounds down to zero adds no leg (a zero-amount leg is a no-op the ledger drops).
    if (share > 0n) {
      legs.push(
        credit(earned(recipient.sellerId), toAmount(amount.currency, share)),
      );
    }
  }
  return toAmount(amount.currency, distributed);
}

// Build the sale summary, keyed by `orderId` (distinct from the idempotency key used for
// retry-dedup) so a later refund can look it up and reverse exactly these lines. The recorded fee
// is the platform's cut of the spendable-funded part, the slice REVENUE keeps off that part.
//
// `revenueForSplit` is the same computation splitLegs uses for the REVENUE credit: the fee plus the
// residual left by rounding each seller's share down. The recorded fee therefore always equals what
// REVENUE actually kept, even on an uneven multi-seller split where that residual is non-zero.
// (Recording the bare `feeForPrice` understated it on those splits.) The promo-funded part is
// charged no fee, so the recorded fee covers only the spendable part.
function saleOf(
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
  transaction: Transaction,
  feeBps: number,
): Sale {
  let feeMinor = revenueForSplit(
    plan.spendablePart,
    operation.recipients ?? [],
    feeBps,
  );
  return {
    orderId: operation.orderId,
    buyerId: operation.buyerId,
    // Whoever received the item (buyer or gift recipient), so a refund revokes the right user's
    // ownership. `giftTo` was already validated non-blank in the handler.
    recipientId: operation.giftTo ?? operation.buyerId,
    sku: operation.sku,
    price: operation.price,
    fee: toAmount(operation.price.currency, feeMinor),
    legs: transaction.legs.map((leg) => ({ ...leg })),
    txnId: transaction.id,
    postedAt: transaction.postedAt,
  };
}

// Who receives the purchased SKU: `giftTo` if this is a gift, otherwise the buyer. A `giftTo` that
// is present but blank would grant ownership to an empty user id, so it's a malformed request
// thrown as a fault, like a bad price.
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

// Validate the structured shape of the spend request, the fields the central guard can't know
// about. These are programming/client errors, so each is thrown as a fault, not an ordinary
// refusal:
//   - `sku` must name an item; a blank one would grant ownership of nothing.
//   - `orderId` must be present; it's the unique key for duplicate-order protection (the
//     DUPLICATE_ORDER guard reads the stored Sale by it), and a blank one collapses that: two
//     different purchases sharing a blank order id would look like one order.
//   - No two recipients may name the same `sellerId`: a duplicate would split the seller's cut
//     across two earned-credit lines under one id, double-counting in the share math.
//   - No recipient may be a house/system account. Recipients are credited to their EARNED
//     (cash-outable) balance, which only a real user wallet may receive, so `earned(sellerId)` must
//     be a user wallet account (not a `platform:`-prefixed house account) with a non-blank owner.
//     (Self-dealing and share-bounds are checked separately.)
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
    // real user wallet. A house/system account (e.g. `platform:revenue`) isn't a wallet owner; routing
    // earnings there would credit a platform account as if it were a seller.
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

// Require recipient shares to sum to exactly 10000 basis points (100%), each a sane fraction of the
// net. An empty list is allowed and means the platform keeps the whole net (REVENUE takes
// everything). Any other total is a malformed request, caught here so a miswired split can't leave
// part of the price stuck with nobody.
//
// The sum check alone isn't enough: shares like [-5000, 15000] still sum to 10000, but a negative
// share would credit a seller a negative amount (a hidden debit) and a >100% share would pay out
// more of the part than exists. So each share must be strictly positive and at most 10000 bps on
// its own.
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

// Refuse a spend where the buyer names themselves as a recipient. A spend pays each recipient's
// earned (cash-outable) balance out of platform REVENUE for the promo-funded part and out of the
// buyer's payment for the spendable part. If the buyer is also a recipient, they convert their own
// non-cashable spendable/promo credit into cash-outable EARNED credit, laundering grant/top-up
// balance into withdrawable money funded by the house. Buyer and seller must be different parties,
// so this is a malformed request thrown as a fault.
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
