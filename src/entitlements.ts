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

import { byCodeUnit } from '#src/bytes.ts';

import type { EntitlementGrant } from '#src/ports.ts';

/**
 * The grant source a purchase stamps. Refund and the instance lane's rejection backstop revoke
 * exactly this string, so the two sides can never drift into a revoke that matches no grant.
 */
export function saleSource(orderId: string): string {
  return `sale:${orderId}`;
}

/**
 * The grant source a subscription stamps, on the first charge and on every renewal alike. A lapse
 * revokes exactly this string, so a second seller's subscription to the same sku keeps its perk.
 */
export function subscriptionSource(subscriptionId: string): string {
  return `subscription:${subscriptionId}`;
}

/** One stored entitlement row, before the per-sku collapse. */
export interface EntitlementRowRef {
  sku: string;

  /** The `attrs.source` this grant was stamped with; the empty string when unattributed. */
  source: string;

  expiresAt: number | null;
}

/**
 * Folds a user's live entitlement rows into one {@link EntitlementGrant} per sku.
 *
 * A sku granted by several sources is owned while any one of them is live, so the row carries the
 * longest expiry: a null (perpetual) source wins outright, otherwise the largest `expiresAt`.
 * Skus and sources both sort by code unit, in application code rather than in SQL, so every engine
 * lists identically whatever collation the database was created with.
 *
 * Revoked rows are the caller's to filter — every store's query already excludes them.
 *
 * @example
 * collapseEntitlementGrants([
 *   { sku: 'gold_trim', source: 'sale:ord_2', expiresAt: 1_000 },
 *   { sku: 'gold_trim', source: 'sale:ord_1', expiresAt: null },
 * ]);
 * // [{ sku: 'gold_trim', expiresAt: null, sources: ['sale:ord_1', 'sale:ord_2'] }]
 */
export function collapseEntitlementGrants(
  rows: Iterable<EntitlementRowRef>,
): EntitlementGrant[] {
  const bySku = new Map<
    string,
    { expiresAt: number | null; sources: string[] }
  >();
  for (const row of rows) {
    const grant = bySku.get(row.sku);
    if (grant === undefined) {
      bySku.set(row.sku, { expiresAt: row.expiresAt, sources: [row.source] });
      continue;
    }
    grant.sources.push(row.source);
    if (grant.expiresAt !== null) {
      grant.expiresAt =
        row.expiresAt === null
          ? null
          : Math.max(grant.expiresAt, row.expiresAt);
    }
  }
  return [...bySku]
    .map(([sku, grant]) => ({
      sku,
      expiresAt: grant.expiresAt,
      sources: grant.sources.sort(byCodeUnit),
    }))
    .sort((a, b) => byCodeUnit(a.sku, b.sku));
}
