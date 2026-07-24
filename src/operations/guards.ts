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

import { ERROR_CODES, fault } from '#src/errors.ts';
import { verifiedPosting } from '#src/chain.ts';
import { earned } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';

import type { Amount } from '#src/money.ts';
import type { Ctx, Operation, Recipient, Transaction } from '#src/contract.ts';
import type { Digest, Ledger, Saga, Subscription, Unit } from '#src/ports.ts';

/**
 * Narrows `operation` to the expected `kind`. A mismatch means the dispatch is miswired, so it
 * throws a fault rather than process an operation it cannot handle.
 */
export function assertKind<K extends Operation['kind']>(
  operation: Operation,
  kind: K,
): asserts operation is Extract<Operation, { kind: K }> {
  if (operation.kind !== kind) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `Handler received the wrong operation kind: ${operation.kind}.`,
      { detail: { kind: operation.kind, expected: kind } },
    );
  }
}

/**
 * Requires an operator principal. The submit pipeline already authorizes the actor (authorize in
 * economy.ts), so re-checking here matters only when a handler is called directly, such as from a
 * test. It throws rather than write a privileged change under the wrong actor.
 */
export function assertOperator(operation: Operation): void {
  if (operation.actor.kind !== 'operator') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${operation.kind} requires an operator principal.`,
      { detail: { kind: operation.kind, actor: operation.actor.kind } },
    );
  }
}

/**
 * Requires a non-blank reason on a manual correction, because a correction must record why for
 * auditability. A missing or blank reason is malformed and throws before anything posts.
 */
export function assertReason(
  operation: Extract<Operation, { reason: string }>,
): void {
  if (operation.reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${operation.kind} requires a non-empty reason.`,
      { detail: { kind: operation.kind } },
    );
  }
}

/**
 * The recipient-share law, shared by spend and the instance lane's purchase: at least one
 * recipient, no recipient who is the buyer, no sellerId twice, each share in (0, 10000] basis
 * points, and shares summing to exactly 10000. The sum check alone is not enough — shares like
 * [-5000, 15000] still sum to 10000, but a negative share is a hidden debit and a >100% share
 * pays out more of the part than exists. A buyer who is also a recipient would convert their own
 * non-payable credit into payable earned credit funded by the house, so it is a fault, not a
 * business "no". `what` names the operation in messages; `detail` is merged into every fault.
 */
export function assertRecipientShares(
  recipients: ReadonlyArray<Recipient>,
  buyerId: string,
  what: string,
  detail: Record<string, string | number> = {},
): void {
  if (recipients.length === 0) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `A ${what} names at least one recipient.`,
      { detail },
    );
  }
  let total = 0;
  const seen = new Set<string>();
  for (const recipient of recipients) {
    if (recipient.sellerId === buyerId) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        `A ${what} recipient may not be the buyer (self-dealing).`,
        { detail: { ...detail, buyerId } },
      );
    }
    if (seen.has(recipient.sellerId)) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        `A ${what} may not name the same sellerId twice.`,
        { detail: { ...detail, sellerId: recipient.sellerId } },
      );
    }
    seen.add(recipient.sellerId);
    if (recipient.shareBps <= 0 || recipient.shareBps > 10_000) {
      throw fault(
        ERROR_CODES.MALFORMED_OPERATION,
        'Each recipient share must be > 0 and <= 10000 basis points.',
        {
          detail: {
            ...detail,
            sellerId: recipient.sellerId,
            shareBps: recipient.shareBps,
          },
        },
      );
    }
    total += recipient.shareBps;
  }
  if (total !== 10_000) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'Recipient shareBps must sum to 10000.',
      { detail: { ...detail, total } },
    );
  }
}

/**
 * Loads the saga a payout operation names by `sagaId`. An operator or webhook mapping supplied the
 * id, so a missing saga is a caller error: it throws a fault rather than treating the miss as a
 * quiet "nothing to do", matching reverse's unknown-txnId handling.
 */
