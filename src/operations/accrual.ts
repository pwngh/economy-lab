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

/**
 * The accrual split's shared leg rewrite (config.accrualDrain): every earned-credit leg a charge
 * builds is redirected to SETTLEMENT_ACCRUAL, and the redirected shares come back per seller so
 * the caller can record one accrual row each. Spend, subscribe, and the renewal sweep all charge
 * through this, so the redirect rule lives once.
 */

import { toAmount } from '#src/money.ts';
import { SYSTEM, ownerOf, platformShard, walletKindOf } from '#src/accounts.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { AccrualRow, Leg } from '#src/ports.ts';

/**
 * Replaces each credit to a user's earned account with the same credit to SETTLEMENT_ACCRUAL and
 * sums the redirected amount per seller. Non-earned legs pass through untouched; the posting
 * stays balanced because only the account changes.
 */
export function parkEarnedLegs(legs: ReadonlyArray<Leg>): {
  legs: Leg[];
  shares: Map<string, bigint>;
} {
  const shares = new Map<string, bigint>();
  const parked = legs.map((leg) => {
    if (walletKindOf(leg.account) !== 'earned' || leg.amount.minor >= 0n) {
      return leg;
    }
    const sellerId = ownerOf(leg.account);
    shares.set(sellerId, (shares.get(sellerId) ?? 0n) - leg.amount.minor);
    return { ...leg, account: SYSTEM.SETTLEMENT_ACCRUAL };
  });
  return { legs: parked, shares };
}

/**
 * The share map as sealed posting metadata, `{sellerId: minorString}` — the entries mirror the
 * rows {@link accrualRowsOf} writes, and metadata rides the chain-hash preimage, so refund and
 * the drain can prove every unhashed accrual row against the posting that created it.
 */
export function sharesMeta(
  shares: ReadonlyMap<string, bigint>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [sellerId, minor] of shares) {
    if (minor > 0n) {
      map[sellerId] = minor.toString();
    }
  }
  return map;
}

/**
 * The pending rows a charge writes alongside its posting: one per seller share, on the ACCRUAL
 * shard the routing key resolves to — the same key the legs were routed with, so the drain debits
 * the row the posting credited.
 */
export function accrualRowsOf(input: {
  orderId: string;
  shares: ReadonlyMap<string, bigint>;
  routeKey: string;
  shards: number;
  txnId: string;
  recordedAt: number;
}): AccrualRow[] {
  const shard: AccountRef = platformShard(
    SYSTEM.SETTLEMENT_ACCRUAL,
    input.routeKey,
    input.shards,
  );
  const rows: AccrualRow[] = [];
  for (const [sellerId, minor] of input.shares) {
    if (minor <= 0n) {
      continue;
    }
    rows.push({
      orderId: input.orderId,
      sellerId,
      // First row per (orderId, sellerId); writers that add follow-up rows for the same pair
      // (refund recovery, drain residuals) allocate the next seq themselves.
      seq: 0,
      amount: toAmount('CREDIT', minor),
      shard,
      status: 'pending',
      txnId: input.txnId,
      settledTxnId: null,
      recordedAt: input.recordedAt,
    });
  }
  return rows;
}
