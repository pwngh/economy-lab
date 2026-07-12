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

import type { CanonicalPurchase } from '@pwngh/economy-edge';
import type { Operation } from '#src/contract.ts';
import type { Amount } from '#src/money.ts';

export function purchaseTopUpKey(
  provider: string,
  providerTxnId: string,
): string {
  return `iap:${provider}:${providerTxnId}`;
}

export function edgePurchaseTopUp(
  purchase: CanonicalPurchase,
  input: { userId: string; amount: Amount },
): Operation {
  return {
    kind: 'topUp',
    idempotencyKey: purchaseTopUpKey(purchase.provider, purchase.providerTxnId),
    actor: { kind: 'system', service: `edge:${purchase.provider}` },
    userId: input.userId,
    amount: input.amount,
    source: purchase.provider,
    meta: {
      provider: purchase.provider,
      providerTxnId: purchase.providerTxnId,
      sku: purchase.providerSku,
      sourceRef: purchase.sourceRef,
    },
  } as unknown as Operation;
}