export async function loadSaga(
  unit: Unit,
  operation: Extract<Operation, { sagaId: string }>,
): Promise<Saga> {
  const saga = await unit.sagas.load(operation.sagaId);
  if (saga === null) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      `${operation.kind} names a payout that does not exist.`,
      { detail: { kind: operation.kind, sagaId: operation.sagaId } },
    );
  }
  return saga;
}

/**
 * Builds the `reversed:<id>` idempotency key that marks an order or transaction as undone. Refund
 * and clawback stake it per orderId, which keeps the two reversal paths mutually exclusive, and
 * reverse stakes it per txnId; one builder keeps the key family identical across all three.
 */
export function reversalKey(id: string): string {
  return `reversed:${id}`;
}

/**
 * Receipt for an operation that changes state but moves no money: a committed result must carry a
 * Transaction, so this returns one with empty legs and links.
 */
export function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
    meta: {},
  };
}

/**
 * Receipt for the already-handled path: nothing posted this run and the original receipt is not
 * at hand, so return an empty marker rather than mint a fresh id for money that did not move.
 */
export function noopTransaction(): Transaction {
  return { id: '', postedAt: 0, legs: [], links: [], meta: {} };
}

/**
 * Re-proves a payout saga against the reserve posting it opened with, before any step trusts the
 * unhashed row: the posting itself re-derives (verifiedPosting), its sealed metadata must name
 * this saga, rate, and USD quote exactly, and its earned-debit leg must carry the reserve. Every
 * money-moving step — the worker's submit, settle, reverse — calls this first, so an edited or
 * fabricated saga row faults CHAIN_BROKEN instead of wiring USD out.
 */
export async function assertSagaAnchored(
  deps: { ledger: Ledger; digest: Digest },
  saga: Saga,
): Promise<Amount> {
  const unanchored = (): Error =>
    fault(
      ERROR_CODES.CHAIN_BROKEN,
      'A payout saga does not re-derive from its reserve posting; refusing to move money for an unverifiable saga.',
      {
        retryable: false,
        detail: { sagaId: saga.id, txnId: saga.txnId, userId: saga.userId },
      },
    );
  const posting = await verifiedPosting(deps, saga.txnId);
  if (posting === null || saga.payoutUsd === null) {
    throw unanchored();
  }
  const meta = posting.meta;
  const reserveLeg = posting.legs.find(
    (leg) => leg.account === earned(saga.userId),
  );
  if (
    meta.kind !== 'requestPayout' ||
    meta.sagaId !== saga.id ||
    meta.rateId !== saga.rateId ||
    meta.payoutUsd !== encodeAmount(saga.payoutUsd) ||
    reserveLeg === undefined ||
    reserveLeg.amount.minor !== saga.reserve.minor
  ) {
    throw unanchored();
  }
  return saga.payoutUsd;
}

/**
 * Re-proves a subscription against the first-charge posting it opened with, before a renewal
 * charges by the unhashed row. A row whose id, user, seller, price, or period no longer matches
 * the sealed metadata faults CHAIN_BROKEN instead of shaping the charge — and the anchor is
 * required, because a nullable one would be an anchor the attacker can remove.
 */
export async function assertSubscriptionAnchored(
  deps: { ledger: Ledger; digest: Digest },
  sub: Subscription,
): Promise<void> {
  const unanchored = (): Error =>
    fault(
      ERROR_CODES.CHAIN_BROKEN,
      'A subscription does not re-derive from its first-charge posting; refusing to renew from an unverifiable row.',
      {
        retryable: false,
        detail: { subscriptionId: sub.id, txnId: sub.txnId },
      },
    );
  const posting = await verifiedPosting(deps, sub.txnId);
  if (posting === null) {
    throw unanchored();
  }
  const meta = posting.meta;
  if (
    meta.kind !== 'subscribe' ||
    meta.subscriptionId !== sub.id ||
    meta.userId !== sub.userId ||
    meta.sellerId !== sub.sellerId ||
    meta.price !== encodeAmount(sub.price) ||
    meta.periodMs !== sub.periodMs
  ) {
    throw unanchored();
  }
}
