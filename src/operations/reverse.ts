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
import { postEntry } from '#src/ledger.ts';
import { neg } from '#src/money.ts';
import { assertKind, assertOperator } from '#src/operations/guards.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Posting, Unit } from '#src/ports.ts';

/**
 * Undoes an earlier transaction by posting its exact opposite. This is an operator-only manual
 * correction. It looks up the transaction named by `operation.txnId`, then posts a new transaction
 * with the same legs but every amount's sign flipped. It locks each account the original touched
 * before posting.
 *
 * Returns a `committed` Outcome carrying the reversing transaction. Four caller mistakes throw an
 * `OP.MALFORMED` fault: a non-operator actor, a blank reason, an unknown `txnId`, or a `txnId`
 * that names a reversal. Reversing a reversal just loops the money back out and in.
 *
 * A transaction is reversed at most once. The handler stakes the shared `reversed:${txnId}` key,
 * the same pattern refund and clawback use for `reversed:${orderId}`. The first reverse claims the
 * key and posts the inverse. A second reverse loses the claim and returns the first reversal's
 * transaction as a `duplicate`, moving no money again.
 *
 * @example
 *   let outcome = await reverse(
 *     { kind: 'reverse', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       txnId: 'txn_1', reason: 'reconciliation: duplicate posting' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; every leg of txn_1 posted with its sign flipped.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/reverse/ Reverse} for the operator-only undo-by-inverse correction flow.
 */
export async function reverse(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'reverse');
  assertOperator(operation);
  assertReason(operation.reason);

  let original = await loadPosting(unit, operation.txnId);
  assertNotReversal(operation, original);
  await extendLocks(unit, original.legs);

  // Stake the per-transaction key before posting so a txnId is reversed at most once. The first
  // reverse claims it and posts the inverse. A second loses the claim and gets the first reversal's
  // transaction back as a duplicate. This mirrors how refund and clawback stake
  // `reversed:${orderId}`. The claim lives inside this posting's db transaction, so a rollback
  // releases it and a retry succeeds.
  let claimKey = reversalKey(operation.txnId);
  let claim = await unit.idempotency.claim(claimKey);
  if (!claim.claimed) {
    return { status: 'duplicate', transaction: claim.transaction };
  }

  let transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs: reverseLegs(original.legs),
    meta: reverseMeta(operation),
  });

  // Record the reversal under the same key so a later reverse resolves to this transaction as
  // its duplicate. Written inside the posting's transaction, so it only takes effect on commit.
  await unit.idempotency.record(claimKey, transaction);

  return { status: 'committed', transaction };
}

// Builds the per-transaction idempotency key a reverse stakes so a transaction is reversed at most
// once. This is the same `reversed:${id}` family refund and clawback use, here scoped to the
// transaction being undone.
function reversalKey(txnId: string): string {
  return `reversed:${txnId}`;
}

// Loads the transaction to undo. The operator typed this id, so an unknown one is operator error
// and throws a fault. Compare `refund`, where an unknown order id is an everyday caller decline.
async function loadPosting(unit: Unit, txnId: string): Promise<Posting> {
  let posting = await unit.ledger.posting(txnId);
  if (posting === null) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse names a posting that does not exist.',
      { detail: { kind: 'reverse', txnId } },
    );
  }
  return posting;
}

// Rejects a txnId that names a reversal. A reversal must never be reversed. It would loop the same
// money out and in with no net effect, and it would let an operator chain reversals to flip a
// balance at will. A reversal records `kind: 'reverse'` in its metadata (see `reverseMeta`), so
// this rejects any posting carrying that marker. This is an operator mistake, so it throws a fault,
// the same as an unknown txnId.
function assertNotReversal(
  operation: Extract<Operation, { kind: 'reverse' }>,
  original: Posting,
): void {
  if (original.meta.kind === 'reverse') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse cannot undo a reversal.',
      { detail: { kind: 'reverse', txnId: operation.txnId } },
    );
  }
}

// Locks every account the original touched so no other operation changes those balances while this
// reversal posts. The framework only locks accounts named in the request, but a reverse request
// carries just a txnId, so the handler discovers and locks them from the loaded transaction. The
// Set skips an account that appears on more than one leg.
async function extendLocks(
  unit: Unit,
  legs: ReadonlyArray<Leg>,
): Promise<void> {
  let seen = new Set<AccountRef>();
  for (let leg of legs) {
    if (!seen.has(leg.account)) {
      seen.add(leg.account);
      await unit.ledger.lock(leg.account);
    }
  }
}

// Builds the opposite of each leg: same account, sign flipped (`neg` from money.ts). The original's
// legs already sum to zero per currency, so flipping every sign keeps that sum at zero. The
// reversal balances without recomputing anything.
function reverseLegs(legs: ReadonlyArray<Leg>): Leg[] {
  return legs.map((leg) => ({ account: leg.account, amount: neg(leg.amount) }));
}

// Builds the metadata stored with the reversing transaction: which transaction it undoes and the
// operator's reason. An audit uses this to see who undid what and why. No amounts live here;
// those are on the legs.
function reverseMeta(
  operation: Extract<Operation, { kind: 'reverse' }>,
): Record<string, unknown> {
  return {
    kind: 'reverse',
    txnId: operation.txnId,
    reason: operation.reason,
  };
}

// Requires a non-blank reason. A reversal must record why it happened. This rejects a missing or
// whitespace-only reason so none is posted without a justification for the audit trail.
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse requires a non-empty reason.',
      { detail: { kind: 'reverse' } },
    );
  }
}
