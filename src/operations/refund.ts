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

import { fault, rejected, ERROR_CODES } from '#src/errors.ts';
import { balanceDelta, lockAll, postEntry } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM, isDebitNormal } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Leg, Sale, Unit } from '#src/ports.ts';

/**
 * Undo a past sale, making the buyer whole even when a seller already spent their cut.
 *
 * A naive sign-flip breaks once a seller spent their cut: reversing their credit becomes a debit
 * that drives the earned balance negative, the ledger rejects the posting, and the refund rolls
 * back leaving the buyer unpaid. Instead return the buyer the full price and claw back from each
 * seller (and REVENUE) only up to what each still holds; the uncollectable rest is booked to
 * `SYSTEM.RECEIVABLE` so debits and credits still cancel.
 *
 * A refund and an order-tied clawback both reverse the same sale, so only one may run: a second
 * order-scoped idempotency key, `reversed:<orderId>`, makes the two paths mutually exclusive per
 * order. A lost claim means the order was already reversed, so return the recorded transaction as
 * `duplicate`. After the reversal commits, revoke the buyer's entitlement to the SKU in the same
 * database transaction; no-op if the buyer was never granted it.
 *
 * Returns `committed` with the reversing transaction, `duplicate` when already reversed, or
 * `rejected` with `UNKNOWN_ORDER` when no sale was recorded for the order. Any kind other than
 * `refund` is a wiring bug and throws.
 *
 * @example
 *   let outcome = await refund(
 *     { kind: 'refund', idempotencyKey: 'idem_1',
 *       actor: { kind: 'system', service: 'support' }, orderId: 'ord_1', reason: 'changed mind' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; buyer gets the full price back, seller debited only
 *   // up to the balance they still hold.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/refund/ Refund} for the make-the-buyer-whole coverage plan.
 */
export async function refund(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'refund') {
    throw kindMismatch(operation);
  }
  requireOrderId(operation.orderId);

  let sale = await unit.sales.get(operation.orderId);
  if (sale === null) {
    return rejected('UNKNOWN_ORDER', { orderId: operation.orderId });
  }

  await extendLocks(unit, sale);

  // Inner, order-scoped claim. Refund and order-tied clawback both reverse this order, so
  // claiming `reversed:<orderId>` makes the two paths mutually exclusive: whoever claims first
  // reverses, the loser gets the recorded transaction back as a duplicate.
  let claimKey = `reversed:${operation.orderId}`;
  let claim = await unit.idempotency.claim(claimKey);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  let legs = reversalLegs(await coverageOf(unit, sale));

  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: refundMeta(operation, sale),
  });

  // Record the order-scoped claim against this reversal, so a later refund or clawback of the
  // same order resolves to this transaction. Part of the same database transaction as the
  // reversal: if the refund rolls back the claim does too, and the order can be reversed later.
  await unit.idempotency.record(claimKey, transaction);

  // Take back ownership from whoever received the item: the buyer for an ordinary purchase, or
  // the gift recipient (`recipientId`) for a gift. Sales recorded before gifting existed have no
  // `recipientId`, so fall back to the buyer. No-op if that user was never granted the SKU (e.g.
  // a sale predating ownership-at-purchase). Same database transaction as the reversal, so the
  // two commit or roll back together.
  await unit.entitlements.revoke(sale.recipientId ?? sale.buyerId, sale.sku);

  return { status: 'committed', transaction };
}

// Lock every account the reversing posting will touch, so no other writer changes those balances
// between reading them (to decide how much to claw back) and posting. The request only names an
// order id, so the framework can only lock the fixed system accounts; this fills the gap by locking
// each account named in the recorded sale's lines (the buyer's accounts and each seller's
// earned-balance account). Through `lockAll`, so they take the same deadlock-free global order as
// every other lock-set, not the leg order they happen to appear in. RECEIVABLE is already
// framework-locked here.
async function extendLocks(unit: Unit, sale: Sale): Promise<void> {
  await lockAll(
    unit.ledger,
    sale.legs.map((leg) => leg.account),
  );
}

// Net balance change the sale made to one account, positive meaning the balance went up;
// collectability is judged against this net.
type AccountDelta = {
  account: AccountRef;
  delta: bigint;
  currency: Amount['currency'];
};

// Plan for reversing the sale: how much of each clawback is collectable now, with the
// uncollectable rest split out as a debt owed to the platform (RECEIVABLE).
type Coverage = {
  // Accounts the reversal only raises, applied in full with no cap (raising never pushes a
  // balance below zero): the buyer's refund, and unwinding platform accounts the sale drew down.
  // Each carries the amount to add back.
  uncapped: AccountDelta[];

  // Clawbacks pulling money out of an account, each limited to what that account can cover.
  capped: {
    account: AccountRef;
    covered: bigint;
    currency: Amount['currency'];
  }[];

  // Total uncollectable amount, booked against RECEIVABLE so debits and credits still cancel.
  shortfall: bigint;
};

