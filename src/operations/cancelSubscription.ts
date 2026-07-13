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

import { rejected, fault, ERROR_CODES } from '#src/errors.ts';
import { assertKind, lifecycleMarker } from '#src/operations/guards.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Subscription, Unit } from '#src/ports.ts';

/**
 * Cancels an active subscription. A status change only, moving no money (cancel forfeits the rest
 * of the paid period with no refund), so it posts a placeholder {@link lifecycleMarker}, marks the
 * record `CANCELED`, and returns `committed`.
 *
 * A missing or already-canceled subscription returns a `rejected` `UNKNOWN_SUBSCRIPTION` rather
 * than throwing. The ownership check runs only after the record is confirmed cancelable, so a
 * missing or canceled id gets that same answer for every caller and never leaks whether it exists.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/cancel-subscription/
 *   Cancel subscription} for the cancel flow and ownership rules.
 */
export async function cancelSubscription(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'cancelSubscription');

  assertSubscriptionId(operation.subscriptionId);

  const subscription = await unit.subscriptions.load(operation.subscriptionId);
  if (subscription === null || subscription.state === 'CANCELED') {
    return rejected('UNKNOWN_SUBSCRIPTION', {
      subscriptionId: operation.subscriptionId,
    });
  }

  assertMayCancel(operation, subscription);

  await unit.subscriptions.cancel(operation.subscriptionId);

  return { status: 'committed', transaction: lifecycleMarker(ctx) };
}

// A blank id is malformed client input, so it throws up front; a non-blank id with no matching
// record still flows to the UNKNOWN_SUBSCRIPTION rejection below.
function assertSubscriptionId(subscriptionId: string): void {
  if (subscriptionId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'cancelSubscription requires a non-empty subscriptionId.',
      { detail: { kind: 'cancelSubscription' } },
    );
  }
}

// The central authorize() can't catch this because cancel debits no user account, so the
// ownership check lives here against the loaded record; without it any caller could cancel any
// named id. See
// https://economy-lab-docs.pages.dev/economy/reference/operations/cancel-subscription/ for the
// ownership rules.
function assertMayCancel(
  operation: Extract<Operation, { kind: 'cancelSubscription' }>,
  subscription: Subscription,
): void {
  const actor = operation.actor;
  if (actor.kind !== 'user') {
    return;
  }
  if (actor.userId !== subscription.userId) {
    throw fault(
      ERROR_CODES.UNAUTHORIZED,
      'A user may cancel only their own subscription.',
      {
        detail: {
          kind: operation.kind,
          actor: actor.kind,
          subscriptionId: operation.subscriptionId,
        },
      },
    );
  }
}
