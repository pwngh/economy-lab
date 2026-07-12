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
import { assertKind, reversalKey } from '#src/operations/guards.ts';
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
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/refund/ Refund} for
 *   the make-the-buyer-whole coverage plan.
 */
export async function refund(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'refund');
  requireOrderId(operation.orderId);

  const sale = await unit.sales.get(operation.orderId);
  if (sale === null) {
    return rejected('UNKNOWN_ORDER', { orderId: operation.orderId });
  }

  await extendLocks(unit, sale);

  const claimKey = reversalKey(operation.orderId);
  const claim = await unit.idempotency.claim(claimKey);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  const legs = reversalLegs(await coverageOf(unit, sale));

  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: refundMeta(operation, sale),
  });

  // Same database transaction as the reversal: if the refund rolls back, the claim does too and
  // the order can still be reversed later.
  await unit.idempotency.record(claimKey, transaction);

  // Sales recorded before gifting existed have no `recipientId`, so fall back to the buyer; revoke
  // is a no-op for a sale predating ownership-at-purchase. Same database transaction as the
  // reversal, so the two commit or roll back together.
  await unit.entitlements.revoke(sale.recipientId ?? sale.buyerId, sale.sku);

  return { status: 'committed', transaction };
}

// The request names only an order id, so the framework locked just the fixed system accounts
// (RECEIVABLE included). This locks every account in the recorded sale's lines too, so no other
// writer moves a balance between the clawback read and the posting. `lockAll` applies the same
// deadlock-free global lock order as every other lock-set.
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
  // Accounts the reversal only raises, applied in full: raising never pushes a balance below zero.
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
  const deltas = foldDeltas(sale.legs);

  const uncapped: AccountDelta[] = [];
  const capped: Coverage['capped'] = [];
  let shortfall = 0n;

  for (const d of deltas) {
    if (d.delta === 0n) {
      continue;
    }
    if (d.delta < 0n) {
      uncapped.push({
        account: d.account,
        delta: -d.delta,
        currency: d.currency,
      });
      continue;
    }
    const want = d.delta;
    const onHand = await balanceUp(unit, d.account);
    const covered = onHand < want ? (onHand > 0n ? onHand : 0n) : want;
    if (covered > 0n) {
      capped.push({ account: d.account, covered, currency: d.currency });
    }
    shortfall += want - covered;
  }

  return { uncapped, capped, shortfall };
}

function reversalLegs(coverage: Coverage): Leg[] {
  const legs: Leg[] = [];
  for (const u of coverage.uncapped) {
    legs.push(raiseLeg(u.account, toAmount(u.currency, u.delta)));
  }
  for (const c of coverage.capped) {
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

// A leg that raises `account` by `amount` whatever its normal side: a debit-normal account is
// debited, a credit-normal account credited.
function raiseLeg(account: AccountRef, amount: Amount): Leg {
  const sign = isDebitNormal(account) ? 1n : -1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

function lowerLeg(account: AccountRef, amount: Amount): Leg {
  const sign = isDebitNormal(account) ? -1n : 1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

// A sale can post several lines to the same account (REVENUE takes both a fee credit and a
// promo-funding debit), so lines are summed per account. `balanceDelta` first converts each raw
// debit-positive line into its effect on that account's balance.
function foldDeltas(legs: ReadonlyArray<Leg>): AccountDelta[] {
  const byAccount = new Map<AccountRef, AccountDelta>();
  for (const leg of legs) {
    const effect = balanceDelta(leg);
    const entry = byAccount.get(leg.account);
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

// Balance in up-is-positive terms. A user account never holds a negative balance, but a house
// account may, and up-is-positive keeps the clawback cap correct there.
async function balanceUp(unit: Unit, account: AccountRef): Promise<bigint> {
  const current = await unit.ledger.balance(account);
  return current.minor;
}

function refundMeta(
  operation: Extract<Operation, { kind: 'refund' }>,
  sale: Sale,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    kind: 'refund',
    orderId: operation.orderId,
    reversedTxnId: sale.txnId,
  };
  if (operation.reason !== undefined) {
    meta.reason = operation.reason;
  }
  return meta;
}

// A blank orderId carries no order to look up; letting it fall through would return UNKNOWN_ORDER,
// indistinguishable from a genuine lookup miss, so throw a fault instead.
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
