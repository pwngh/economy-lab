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
 * Record that a user owns an item or feature (named by `sku`, a product code such as
 * `'wrld_pass'`). Tracks ownership only; no money moves, the ledger is untouched. Always
 * succeeds: overwrites any previous record for that user/sku, with no prerequisite.
 *
 * Restricting grants to `system` and `operator` callers is enforced by an outer layer.
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
 * Remove a user's ownership of an item or feature (named by `sku`). If the user doesn't own
 * it, return a `NOT_ENTITLED` rejection rather than throwing. Otherwise drop the ownership
 * record. No money moves either way; ownership has no balance.
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

// Entitlements move no money, so they post to no accounts and the central blank-owner guard
// (which only inspects wallet accounts an operation posts to) never sees these fields. Check
// them here: a blank/whitespace userId records ownership against a phantom user, a blank sku
// records ownership of nothing. Both are malformed requests, not a normal "no".
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

// Grant attributes come off the wire, so a number field can arrive as NaN, Infinity, or a
// fraction. Only the two fields whose meaning breaks under those values are checked:
// `expiresAt` (an instant) must be finite when present (null means "never expires"), and
// `quantity` (a count) must be a positive integer when present. Malformed values are
// client/programming errors, so throw a fault rather than rejecting.
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

// For a grant with no details (no quantity, version, etc.). Records the ownership fact
// without inventing defaults the caller never gave.
const EMPTY_ATTRS: EntitlementAttrs = {};

// Transaction for an operation that changes ownership but moves no money. A committed result
// must include a Transaction, so this is a receipt with a fresh id and commit time but empty
// leg and link lists, since nothing was posted to the ledger.
function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}

// Each handler is registered to one operation kind. A wrong kind means the dispatch tables
// are miswired, so throw a fault rather than process an operation this handler can't.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `entitlement handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
