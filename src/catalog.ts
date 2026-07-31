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

import type { Operation, Recipient, RejectionDetail } from '#src/contract.ts';
import type { CatalogPort } from '#src/ports.ts';

/**
 * The one price check. It lives apart from both `submit` and the HTTP edge because both call
 * it: a second implementation is how a door came to accept a client's own price.
 *
 * The order of checks names the most actionable disagreement: an unlisted sku first, then the
 * price, then the split. Share order is irrelevant, so both sides compare sorted.
 */
export async function catalogMismatch(
  catalog: CatalogPort,
  spend: Extract<Operation, { kind: 'spend' }>,
): Promise<RejectionDetail | null> {
  const mismatch = (field: 'sku' | 'price' | 'recipients') =>
    ({ reason: 'CATALOG_MISMATCH', sku: spend.sku, field }) as const;
  const offer = await catalog.lookup(spend.sku);
  if (offer === null) {
    return mismatch('sku');
  }
  if (
    offer.price.currency !== spend.price.currency ||
    offer.price.minor !== spend.price.minor
  ) {
    return mismatch('price');
  }
  const shares = (list: ReadonlyArray<Recipient>) =>
    [...list]
      .map((r) => `${r.sellerId}:${r.shareBps}`)
      .sort()
      .join(',');
  if (shares(offer.recipients) !== shares(spend.recipients)) {
    return mismatch('recipients');
  }
  return null;
}
