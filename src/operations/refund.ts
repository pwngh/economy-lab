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
import { assertKind } from '#src/operations/guards.ts';
import { SYSTEM, isDebitNormal } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Leg, Sale, Unit } from '#src/ports.ts';

/**
 * Undo a past sale, making the buyer whole even when a seller already spent their cut.
 *
 * A naive sign-flip breaks once a seller spent their cut: reversing their credit drives the earned
 * balance negative, the ledger rejects the posting, and the buyer goes unpaid. Instead this returns
 * the buyer the full price and claws back from each seller (and REVENUE) only up to what each still
 * holds, booking the uncollectable rest to `SYSTEM.RECEIVABLE` so debits and credits still cancel.
 *
 * Refund and an order-tied clawback share the order-scoped key `reversed:<orderId>` to stay mutually
 * exclusive; a lost claim returns the recorded transaction as `duplicate`. The buyer's SKU
 * entitlement is revoked in the same database transaction. Returns `committed`, `duplicate`, or
 * `rejected` with `UNKNOWN_ORDER`.
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
  assertKind(operation, 'refund');
  requireOrderId(operation.orderId);

  let sale = await unit.sales.get(operation.orderId);
  if (sale === null) {
    return rejected('UNKNOWN_ORDER', { orderId: operation.orderId });
  }

  await extendLocks(unit, sale);

  // The inner, order-scoped claim. Refund and order-tied clawback both reverse this order, so
  // claiming `reversed:<orderId>` makes the two paths mutually exclusive. Whoever claims first
  // reverses, and the loser gets the recorded transaction back as a duplicate.
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

// Locks every account the reversing posting will touch, so no other writer changes those balances
// between reading them (to decide how much to claw back) and posting. The request only names an
// order id, so the framework can lock only the fixed system accounts. This fills the gap by locking
// each account named in the recorded sale's lines: the buyer's accounts and each seller's
// earned-balance account. The locks go through `lockAll` so they take the same deadlock-free global
// order as every other lock-set, not the leg order they happen to appear in. RECEIVABLE is already
// framework-locked here.
async function extendLocks(unit: Unit, sale: Sale): Promise<void> {
  await lockAll(
    unit.ledger,
    sale.legs.map((leg) => leg.account),
  );
}

// The net balance change the sale made to one account, where positive means the balance went up.
// Collectability is judged against this net.
type AccountDelta = {
  account: AccountRef;
  delta: bigint;
  currency: Amount['currency'];
};

// The plan for reversing the sale. It records how much of each clawback is collectable now and
// splits the uncollectable rest out as a debt owed to the platform (RECEIVABLE).
type Coverage = {
  // Accounts the reversal only raises, applied in full with no cap because raising never pushes a
  // balance below zero. These are the buyer's refund and the platform accounts the sale drew down
  // and now unwinds. Each entry carries the amount to add back.
  uncapped: AccountDelta[];

  // Clawbacks that pull money out of an account, each limited to what that account can cover.
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
    // reversal raises it. Raising never pushes a balance below zero, so it applies in full. Where
    // the sale raised an account (a seller's earned balance, or REVENUE that took a fee), the
    // reversal lowers it. That clawback is capped at the amount actually on hand.
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

// Turns the plan into debit and credit lines. It raises each uncapped account, pulls each capped
// clawback, and credits RECEIVABLE for the uncollectable total. RECEIVABLE stands in for exactly
// the missing amounts, so the lines balance to zero as the original sale's did.
function reversalLegs(coverage: Coverage): Leg[] {
  let legs: Leg[] = [];
  for (let u of coverage.uncapped) {
    legs.push(raiseLeg(u.account, toAmount(u.currency, u.delta)));
  }
  for (let c of coverage.capped) {
    legs.push(lowerLeg(c.account, toAmount(c.currency, c.covered)));
  }
  if (coverage.shortfall > 0n) {
    // The shortfall is always in the in-app CREDIT currency, never USD. A sale moves only CREDIT,
    // since only a top-up moves USD, so the RECEIVABLE debt is denominated in CREDIT to match.
    legs.push(
      raiseLeg(SYSTEM.RECEIVABLE, toAmount('CREDIT', coverage.shortfall)),
    );
  }
  return legs;
}

function raiseLeg(account: AccountRef, amount: Amount): Leg {
  let sign = isDebitNormal(account) ? 1n : -1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

function lowerLeg(account: AccountRef, amount: Amount): Leg {
  let sign = isDebitNormal(account) ? -1n : 1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

// Sums the sale's lines into one balance change per account, where positive means the balance went
// up. A sale can post several lines to the same account, since REVENUE gets both a fee credit and a
// promo-funding debit, so the lines are summed per account. Lines are stored as raw amounts where a
// debit is positive. Before summing, `balanceDelta` converts each line into its effect on that
// account's balance, which depends on whether the account grows on a debit or a credit.
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

// Reads the account's current balance in up-is-positive terms, which is how its stored balance
// already reads. The caller uses this to judge how much of a clawback is collectable. A user
// account never holds a negative balance, but reading up-is-positive keeps the cap correct for a
// house account that may.
async function balanceUp(unit: Unit, account: AccountRef): Promise<bigint> {
  let current = await unit.ledger.balance(account);
  return current.minor;
}

// Builds the metadata stored with the reversing transaction. It records which order is refunded,
// the id of the original transaction it reverses, and the caller's reason when one is given. No
// money amounts go here; the lines carry those.
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

// Requires a non-blank `orderId`. A blank or whitespace-only value is malformed input the central
// guard cannot catch, because it carries no order to look up. Left unchecked it would return a
// UNKNOWN_ORDER rejection that does not distinguish the malformed request from a genuine lookup
// miss, so this throws a fault instead to report the client error. A genuinely unknown but non-blank orderId still flows through to the
// UNKNOWN_ORDER rejection.
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
