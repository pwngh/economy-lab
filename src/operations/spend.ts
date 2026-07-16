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
import {
  encodeAmount,
  mulDiv,
  requirePositiveCredit,
  toAmount,
} from '#src/money.ts';
import {
  SYSTEM,
  earned,
  isWalletAccount,
  ownerOf,
  promo,
  routePlatformLegs,
  spendable,
} from '#src/accounts.ts';
import { maturedAtLeast, maturedAvailableAt } from '#src/maturity.ts';
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

/**
 * How a payment splits across the buyer's two balances: promo (marketing-grant) first, remainder
 * from spendable.
 */
export type SpendPlan = { promoPart: Amount; spendablePart: Amount };

/**
 * Run a marketplace purchase: charge the buyer and pay the sellers as one balanced
 * ledger posting. Buyer pays from promo (marketing-grant) balance first, then spendable. A sale
 * summary is saved under `orderId` so a later refund can reverse exactly what posted, and the SKU
 * entitlement is granted in the same transaction so paying always confers ownership (to the buyer,
 * or to `giftTo` when present). A second request reusing an `orderId` already on file is refused
 * with `DUPLICATE_ORDER` so the buyer is never double-charged for one order.
 *
 * The submit pipeline has already authorized, deduplicated, checked affordability, and locked the
 * accounts; this only validates its own inputs and posts. Malformed input (bad price, shares that
 * don't sum) throws a fault, not a refusal.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/spend/ Spend} for the
 * purchase flow, balance draw order, and split accounting this handler posts.
 */
/**
 * The pipeline's pre-claim probe, run before any lock or screen: a committed sale row is final
 * (sales are never deleted), so a replayed orderId rejects here without paying for the locks it
 * will never need. A miss falls through to the authoritative under-lock check in the handler.
 */
export async function spendPreClaim(
  operation: Operation,
  unit: Unit,
): Promise<Outcome | null> {
  assertKind(operation, 'spend');
  const existing = await unit.sales.get(operation.orderId);
  return existing === null
    ? null
    : rejected('DUPLICATE_ORDER', { orderId: operation.orderId });
}

export async function spend(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'spend');
  assertSpendShape(operation);
  const price = requirePositiveCredit(operation.price, 'spend.price');
  assertShares(operation);
  assertNoSelfDealing(operation);
  const recipientId = entitlementRecipient(operation);

  // The authoritative duplicate-order check: the accounts are locked, so reading the stored sale
  // can't race another writer. A duplicate is a business rejection, not a fault, so no second
  // debit posts.
  // See https://economy-lab-docs.pages.dev/economy/reference/operations/spend/ for why orderId is
  // distinct from the idempotency key.
  const existing = await unit.sales.get(operation.orderId);
  if (existing !== null) {
    return rejected('DUPLICATE_ORDER', { orderId: operation.orderId });
  }

  // The funds screen already read promo and spendable under the lock into `unit.balances`; reuse them
  // here. Without that cache (the handler called directly), fall back to a live read.
  const promoAccount = promo(operation.buyerId);
  const spendableAccount = spendable(operation.buyerId);
  const promoBalance =
    unit.balances?.get(promoAccount) ??
    (await unit.ledger.balance(promoAccount));
  const plan = planSpend(price, promoBalance);

  // Require the spendable-funded part to be covered by cleared (matured) funds. Promo draws first,
  // so only the spendable part is checked; the pipeline's affordability check sees the raw balance
  // and can pass on funds still in a settlement wait. Refuse with FUNDS_IMMATURE (a rejection, not a
  // fault, like INSUFFICIENT_FUNDS) rather than dip into uncleared funds.
  const cleared = await maturedAtLeast(
    unit.ledger,
    spendableAccount,
    ctx.clock.now(),
    {
      config: ctx.config,
      amount: plan.spendablePart,
      live: unit.balances?.get(spendableAccount),
    },
  );
  if (!cleared) {
    // The second walk runs only on this rejection path; availableAt lets a caller tell the
    // buyer when the same purchase will clear.
    const availableAt = await maturedAvailableAt(
      unit.ledger,
      spendableAccount,
      ctx.clock.now(),
      {
        config: ctx.config,
        amount: plan.spendablePart,
        live: unit.balances?.get(spendableAccount),
      },
    );
    return rejected('FUNDS_IMMATURE', {
      account: spendable(operation.buyerId),
      required: encodeAmount(plan.spendablePart),
      ...(availableAt === null ? {} : { availableAt }),
    });
  }

  // Route the finished legs' platform accounts (PROMO_FLOAT and REVENUE, including the REVENUE
  // credits the injected fee policy built) to a shard by the idempotency key, the same key the
  // lock set routed by. Routing after the build is what spares the policy knowing about shards.
  const legs = routePlatformLegs(
    buildSpendLegs(operation, plan, ctx),
    operation.idempotencyKey,
    ctx.config.platformShards,
  );

  // The ledger doesn't block on age; the external payments/identity provider does. The flag on
  // the immutable posting is only an audit trail.
  const meta: Record<string, unknown> = {
    kind: 'spend',
    orderId: operation.orderId,
  };
  if (operation.ageRestricted) {
    meta.ageRestricted = true;
  }
  if (recipientId !== operation.buyerId) {
    meta.isGift = true;
    meta.giftTo = recipientId;
  }

  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta,
  });
  await unit.sales.put(
    saleOf(operation, plan, transaction, ctx.config.platformFeeBps),
  );

  // Same transaction as the charge, so a rolled-back charge grants nothing. grant also clears any
  // prior revoked mark, so re-buying after a refund reactivates ownership.
  await unit.entitlements.grant(recipientId, operation.sku, {
    source: 'sale:' + operation.orderId,
  });

  return { status: 'committed', transaction };
}

