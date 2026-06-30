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

import type { Ctx, Operation, Outcome, Transaction } from '#src/contract.ts';
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
  if (operation.kind !== 'cancelSubscription') {
    throw kindMismatch(operation);
  }

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

// Requires the caller to own the subscription, or to be privileged. A user actor may cancel
// only their own subscription. A system or operator principal may cancel any. The central
// authorize() cannot catch this. Cancel debits no user account, so its ownership rule has
// nothing to check, and cancel is not privileged-only, since users must cancel their own. The
// check therefore lives here, against the loaded record. Without it the handler would cancel
// whatever id was named regardless of caller, which is an IDOR. A system or operator principal
// returns immediately. A user passes only when their id matches the owner, else UNAUTHORIZED.
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

// Builds the placeholder transaction for a successful cancel. Cancel moves no money, but a
// committed outcome must still carry a transaction. This one gets a fresh `txn_` id and the
// current time, with empty legs (the debit and credit lines) and empty links (the per-account
// history-chain updates).
function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}

// Builds the fault for an operation of the wrong kind. Requests are routed here by kind, so a
// non-cancelSubscription operation arriving means something upstream is wired wrong. This
// throws a malformed-operation fault.
function kindMismatch(operation: Operation) {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handleCancelSubscription received a ${operation.kind} operation.`,
    { detail: { kind: operation.kind } },
  );
}
