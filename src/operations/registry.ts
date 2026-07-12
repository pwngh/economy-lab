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
import { spend, spendPreClaim } from '#src/operations/spend.ts';
import { refund } from '#src/operations/refund.ts';
import { clawback } from '#src/operations/clawback.ts';
import { requestPayout } from '#src/operations/requestPayout.ts';
import { subscribe } from '#src/operations/subscribe.ts';
import { cancelSubscription } from '#src/operations/cancelSubscription.ts';
import {
  grantEntitlement,
  revokeEntitlement,
} from '#src/operations/entitlements.ts';
import { grantPromo } from '#src/operations/promo.ts';
import { adjust } from '#src/operations/adjust.ts';
import { reverse } from '#src/operations/reverse.ts';
import { reversePayout } from '#src/operations/reversePayout.ts';
import { settlePayout } from '#src/operations/settlePayout.ts';

import type { Handler, Operation, Outcome } from '#src/contract.ts';
import type { Unit } from '#src/ports.ts';

/**
 * Maps each operation's `kind` to its handler. The `economy.ts` submit path looks up handlers here.
 *
 * The `satisfies Record<Operation['kind'], Handler>` clause forces exactly one entry per kind. Add a
 * kind to `Operation` without registering a handler and the file fails to compile, rather than
 * throwing at runtime on the first submit of that kind.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/the-economy/ The Economy} for the
 * submit entry point that dispatches through this registry.
 */
/** A kind's early duplicate probe: a non-null outcome ends the request before locks or screens. */
export type PreClaim = (
  operation: Operation,
  unit: Unit,
) => Promise<Outcome | null>;

/**
 * Kinds whose domain-level duplicate is decidable before any lock (the deciding row is final once
 * written). The submit path runs the probe right after the idempotency claim, so a replay costs
 * two reads instead of the full lock-and-screen prologue.
 */
export const PRE_CLAIMS: Partial<Record<Operation['kind'], PreClaim>> = {
  spend: spendPreClaim,
};

export const REGISTRY = {
  topUp,
  spend,
  refund,
  clawback,
  requestPayout,
  subscribe,
  cancelSubscription,
  grantEntitlement,
  revokeEntitlement,
  grantPromo,
  adjust,
  reverse,
  reversePayout,
  settlePayout,
} satisfies Record<Operation['kind'], Handler>;