/**
 * Split the price across balances: take as much as possible from promo first (capped at the
 * price), charge the remainder to spendable. The one implementation of the rule — the submit
 * pipeline's funds screen (economy.ts) and the subscribe handler import it, so the up-front check
 * and every posting agree on the split.
 */
export function planSpend(price: Amount, promoBalance: Amount): SpendPlan {
  const available = promoBalance.minor > 0n ? promoBalance.minor : 0n;
  const promoMinor = available < price.minor ? available : price.minor;
  return {
    promoPart: toAmount(price.currency, promoMinor),
    spendablePart: toAmount(price.currency, price.minor - promoMinor),
  };
}

function buildSpendLegs(
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
  ctx: Ctx,
): Leg[] {
  const legs: Leg[] = [];
  appendPromoLegs(legs, operation, plan);
  appendSpendableLegs(legs, operation, plan, ctx);
  return legs;
}

// Sellers on the promo-funded part are paid from REVENUE, not the buyer, because a promo grant
// isn't money the buyer paid; see
// https://economy-lab-docs.pages.dev/economy/reference/operations/spend/ for the promo-funded
// split. Shares round down, and the leftover is not debited from REVENUE, so the house keeps it.
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

  const distributed = distributeEarned(
    legs,
    plan.promoPart,
    operation.recipients ?? [],
  );
  legs.push(debit(SYSTEM.REVENUE, distributed));
}

// The injected fee policy's credit lines (sellers' earned plus REVENUE's fee and rounding
// leftover) account for the spendable part to the last minor unit.
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
  for (const leg of ctx.pricing({
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
  for (const recipient of recipients) {
    const share = mulDiv(
      amount.minor,
      BigInt(recipient.shareBps),
      10_000n,
      'floor',
    );
    distributed += share;

    if (share > 0n) {
      legs.push(
        credit(earned(recipient.sellerId), toAmount(amount.currency, share)),
      );
    }
  }
  return toAmount(amount.currency, distributed);
}

// The recorded fee is REVENUE's cut of the spendable-funded part only (the promo part is charged
// no fee), computed with `revenueForSplit` so it equals what REVENUE actually kept; the bare
// `feeForPrice` would understate it on an uneven multi-seller split.
function saleOf(
  operation: Extract<Operation, { kind: 'spend' }>,
  plan: SpendPlan,
  transaction: Transaction,
  feeBps: number,
): Sale {
  const feeMinor = revenueForSplit(
    plan.spendablePart,
    operation.recipients ?? [],
    feeBps,
  );
  return {
    orderId: operation.orderId,
    buyerId: operation.buyerId,

    recipientId: operation.giftTo ?? operation.buyerId,
    sku: operation.sku,
    price: operation.price,
    fee: toAmount(operation.price.currency, feeMinor),
    legs: transaction.legs.map((leg) => ({ ...leg })),
    txnId: transaction.id,
    postedAt: transaction.postedAt,
  };
}

// A present-but-blank `giftTo` would grant ownership to an empty user id, so it's a fault.
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

// Shape checks the central guard can't know about; each throws a fault, not a refusal. The stakes:
// a blank orderId makes two purchases look like one order, a duplicate sellerId double-counts in
// the share math, and a house account must not receive a payable EARNED credit.
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

  const seen = new Set<string>();
  for (const recipient of operation.recipients ?? []) {
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

    const account = earned(recipient.sellerId);
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

// Require recipient shares to sum to exactly 10000 basis points (100%), so a miswired split can't
// leave part of the price stuck with nobody. An empty list is allowed and means the platform keeps
// the whole net (REVENUE takes everything).
//
// The sum check alone isn't enough: shares like [-5000, 15000] still sum to 10000, but a negative
// share is a hidden debit and a >100% share pays out more of the part than exists. So each share
// must also be strictly positive and at most 10000 bps on its own.
function assertShares(operation: Extract<Operation, { kind: 'spend' }>): void {
  const recipients = operation.recipients ?? [];
  if (recipients.length === 0) {
    return;
  }
  for (const recipient of recipients) {
    if (recipient.shareBps <= 0 || recipient.shareBps > 10_000) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'Each recipient share must be > 0 and <= 10000 basis points.',
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
  const total = recipients.reduce(
    (sum, recipient) => sum + recipient.shareBps,
    0,
  );
  if (total !== 10_000) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'Recipient shareBps must sum to 10000.',
      { detail: { kind: operation.kind, total } },
    );
  }
}

// A buyer who is also a recipient would convert their own non-payable spendable/promo credit into
// payable EARNED credit funded by the house — laundering — so it's a fault, not a business "no".
function assertNoSelfDealing(
  operation: Extract<Operation, { kind: 'spend' }>,
): void {
  for (const recipient of operation.recipients ?? []) {
    if (recipient.sellerId === operation.buyerId) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'A spend recipient may not be the buyer (self-dealing).',
        {
          detail: { kind: operation.kind, buyerId: operation.buyerId },
        },
      );
    }
  }
}
