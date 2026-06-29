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

import { topUp } from '#src/operations/topUp.ts';
import { spend } from '#src/operations/spend.ts';
import { refund } from '#src/operations/refund.ts';
import { handleClawback } from '#src/operations/clawback.ts';
import { requestPayout } from '#src/operations/requestPayout.ts';
import { handleSubscribe } from '#src/operations/subscribe.ts';
import { handleCancelSubscription } from '#src/operations/cancelSubscription.ts';
import {
  grantEntitlement,
  revokeEntitlement,
} from '#src/operations/entitlements.ts';
import { grantPromo } from '#src/operations/promo.ts';
import { adjust } from '#src/operations/adjust.ts';
import { reverse } from '#src/operations/reverse.ts';
import { reversePayout } from '#src/operations/reversePayout.ts';
import { settlePayout } from '#src/operations/settlePayout.ts';

import type { Handler, Operation } from '#src/contract.ts';

/**
 * Maps an operation's `kind` to its handler; `economy.ts` looks up handlers here.
 *
 * `satisfies Record<Operation['kind'], Handler>` forces one entry per kind: add a kind to
 * `Operation` without registering a handler and this fails to compile rather than throwing at
 * runtime on first submit.
 *
 * Most keys match the imported handler name. A few handlers are exported as `handle…`
 * (`handleClawback`, `handleSubscribe`, `handleCancelSubscription`), written `kind: handler` so
 * the key stays the operation's kind.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * submit entry point that dispatches through this registry.
 */
export const REGISTRY = {
  topUp,
  spend,
  refund,
  clawback: handleClawback,
  requestPayout,
  subscribe: handleSubscribe,
  cancelSubscription: handleCancelSubscription,
  grantEntitlement,
  revokeEntitlement,
  grantPromo,
  adjust,
  reverse,
  reversePayout,
  settlePayout,
} satisfies Record<Operation['kind'], Handler>;
