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

import type { Handler, Operation } from '#src/contract.ts';

/**
 * Lookup table from an operation's `kind` (the string tag that says what the operation is,
 * e.g. `'topUp'` or `'spend'`) to the function that carries it out. When `economy.ts`
 * receives an operation, it reads this table to find the right handler.
 *
 * The `satisfies Record<Operation['kind'], Handler>` at the end forces the table to have one
 * entry for every possible operation kind. If someone adds a new kind to the `Operation` type
 * but forgets to register a handler for it, this line fails to compile — so the gap is caught
 * while building rather than as an error at runtime when that operation is first submitted.
 *
 * Most keys match the name of the imported handler, so a bare name like `topUp` suffices. A
 * few handlers are exported under `handle…` names (`handleClawback`, `handleSubscribe`,
 * `handleCancelSubscription`); those are written `kind: handler` so the table key is still the
 * operation's kind.
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
} satisfies Record<Operation['kind'], Handler>;
