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
 * Cancel an active subscription. This only changes the subscription's status; it moves no
 * money. Canceling forfeits whatever the user already paid for the rest of the current
 * billing period — none of it is refunded — so there is nothing to record in the ledger.
 *
 * It looks the subscription up by id. If there is no such subscription, or it is already
 * canceled, that is a normal "no" the caller can handle: it returns a `rejected` outcome
 * with reason `UNKNOWN_SUBSCRIPTION`, rather than throwing an error. (Cancel "no"s are
 * routine, so keeping them out of the thrown-error path keeps them off error dashboards.)
 *
 * Ownership is enforced on the loaded subscription: an end user may cancel only their OWN
 * subscription. A system service or human operator may cancel anyone's. Unlike the
 * missing-subscription "no", a user reaching for someone else's subscription is not a
 * routine business answer — it is a forbidden cross-tenant request (an IDOR attempt) — so
 * it throws an `AUTH.UNAUTHORIZED` fault rather than returning a rejection. The ownership
 * check runs only AFTER the subscription is confirmed to exist and be cancelable, so a
 * probe for a missing or already-canceled id still gets the same `UNKNOWN_SUBSCRIPTION`
 * answer regardless of caller and never leaks whether such a subscription exists.
 *
 * Otherwise it marks the subscription `CANCELED` and reports success with a placeholder
 * transaction that records no money moving (see {@link lifecycleMarker}).
 *
 * Covered by `test/operations/cancelSubscription.test.ts` and
 * `test/operations/cancelSubscription.submit.test.ts`.
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

// A cancel names the subscription to cancel by id. A blank or whitespace-only id is not a
// genuine lookup the store could ever satisfy — it is malformed client input, so it is rejected
// up front as a programming/client error rather than being passed to the store, where it would
// degrade into the routine UNKNOWN_SUBSCRIPTION "no". A non-blank id that simply has no record
// still flows through to that UNKNOWN_SUBSCRIPTION outcome below.
function assertSubscriptionId(subscriptionId: string): void {
  if (subscriptionId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'cancelSubscription requires a non-empty subscriptionId.',
      { detail: { kind: 'cancelSubscription' } },
    );
  }
}

// Ownership guard. An end-user actor may cancel only the subscription they own; a system or
// operator principal may cancel any. Without this, the handler would honor the request for
// whatever subscription id was named regardless of who asked, letting one user cancel
// another's subscription (an IDOR). The central authorize() can't catch this: cancel debits
// no user account, so its ownership rule has nothing to check, and cancel is deliberately NOT
// privileged-only (users must cancel their own). So the check lives here, against the loaded
// record. A system/operator actor returns immediately; a user is allowed through only when
// their id matches the subscription's owner, and otherwise it throws an UNAUTHORIZED fault.
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

// Builds the placeholder transaction returned on a successful cancel. Canceling moves no
// money, but a committed outcome must still carry a transaction. So this one gets a fresh
// `txn_` id and the current time, but its list of debit/credit lines and its list of
// per-account history-chain updates are both empty, because nothing was actually posted.
function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}

// Sanity check for a programming error. Requests are routed to this handler by kind, so
// a non-cancelSubscription operation arriving here means something upstream is wired
// wrong. Rather than mishandle it silently, throw a malformed-operation fault.
function kindMismatch(operation: Operation) {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handleCancelSubscription received a ${operation.kind} operation.`,
    { detail: { kind: operation.kind } },
  );
}
