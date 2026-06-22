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

import type { AccountRef } from '#src/accounts.ts';
import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Leg, Posting, Unit } from '#src/ports.ts';

/**
 * Undo an earlier transaction by posting its exact opposite. Operator-only manual correction:
 * look up the transaction named by `operation.txnId`, then post a new transaction with the same
 * legs but every amount's sign flipped. Locks each account the original touched before posting.
 *
 * Returns a `committed` Outcome carrying the reversing transaction. Four caller mistakes throw an
 * `OP.MALFORMED` fault: a non-operator actor, a blank reason, an unknown `txnId`, or a `txnId`
 * that names a reversal (reversing a reversal just loops money back out and in).
 *
 * A transaction is reversed at most once: stakes the shared `reversed:${txnId}` key (same pattern
 * refund and clawback use for `reversed:${orderId}`). A second reverse loses the claim and returns
 * the first reversal's transaction as `duplicate`, moving no money again.
 *
 * @example
 *   let outcome = await reverse(
 *     { kind: 'reverse', idempotencyKey: 'idem_0',
 *       actor: { kind: 'operator', operatorId: 'op_1' },
 *       txnId: 'txn_1', reason: 'reconciliation: duplicate posting' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; every leg of txn_1 posted with its sign flipped.
 */
export async function reverse(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'reverse') {
    throw kindMismatch(operation);
  }
  assertOperator(operation);
  assertReason(operation.reason);

  let original = await loadPosting(unit, operation.txnId);
  assertNotReversal(operation, original);
  await extendLocks(unit, original.legs);

  // Stake the per-transaction key before posting so a txnId is reversed at most once. First
  // reverse claims it and posts the inverse; a second loses the claim and gets the first
  // reversal's transaction back as a duplicate. Mirrors refund/clawback staking
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

// Per-transaction idempotency key a reverse stakes so a transaction is reversed at most once.
// Same `reversed:${id}` family refund and clawback use, here scoped to the transaction undone.
function reversalKey(txnId: string): string {
  return `reversed:${txnId}`;
}

// Look up the transaction to undo. The operator typed this id, so an unknown one is operator
// error: throw a fault. (Compare `refund`, where an unknown order id is an everyday caller "no".)
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

// A reversal must never be reversed: it would loop the same money out and in with no net effect,
// and let an operator chain reversals to flip a balance at will. A reversal records
// `kind: 'reverse'` in its metadata (see `reverseMeta`), so reject any txnId whose posting carries
// that marker. Operator mistake, so it throws a fault, same as an unknown txnId.
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

// Lock every account the original touched so no other operation changes those balances while
// this reversal posts. The framework only locks accounts named in the request, but a reverse
// request carries just a txnId, so the handler discovers and locks them from the loaded
// transaction. The Set skips an account that appears on more than one leg.
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

// Opposite of each leg: same account, sign flipped (`neg` from money.ts). The original's legs
// already sum to zero per currency, so flipping every sign keeps that sum at zero and the
// reversal balances without recomputing anything.
function reverseLegs(legs: ReadonlyArray<Leg>): Leg[] {
  return legs.map((leg) => ({ account: leg.account, amount: neg(leg.amount) }));
}

// Metadata stored with the reversing transaction: which transaction it undoes and the operator's
// reason, kept so an audit can see who undid what and why. No amounts here; those live on the legs.
function reverseMeta(
  operation: Extract<Operation, { kind: 'reverse' }>,
): Record<string, unknown> {
  return {
    kind: 'reverse',
    txnId: operation.txnId,
    reason: operation.reason,
  };
}

// Only an operator may run a reverse. The framework checks this before the handler runs, but the
// handler rechecks so it's safe when called directly (e.g. from a test): a non-operator caller
// throws a fault instead of performing this privileged write.
function assertOperator(
  operation: Extract<Operation, { kind: 'reverse' }>,
): void {
  if (operation.actor.kind !== 'operator') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse requires an operator principal.',
      { detail: { kind: operation.kind, actor: operation.actor.kind } },
    );
  }
}

// A reversal must record why it happened. Reject a missing or whitespace-only reason so none is
// posted without a justification for the audit trail.
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse requires a non-empty reason.',
      { detail: { kind: 'reverse' } },
    );
  }
}

// Operations are routed by `kind`, so this handler should only receive a `reverse`. Any other
// kind means a wiring bug; throw a fault rather than handle an operation it wasn't built for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
