/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// Every symbol is a lab re-export, never a redefinition. Who is calling comes from
// `@pwngh/economy-auth`; what an operation is worth comes from `@pwngh/economy-money`.
export {
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
  idempotencyKey,
} from '@pwngh/economy-lab';
export {
  isRejection,
  requireSuccess,
  EconomyError,
  spendable,
} from '@pwngh/economy-lab';
export type {
  Amount,
  Operation,
  Outcome,
  Success,
  Rejection,
  Economy,
} from '@pwngh/economy-lab';
