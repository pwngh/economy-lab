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
 * Cancels an active subscription. This is a status change only and moves no money. Canceling
 * forfeits the rest of the paid billing period and gives no refund, so there is nothing to
 * record in the ledger.
 *
 * A missing or already-canceled subscription returns a `rejected` outcome with reason
 * `UNKNOWN_SUBSCRIPTION` instead of throwing. This keeps routine cancel "no" answers off error
 * dashboards.
 *
 * Ownership is enforced on the loaded subscription. An end user may cancel only their own
 * subscription. A system service or operator may cancel anyone's. A user reaching for someone
 * else's subscription is a cross-tenant request (IDOR), so it throws `AUTH.UNAUTHORIZED`
 * instead of rejecting. The ownership check runs only after the subscription is confirmed to
 * exist and be cancelable. Probing a missing or already-canceled id therefore gets the same
 * `UNKNOWN_SUBSCRIPTION` answer regardless of caller, which never leaks whether the id exists.
 *
 * On success it marks the subscription `CANCELED` and reports a placeholder transaction that
 * records no money moving (see {@link lifecycleMarker}).
 *
 * Covered by `test/operations/cancelSubscription.test.ts` and
 * `test/operations/cancelSubscription.submit.test.ts`.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/cancel-subscription/ Cancel subscription} for the cancel flow and ownership rules.
 */
export async function handleCancelSubscription(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'cancelSubscription');

  assertSubscriptionId(operation.subscriptionId);

  let subscription = await unit.subscriptions.load(operation.subscriptionId);
  if (subscription === null || subscription.state === 'CANCELED') {
    return rejected('UNKNOWN_SUBSCRIPTION', {
      subscriptionId: operation.subscriptionId,
    });
  }

  assertMayCancel(operation, subscription);

  await unit.subscriptions.cancel(operation.subscriptionId);

  return { status: 'committed', transaction: lifecycleMarker(ctx) };
}

// Requires a non-blank subscription id. A blank or whitespace-only id is malformed client
// input, so it throws a client error up front rather than reaching the store. Passing it to
// the store would degrade it into the routine UNKNOWN_SUBSCRIPTION "no" answer. A non-blank id
// with no matching record still flows through to that UNKNOWN_SUBSCRIPTION outcome below.
function assertSubscriptionId(subscriptionId: string): void {
  if (subscriptionId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'cancelSubscription requires a non-empty subscriptionId.',
      { detail: { kind: 'cancelSubscription' } },
    );
  }
}

// Requires the caller to own the subscription, or to be privileged. The central authorize()
// cannot catch this because cancel debits no user account, so the ownership check lives here
// against the loaded record; without it the handler would cancel any named id, an IDOR. A system
// or operator principal returns immediately. A user passes only when their id matches the owner,
// else UNAUTHORIZED.
// See https://economy-lab-docs.pages.dev/economy/reference/operations/cancel-subscription/ for the ownership rules and why the central check can't enforce them.
function assertMayCancel(
  operation: Extract<Operation, { kind: 'cancelSubscription' }>,
  subscription: Subscription,
): void {
  let actor = operation.actor;
  if (actor.kind !== 'user') {
    return;
  }
  if (actor.userId !== subscription.userId) {
    throw fault(
      ERROR_CODES.UNAUTHORIZED,
      'a user may cancel only their own subscription.',
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
