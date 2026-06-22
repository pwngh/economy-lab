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
import { balanceDelta, postEntry } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { SYSTEM, isDebitNormal } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Leg, Sale, Unit } from '#src/ports.ts';

/**
 * Undo a past sale, always making the buyer whole, even when a seller has already spent
 * the cut the sale paid them.
 *
 * A naive refund just flips the sign of every recorded debit and credit line. That breaks
 * the moment a seller has paid out their earned cut. Reversing the sale's original credit to
 * the seller's earned balance becomes a debit, and if the seller has since spent that money
 * the debit drives their earned balance negative. The ledger forbids a user account going
 * negative, so it rejects the whole posting and the entire refund rolls back — leaving the
 * buyer unpaid because of a debt the seller ran up. Instead this handler always returns the
 * buyer the full price and only claws back from each seller (and from the platform's REVENUE
 * account) up to what each actually still holds. Any amount it cannot collect is booked to
 * `SYSTEM.RECEIVABLE` — a debt the platform is now owed — so the debits and credits still
 * cancel. That keeps the ledger's negative-balance guard a thing that never legitimately
 * fires, rather than turning every under-collected refund into a failure.
 *
 * A refund and an order-tied clawback both reverse the same sale, so only one of them may
 * run. The request carries an idempotency key (the value that makes a retried request run at
 * most once); the surrounding framework has already claimed that key. On top of that, before
 * posting, this claims a second key scoped to the order — `reversed:<orderId>` — which is
 * what makes the refund and clawback paths mutually exclusive on a given order. If that claim
 * is lost, the order was already reversed by the other path (or by an earlier refund), so
 * this returns that already-recorded transaction as a `duplicate` instead of reversing twice.
 * After the reversal commits it revokes the buyer's entitlement to the purchased SKU in the
 * same database transaction, so a refunded buyer no longer owns the item. The revoke is a
 * no-op if the buyer was never granted it.
 *
 * Returns `committed` with the reversing transaction, `duplicate` when the order was already
 * reversed, or `rejected` with `UNKNOWN_ORDER` when no sale was ever recorded for the order
 * (an ordinary "no", not an error). Being called for any kind other than `refund` is a wiring
 * bug, so that throws.
 *
 * @example
 *   let outcome = await refund(
 *     { kind: 'refund', idempotencyKey: 'idem_1',
 *       actor: { kind: 'system', service: 'support' }, orderId: 'ord_1', reason: 'changed mind' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; buyer gets the full price back, seller debited only
 *   // as far as the balance they still hold.
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

  // The inner, order-scoped claim. Refund and order-tied clawback both reverse this order, so
  // claiming `reversed:<orderId>` here is what makes the two paths mutually exclusive: whoever
  // claims first reverses, the loser gets that recorded transaction back as a duplicate.
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
  // same order resolves to this same transaction. This write is part of the same database
  // transaction as the reversal, so if the refund rolls back the claim is rolled back too and
  // the order can still be reversed later.
  await unit.idempotency.record(claimKey, transaction);

  // Take back ownership of the purchased item that the sale granted, from whoever received it:
  // the buyer for an ordinary purchase, or the gift recipient (`recipientId`) for a gift. Older
  // sales recorded before gifting existed have no `recipientId`, so fall back to the buyer. Does
  // nothing if that user was never granted the SKU (for example, an old sale made before the
  // system started granting ownership at purchase time). Runs in the same database transaction as
  // the reversal, so the two commit or roll back together.
  await unit.entitlements.revoke(sale.recipientId ?? sale.buyerId, sale.sku);

  return { status: 'committed', transaction };
}

// Lock every account the reversing posting will touch, so no other writer can change those
// balances between the moment this refund reads them to decide how much it can claw back and
// the moment it posts. The refund request only names an order id, so the framework could lock
// only the fixed system accounts every refund touches; this fills the gap by locking each
// account named in the recorded sale's debit/credit lines (the buyer's accounts and each
// seller's earned-balance account). RECEIVABLE is already among the accounts the framework
// locked for a refund.
async function extendLocks(unit: Unit, sale: Sale): Promise<void> {
  let seen = new Set<AccountRef>();
  for (let leg of sale.legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      await unit.ledger.lock(leg.account);
    }
  }
}

// The net balance change the sale made to one account, expressed so that a positive number
// always means the balance went up (a seller's earned balance rose, the buyer's spendable
// balance fell, REVENUE rose by the fee minus any promo funding). Reversing the sale means
// undoing each of these. A sale can post several debit/credit lines to the same account (for
// example REVENUE gets both a fee credit and a promo-funding debit), so these are first summed
// per account, giving the one true net effect on each account to judge collectability against.
type AccountDelta = {
  account: AccountRef;
  delta: bigint;
  currency: Amount['currency'];
};

// The plan for reversing the sale: how much of each clawback the platform can actually collect
// right now, with whatever it cannot collect already split out as a debt owed to the platform
// (RECEIVABLE). For an account the reversal would push below zero — a seller's earned balance
// they have since paid out, or REVENUE already moved elsewhere — only the part that is still
// there is collectable (the current balance if positive, otherwise nothing); the rest becomes
// that debt.
type Coverage = {
  // Accounts the reversal only ever raises and so can apply in full with no cap: returning the
  // buyer's money, and unwinding any platform account that is allowed to go negative and that
  // the sale had drawn down. Each carries the exact amount to add back.
  uncapped: AccountDelta[];

  // Clawbacks the reversal pulls money OUT of an account for, each already limited to the
  // amount that account can actually cover.
  capped: {
    account: AccountRef;
    covered: bigint;
    currency: Amount['currency'];
  }[];

  // The total of every amount that could not be collected, recorded against RECEIVABLE as a
  // debt owed to the platform so the reversal's debits and credits still cancel.
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
    // The reversal applies the opposite of the sale's balance change. Where the sale lowered an
    // account (the buyer's accounts it debited, or REVENUE and other platform accounts it drew
    // down), the reversal RAISES it, which can never push a balance below zero, so it applies in
    // full. Where the sale raised an account (a seller's earned balance, or REVENUE that took a
    // fee), the reversal LOWERS it — a clawback that must be capped at the amount actually there.
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

// Turn the reversal plan into the actual debit/credit lines to post: raise each uncapped
// account (return the buyer's money, undo the platform accounts the sale drew down), pull each
// capped clawback only as far as that account can cover, and add a line crediting RECEIVABLE
// for the total that could not be collected so the debits and credits still cancel. Every
// amount matches the original sale except where RECEIVABLE stands in for an uncollectable part,
// so the reversal's lines balance to zero just as the original sale's did.
function reversalLegs(coverage: Coverage): Leg[] {
  let legs: Leg[] = [];
  for (let u of coverage.uncapped) {
    legs.push(raiseLeg(u.account, toAmount(u.currency, u.delta)));
  }
  for (let c of coverage.capped) {
    legs.push(lowerLeg(c.account, toAmount(c.currency, c.covered)));
  }
  if (coverage.shortfall > 0n) {
    // The shortfall is always in the in-app CREDIT currency (not USD): a sale only ever moves
    // CREDIT — the only thing that moves USD is a top-up, never a sale — so the debt booked to
    // RECEIVABLE to cover the under-collection is denominated in CREDIT to match.
    legs.push(
      raiseLeg(SYSTEM.RECEIVABLE, toAmount('CREDIT', coverage.shortfall)),
    );
  }
  return legs;
}

// A leg that RAISES `account`'s balance by `amount`, picking the debit/credit side from the
// account's normal side (debit-normal accounts rise on a debit; the rest rise on a credit).
function raiseLeg(account: AccountRef, amount: Amount): Leg {
  let sign = isDebitNormal(account) ? 1n : -1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

// A leg that LOWERS `account`'s balance by `amount`, the mirror of `raiseLeg`.
function lowerLeg(account: AccountRef, amount: Amount): Leg {
  let sign = isDebitNormal(account) ? -1n : 1n;
  return { account, amount: toAmount(amount.currency, amount.minor * sign) };
}

// Sum the sale's debit/credit lines into a single balance change per account, expressed so a
// positive number means the balance went up. Lines are stored as raw amounts where a debit is
// positive; `balanceDelta` converts each one into its actual effect on that account's balance
// (which depends on whether the account grows on a debit or on a credit) before they are summed.
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
// way), used to judge how much of a clawback is collectable. A user account never legitimately
// holds a negative balance, but reading it up-is-positive keeps the coverage cap correct even
// for a house account that may.
async function balanceUp(unit: Unit, account: AccountRef): Promise<bigint> {
  let current = await unit.ledger.balance(account);
  return current.minor;
}

// The metadata stored with the reversing transaction: which order is being refunded and the id
// of the original transaction it reverses, plus the caller's reason when one was given. No money
// amounts go here — the lines themselves carry those.
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

// A refund names the order it reverses by `orderId`, so a blank or whitespace-only `orderId` is
// malformed structured input the central guard can't catch: it carries no order to look up. Left
// unchecked it would degrade to a silent UNKNOWN_ORDER rejected outcome, hiding the malformed
// request behind an ordinary "no". Throw a loud fault instead so the client error surfaces. A
// genuinely-unknown (non-blank) orderId is a different thing — that still flows through to the
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

// Operations are routed to handlers by their `kind`, so reaching this handler with any kind
// other than `refund` means the routing is wired wrong. Throw a loud fault rather than try to
// handle an operation this function wasn't written for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