async function coverageOf(unit: Unit, sale: Sale): Promise<Coverage> {
  let deltas = foldDeltas(sale.legs);

  let uncapped: AccountDelta[] = [];
  let capped: Coverage['capped'] = [];
  let shortfall = 0n;

  for (let d of deltas) {
    if (d.delta === 0n) {
      continue;
    }
    // The reversal applies the opposite of the sale's change. Where the sale lowered an account
    // (the buyer's accounts it debited, or REVENUE and other platform accounts it drew down), the
    // reversal raises it, which never pushes a balance below zero, so it applies in full. Where
    // the sale raised an account (a seller's earned balance, or REVENUE that took a fee), the
    // reversal lowers it: a clawback capped at the amount actually there.
    if (d.delta < 0n) {
      uncapped.push({
        account: d.account,
        delta: -d.delta,
        currency: d.currency,
      });
      continue;
    }
    let want = d.delta;
    let onHand = await balanceUp(unit, d.account);
    let covered = onHand < want ? (onHand > 0n ? onHand : 0n) : want;
    if (covered > 0n) {
      capped.push({ account: d.account, covered, currency: d.currency });
    }
    shortfall += want - covered;
  }

  return { uncapped, capped, shortfall };
}

// Turn the plan into debit/credit lines: raise each uncapped account, pull each capped clawback,
// and credit RECEIVABLE for the uncollectable total. RECEIVABLE stands in for exactly the missing
// amounts, so the lines balance to zero as the original sale's did.
function reversalLegs(coverage: Coverage): Leg[] {
  let legs: Leg[] = [];
  for (let u of coverage.uncapped) {
    legs.push(raiseLeg(u.account, toAmount(u.currency, u.delta)));
  }
  for (let c of coverage.capped) {
    legs.push(lowerLeg(c.account, toAmount(c.currency, c.covered)));
  }
  if (coverage.shortfall > 0n) {
    // The shortfall is always in the in-app CREDIT currency, not USD: a sale only moves CREDIT
    // (only a top-up moves USD), so the RECEIVABLE debt is denominated in CREDIT to match.
    legs.push(
      raiseLeg(SYSTEM.RECEIVABLE, toAmount('CREDIT', coverage.shortfall)),
    );
  }
  return legs;
}

// A leg that raises `account`'s balance by `amount`, picking the side from the account's normal
// side (debit-normal accounts rise on a debit; the rest rise on a credit).
function raiseLeg(account: AccountRef, amount: Amount): Leg {
  let sign = isDebitNormal(account) ? 1n : -1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

// Mirror of raiseLeg: lowers `account`'s balance by `amount` (opposite side).
function lowerLeg(account: AccountRef, amount: Amount): Leg {
  let sign = isDebitNormal(account) ? -1n : 1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

// Sum the sale's lines into one balance change per account, positive meaning the balance went
// up. A sale can post several lines to the same account (REVENUE gets both a fee credit and a
// promo-funding debit), so lines are summed per account. Lines are stored as raw amounts where a
// debit is positive; `balanceDelta` converts each into its effect on that account's balance
// (depending on whether it grows on a debit or credit) before summing.
function foldDeltas(legs: ReadonlyArray<Leg>): AccountDelta[] {
  let byAccount = new Map<AccountRef, AccountDelta>();
  for (let leg of legs) {
    let effect = balanceDelta(leg);
    let entry = byAccount.get(leg.account);
    if (entry === undefined) {
      byAccount.set(leg.account, {
        account: leg.account,
        delta: effect.minor,
        currency: effect.currency,
      });
    } else {
      entry.delta += effect.minor;
    }
  }
  return [...byAccount.values()];
}

// The account's current balance in up-is-positive terms (its stored balance already reads this
// way), used to judge how much of a clawback is collectable. A user account never holds a
// negative balance, but reading up-is-positive keeps the cap correct for a house account that may.
async function balanceUp(unit: Unit, account: AccountRef): Promise<bigint> {
  let current = await unit.ledger.balance(account);
  return current.minor;
}

// Metadata stored with the reversing transaction: which order is refunded, the id of the
// original transaction it reverses, plus the caller's reason when given. No money amounts here;
// the lines carry those.
function refundMeta(
  operation: Extract<Operation, { kind: 'refund' }>,
  sale: Sale,
): Record<string, unknown> {
  let meta: Record<string, unknown> = {
    kind: 'refund',
    orderId: operation.orderId,
    reversedTxnId: sale.txnId,
  };
  if (operation.reason !== undefined) {
    meta.reason = operation.reason;
  }
  return meta;
}

// A blank or whitespace-only `orderId` is malformed input the central guard can't catch: it
// carries no order to look up. Left unchecked it would degrade to a silent UNKNOWN_ORDER
// rejection, hiding the malformed request. Throw a fault instead so the client error surfaces.
// A genuinely-unknown (non-blank) orderId still flows through to the UNKNOWN_ORDER rejection.
function requireOrderId(orderId: string): void {
  if (orderId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'refund.orderId must not be blank.',
      {
        detail: { orderId },
      },
    );
  }
}

// Operations route to handlers by `kind`, so reaching this handler with any kind other than
// `refund` means the routing is wired wrong. Throw a fault rather than handle an operation this
// function wasn't written for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
