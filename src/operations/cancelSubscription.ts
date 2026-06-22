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
 * Cancel an active subscription. Status change only, no money moves: canceling forfeits the
 * rest of the paid billing period (no refund), so there is nothing to record in the ledger.
 *
 * Missing or already-canceled subscriptions return a `rejected` outcome with reason
 * `UNKNOWN_SUBSCRIPTION` rather than throwing, keeping routine cancel "no"s off error
 * dashboards.
 *
 * Ownership is enforced on the loaded subscription: an end user may cancel only their own; a
 * system service or operator may cancel anyone's. A user reaching for someone else's
 * subscription is a cross-tenant request (IDOR), so it throws `AUTH.UNAUTHORIZED` instead of
 * rejecting. The ownership check runs only after the subscription is confirmed to exist and
 * be cancelable, so probing a missing/already-canceled id gets the same `UNKNOWN_SUBSCRIPTION`
 * answer regardless of caller and never leaks existence.
 *
 * Otherwise it marks the subscription `CANCELED` and reports success with a placeholder
 * transaction recording no money moving (see {@link lifecycleMarker}).
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

// A blank or whitespace-only id is malformed client input, rejected up front as a client
// error rather than passed to the store (where it would degrade into the routine
// UNKNOWN_SUBSCRIPTION "no"). A non-blank id with no record still flows through to that
// UNKNOWN_SUBSCRIPTION outcome below.
function assertSubscriptionId(subscriptionId: string): void {
  if (subscriptionId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'cancelSubscription requires a non-empty subscriptionId.',
      { detail: { kind: 'cancelSubscription' } },
    );
  }
}

// Ownership guard. A user actor may cancel only their own subscription; system/operator
// principals may cancel any. The central authorize() can't catch this: cancel debits no user
// account, so its ownership rule has nothing to check, and cancel isn't privileged-only (users
// must cancel their own). So the check lives here, against the loaded record. Without it, the
// handler would cancel whatever id was named regardless of caller (an IDOR). System/operator
// returns immediately; a user passes only when their id matches the owner, else UNAUTHORIZED.
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

// Placeholder transaction for a successful cancel. Cancel moves no money but a committed
// outcome must still carry a transaction, so this gets a fresh `txn_` id and current time
// with empty legs (debit/credit lines) and empty links (per-account history-chain updates).
function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}

// Requests are routed here by kind, so a non-cancelSubscription operation arriving means
// something upstream is wired wrong. Throw a malformed-operation fault.
function kindMismatch(operation: Operation) {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handleCancelSubscription received a ${operation.kind} operation.`,
    { detail: { kind: operation.kind } },
  );
}
