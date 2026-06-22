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
 * Undo one earlier transaction by posting its exact opposite. This is a manual correction a
 * human operator runs by hand (ordinary users can't); it looks up the transaction named by
 * `operation.txnId`, then writes a new transaction with the same debit and credit lines but
 * every amount's sign flipped, which cancels the original out.
 *
 * Before posting, it locks each account the original touched, so two operations can't change
 * the same account at the same time.
 *
 * On success it returns an Outcome whose status is `committed`, carrying the new reversing
 * transaction. Four things are treated as caller mistakes and throw an `OP.MALFORMED` fault
 * (rather than returning a polite "no"): an actor that isn't an operator, a blank reason, a
 * `txnId` that matches no existing transaction, or a `txnId` that names a reversal itself —
 * reversing a reversal would only loop the same money back out and in, so it is refused.
 *
 * A given transaction can be reversed at most once. Before posting, this stakes the shared
 * `reversed:${txnId}` key (the same mutual-exclusion pattern refund and clawback use for
 * `reversed:${orderId}`); a second reverse of the same transaction loses that claim and
 * returns the first reversal's transaction as a `duplicate`, moving no money a second time.
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

  // Stake the per-original-transaction key BEFORE posting, so a given transaction is reversed
  // at most once. The first reverse of `txnId` claims it and posts the inverse; a second
  // reverse of the same `txnId` loses the claim and gets the first reversal's transaction back
  // as a duplicate, moving no money again. This mirrors how refund and clawback stake
  // `reversed:${orderId}` to stay mutually exclusive on a single order. The claim lives inside
  // this posting's database transaction, so a rollback releases it and a later retry succeeds.
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

  // Record the reversal under the same key so a later reverse of this transaction resolves to
  // this same transaction as its duplicate. Written inside the posting's transaction, so it
  // only takes effect if the reversal actually commits.
  await unit.idempotency.record(claimKey, transaction);

  return { status: 'committed', transaction };
}

// The per-original-transaction idempotency key a reverse stakes so a single transaction is
// reversed at most once. Named in the same `reversed:${id}` family refund and clawback use for
// their order-scoped mutual exclusion, here scoped to the transaction being undone.
function reversalKey(txnId: string): string {
  return `reversed:${txnId}`;
}

// Look up the transaction to undo, by its id. The operator typed this id, so if no
// transaction matches it that's operator error: throw a fault rather than return a normal
// "no". (Compare `refund`, where an unknown order id is an everyday caller "no".)
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

// A reversal must never itself be reversed: undoing it would only move the same money back
// out and in, an endless loop with no net effect, and would let an operator chain reversals to
// flip a balance up and down at will. A reversal records `kind: 'reverse'` in its metadata
// (see `reverseMeta`), so reject any `txnId` whose loaded posting carries that marker. This is
// an operator mistake, not an everyday "no", so it throws a fault — the same as naming a txnId
// that does not exist.
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

// Lock every account the original transaction touched, so no other operation can change
// those balances while this reversal posts. The framework only knows to lock accounts named
// in the request, and a reverse request carries just a txnId, not the accounts involved — so
// the handler discovers them from the loaded transaction and locks them itself. The same
// account can appear on more than one line, so a Set skips locking it twice.
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

// Build the opposite of each line of the original transaction: same account, same amount,
// sign flipped (`neg` from money.ts negates an amount). Because the original transaction's
// lines already added up to zero in each currency, flipping every sign keeps that sum at zero,
// so the reversal balances on its own without recomputing anything.
function reverseLegs(legs: ReadonlyArray<Leg>): Leg[] {
  return legs.map((leg) => ({ account: leg.account, amount: neg(leg.amount) }));
}

// The metadata stored alongside the reversing transaction: which transaction it undoes and
// why. The "why" is the operator's reason, kept so an audit can see who undid what and on what
// grounds. No money amounts go in here — those live on the transaction's debit/credit lines.
function reverseMeta(
  operation: Extract<Operation, { kind: 'reverse' }>,
): Record<string, unknown> {
  return {
    kind: 'reverse',
    txnId: operation.txnId,
    reason: operation.reason,
  };
}

// Only a human operator may run a reverse. The surrounding framework already checks this
// before the handler runs, but the handler checks again so it's still safe if called directly
// (for example from a test): the wrong kind of caller throws a fault instead of quietly
// performing this privileged write.
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

// A reversal must record why it happened. A missing or whitespace-only reason is rejected, so
// no reversal can be posted without a stated justification for the audit trail.
function assertReason(reason: string): void {
  if (reason.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'reverse requires a non-empty reason.',
      { detail: { kind: 'reverse' } },
    );
  }
}

// Operations are routed to handlers by their `kind`, so this handler should only ever receive
// a `reverse`. Getting any other kind means something is wired up wrong; throw a fault rather
// than try to handle an operation this code wasn't built for.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
