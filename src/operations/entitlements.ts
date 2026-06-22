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

import type {
  EntitlementAttrs,
  Ctx,
  Operation,
  Outcome,
  Transaction,
} from '#src/contract.ts';
import type { Unit } from '#src/ports.ts';

/**
 * Record that a user now owns an item or feature (named by a `sku`, a product code such
 * as `'wrld_pass'`). This only tracks who owns what; no money moves and the ledger is
 * not touched. The grant always succeeds: it overwrites any previous record for that
 * user and sku, and there is nothing the user must already own first.
 *
 * Restricting grants to `system` and `operator` callers is enforced by an outer layer
 * before this runs, not here.
 *
 * @example
 *   let outcome = await grantEntitlement(
 *     { kind: 'grantEntitlement', idempotencyKey: 'idem_0',
 *       actor: { kind: 'system', service: 'fulfillment' }, userId: 'usr_owner', sku: 'wrld_pass' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; unit.entitlements.owns('usr_owner', 'wrld_pass') === true.
 */
export async function grantEntitlement(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'grantEntitlement') {
    throw kindMismatch(operation);
  }

  assertIdentified(operation.userId, operation.sku);
  assertAttrs(operation.attrs);

  await unit.entitlements.grant(
    operation.userId,
    operation.sku,
    operation.attrs ?? EMPTY_ATTRS,
  );

  return { status: 'committed', transaction: lifecycleMarker(ctx) };
}

/**
 * Take away a user's ownership of an item or feature (named by a `sku`). If the user does
 * not own it, that is a normal "no" returned to the caller as a `NOT_ENTITLED` rejection
 * rather than an error that gets thrown and alerted on. Otherwise the ownership record is
 * removed. Either way no money moves, since ownership has no balance attached to it.
 */
export async function revokeEntitlement(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  if (operation.kind !== 'revokeEntitlement') {
    throw kindMismatch(operation);
  }

  assertIdentified(operation.userId, operation.sku);

  let owns = await unit.entitlements.owns(operation.userId, operation.sku);
  if (!owns) {
    return rejected('NOT_ENTITLED', {
      userId: operation.userId,
      sku: operation.sku,
    });
  }

  await unit.entitlements.revoke(operation.userId, operation.sku);

  return { status: 'committed', transaction: lifecycleMarker(ctx) };
}

// An entitlement names a user and a sku but moves no money, so it touches no accounts and
// the central blank-owner guard (which only inspects the wallet accounts an operation posts
// to) never sees these two fields. Check them here: a blank or whitespace-only userId would
// record ownership against a phantom user, and a blank sku an ownership of nothing, so either
// is a malformed request rather than a normal "no" answer.
function assertIdentified(userId: string, sku: string): void {
  if (userId.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'entitlement operation names a blank userId.',
      { detail: { field: 'userId' } },
    );
  }
  if (sku.trim() === '') {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'entitlement operation names a blank sku.',
      { detail: { field: 'sku' } },
    );
  }
}

// The optional grant attributes come straight off the wire, so a number field can arrive as
// NaN, Infinity, or a fraction. Only the two fields with a meaning that breaks under those
// values are checked: `expiresAt` is an instant, so it must be a finite number when present
// (null is allowed — it means "never expires"), and `quantity` is a count, so it must be a
// positive integer when present. Either being malformed is a client/programming error, so it
// throws a fault rather than returning a rejection.
function assertAttrs(attrs: EntitlementAttrs | undefined): void {
  if (attrs === undefined) {
    return;
  }
  if (
    attrs.expiresAt !== undefined &&
    attrs.expiresAt !== null &&
    !Number.isFinite(attrs.expiresAt)
  ) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'entitlement attrs.expiresAt must be a finite number.',
      { detail: { field: 'attrs.expiresAt', value: attrs.expiresAt } },
    );
  }
  if (
    attrs.quantity !== undefined &&
    (!Number.isInteger(attrs.quantity) || attrs.quantity <= 0)
  ) {
    throw fault(
      ERROR_CODES.MALFORMED_OPERATION,
      'entitlement attrs.quantity must be a positive integer.',
      { detail: { field: 'attrs.quantity', value: attrs.quantity } },
    );
  }
}

// Used when a grant comes in with no details (no quantity, version, etc.). Recording an
// empty set keeps the ownership fact while avoiding made-up defaults the caller never gave.
const EMPTY_ATTRS: EntitlementAttrs = {};

// Builds the Transaction returned when an operation changes ownership but moves no money.
// A committed result must always include a Transaction, so this stands in as a receipt: it
// has a fresh id and the time it committed, but its lists of debit/credit lines and of
// per-account history updates are empty, because nothing was posted to the ledger.
function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}

// Each handler is registered to one operation kind and should only ever be called with that
// kind. Getting the wrong one means the dispatch tables are wired wrong, so we throw a fault
// loudly rather than try to process an operation this handler doesn't understand.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `entitlement handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
