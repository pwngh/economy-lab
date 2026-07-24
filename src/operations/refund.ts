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
import { verifiedPosting } from '#src/chain.ts';
import { toAmount } from '#src/money.ts';
import { assertKind, reversalKey } from '#src/operations/guards.ts';
import { SYSTEM, baseOf, isDebitNormal } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { AccrualRow, Leg, Posting, Sale, Unit } from '#src/ports.ts';

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

  // Re-prove the sale's posting against its chain links (verifiedPosting) before any leg derives
  // from it. The sales row is an unhashed convenience copy, cross-checked against the verified
  // posting and never trusted alone, so an in-place edit of either faults here instead of shaping
  // the reversal.
  const posting = await verifiedPosting(
    { ledger: unit.ledger, digest: ctx.digest },
    sale.txnId,
  );
  if (posting === null) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'A sales row names a posting the ledger does not hold; refusing to reverse unverifiable history.',
      {
        retryable: false,
        detail: { orderId: sale.orderId, txnId: sale.txnId },
      },
    );
  }
  assertSaleMatchesPosting(sale, posting);

  await extendLocks(unit, posting.legs);

  const claimKey = reversalKey(operation.orderId);
  const claim = await unit.idempotency.claim(claimKey);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  // Path choice is driven by the data, not the accrual flag: a sale that parked shares under the
  // split must reverse through its accrual rows even if the flag has since been turned off —
  // the legacy fold would claw the pooled shard without voiding the rows, and the drain would
  // later pay the seller for the refunded order out of other orders' shares. Rows are matched to
  // the sale by its posting id, so a hostile orderId colliding with another charge's row key can
  // never pull that charge's rows into this reversal. The txn id is minted first so the terminal
  // row marks can carry it.
  const txnId = ctx.ids.next('txn');
  const claimed = await unit.accruals.claimByOrder(sale.orderId);
  const saleRows = claimed.filter((row) => row.txnId === sale.txnId);
  const reversal =
    saleRows.length > 0
      ? await accrualReversalLegs(unit, ctx, posting, {
          claimed,
          saleRows,
          txnId,
        })
      : {
          legs: reversalLegs(await coverageOf(unit, posting.legs)),
          recovered: null,
        };

  const transaction = await postEntry(unit.ledger, {
    txnId,
    legs: reversal.legs,
    meta: refundMeta(operation, sale, reversal.recovered),
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
// (RECEIVABLE included). This locks every account in the verified posting's lines too, so no
// other writer moves a balance between the clawback read and the posting. `lockAll` applies the
// same deadlock-free global lock order as every other lock-set.
async function extendLocks(
  unit: Unit,
  legs: ReadonlyArray<Leg>,
): Promise<void> {
  await lockAll(
    unit.ledger,
    legs.map((leg) => leg.account),
  );
}

// The sales row must carry exactly the legs its verified posting holds — compared as multisets,
// since neither side's order is contractual. A mismatch means the unhashed copy was edited.
function assertSaleMatchesPosting(sale: Sale, posting: Posting): void {
  const keyOf = (leg: Leg): string =>
    `${leg.account}|${leg.amount.currency}|${leg.amount.minor}`;
  const expected = [...posting.legs].map(keyOf).sort();
  const recorded = [...sale.legs].map(keyOf).sort();
  if (
    expected.length !== recorded.length ||
    expected.some((key, i) => key !== recorded[i])
  ) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'A sales row no longer matches its verified posting; refusing to reverse tampered history.',
      {
        retryable: false,
        detail: { orderId: sale.orderId, txnId: sale.txnId },
      },
    );
  }
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

async function coverageOf(
  unit: Unit,
  legs: ReadonlyArray<Leg>,
): Promise<Coverage> {
  const deltas = foldDeltas(legs);

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

// The accrual-mode reversal. The buyer's restoration still comes from the uncapped raises of the
// sale's own legs; what changes is the seller side. The order's accrual rows are claimed under
// lock and split by status: a pending share is clawed out of its exact ACCRUAL shard and marked
// refunded, while a drained share (the seller already got the money) is balanced by raising
// RECEIVABLE and appending a negative row the drain nets against the seller's future shares.
// Every other clawback (REVENUE's fee legs; earned rows on sales recorded before the split) keeps
// the capped-with-shortfall treatment — a mixed-history order reverses correctly either way.
async function accrualReversalLegs(
  unit: Unit,
  ctx: Ctx,
  posting: Posting,
  work: {
    // Every row claimed under the order's key, foreign and recovery rows included — only used to
    // sequence new recovery rows past every existing key.
    claimed: ReadonlyArray<AccrualRow>;
    // The rows this sale's posting created, the only ones this reversal settles.
    saleRows: ReadonlyArray<AccrualRow>;
    txnId: string;
  },
): Promise<{ legs: Leg[]; recovered: ReadonlyMap<string, bigint> | null }> {
  const { claimed, saleRows, txnId } = work;
  // The rows are an unhashed side table; each must match the share map sealed inside the
  // verified posting's hashed metadata, or an edited amount would shape the claw.
  assertRowsMatchShares(saleRows, posting);
  const pending = saleRows.filter(
    (row) => row.status === 'pending' && row.amount.minor > 0n,
  );
  const drained = saleRows.filter(
    (row) => row.status === 'drained' && row.amount.minor > 0n,
  );

  const legs: Leg[] = [];
  let shortfall = 0n;
  for (const d of foldDeltas(posting.legs)) {
    if (d.delta === 0n) {
      continue;
    }
    if (d.delta < 0n) {
      legs.push(raiseLeg(d.account, toAmount(d.currency, -d.delta)));
      continue;
    }
    // The ACCRUAL shards' clawback is decided per row below, not by folded delta.
    if (baseOf(d.account) === SYSTEM.SETTLEMENT_ACCRUAL) {
      continue;
    }
    const want = d.delta;
    const onHand = await balanceUp(unit, d.account);
    const covered = onHand < want ? (onHand > 0n ? onHand : 0n) : want;
    if (covered > 0n) {
      legs.push(lowerLeg(d.account, toAmount(d.currency, covered)));
    }
    shortfall += want - covered;
  }

  // Pending shares are provably parked on their shard, so the claw is exact and uncapped.
  for (const row of pending) {
    legs.push(lowerLeg(row.shard, row.amount));
  }
  let drainedMinor = 0n;
  for (const row of drained) {
    drainedMinor += row.amount.minor;
  }
  if (drainedMinor > 0n) {
    legs.push(raiseLeg(SYSTEM.RECEIVABLE, toAmount('CREDIT', drainedMinor)));
  }
  if (shortfall > 0n) {
    legs.push(raiseLeg(SYSTEM.RECEIVABLE, toAmount('CREDIT', shortfall)));
  }

  await unit.accruals.markRefunded(
    pending.map(({ orderId, sellerId, seq }) => ({ orderId, sellerId, seq })),
    txnId,
  );
  // The recovery amounts also ride the refund posting's hashed metadata, so the drain can prove
  // each negative row against the posting that created it.
  const recovered = new Map<string, bigint>();
  for (const row of drained) {
    recovered.set(row.sellerId, row.amount.minor);
  }
  if (drained.length > 0) {
    await unit.accruals.put(recoveryRowsOf(claimed, drained, txnId, ctx));
  }
  return { legs, recovered: recovered.size > 0 ? recovered : null };
}

// Every accrual row a charge posting created is the original share row: seq 0, positive, and
// byte-equal to that seller's entry in the posting's sealed `shares` map. Anything else is an
// edited or fabricated row, and no leg derives from it.
function assertRowsMatchShares(
  rows: ReadonlyArray<AccrualRow>,
  posting: Posting,
): void {
  const shares = (posting.meta.shares ?? null) as Record<string, string> | null;
  for (const row of rows) {
    const expected = shares?.[row.sellerId];
    if (
      row.seq !== 0 ||
      expected === undefined ||
      BigInt(expected) !== row.amount.minor
    ) {
      throw fault(
        ERROR_CODES.CHAIN_BROKEN,
        'An accrual row does not match the share map sealed in its posting; refusing to reverse tampered history.',
        {
          retryable: false,
          detail: {
            orderId: row.orderId,
            sellerId: row.sellerId,
            seq: row.seq,
            txnId: posting.txnId,
          },
        },
      );
    }
  }
}

// One negative row per drained share, sequenced past the order's existing rows so the key stays
// unique. The drain recovers these against the seller's future shares before crediting earned.
function recoveryRowsOf(
  all: ReadonlyArray<AccrualRow>,
  drained: ReadonlyArray<AccrualRow>,
  txnId: string,
  ctx: Ctx,
): AccrualRow[] {
  const nextSeq = new Map<string, number>();
  for (const row of all) {
    const key = `${row.orderId}::${row.sellerId}`;
    nextSeq.set(key, Math.max(nextSeq.get(key) ?? 0, row.seq + 1));
  }
  // One shared stamp, so every recovery row of this refund sorts as one batch in claim order.
  const now = ctx.clock.now();
  return drained.map((row) => {
    const key = `${row.orderId}::${row.sellerId}`;
    const seq = nextSeq.get(key)!;
    nextSeq.set(key, seq + 1);
    return {
      orderId: row.orderId,
      sellerId: row.sellerId,
      seq,
      amount: toAmount('CREDIT', -row.amount.minor),
      shard: row.shard,
      status: 'pending',
      txnId,
      settledTxnId: null,
      recordedAt: now,
    };
  });
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
  recovered: ReadonlyMap<string, bigint> | null,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    kind: 'refund',
    orderId: operation.orderId,
    reversedTxnId: sale.txnId,
  };
  if (operation.reason !== undefined) {
    meta.reason = operation.reason;
  }
  // Sealed into this posting's chain hash: the per-seller amounts whose recovery rows carry this
  // txn id, so the drain can prove each negative row against the posting that created it.
  if (recovered !== null) {
    const map: Record<string, string> = {};
    for (const [sellerId, minor] of recovered) {
      map[sellerId] = minor.toString();
    }
    meta.recovered = map;
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
