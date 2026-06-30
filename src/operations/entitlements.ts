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
 * Records that a user owns an item or feature, named by `sku`, a product code such as
 * `'wrld_pass'`. This tracks ownership only. No money moves and the ledger is untouched. The
 * grant always succeeds. It overwrites any previous record for that user and sku, and it has
 * no prerequisite.
 *
 * An outer layer enforces that only `system` and `operator` callers may grant.
 *
 * @example
 *   let outcome = await grantEntitlement(
 *     { kind: 'grantEntitlement', idempotencyKey: 'idem_0',
 *       actor: { kind: 'system', service: 'fulfillment' }, userId: 'usr_owner', sku: 'wrld_pass' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; unit.entitlements.owns('usr_owner', 'wrld_pass') === true.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/grant-entitlement/ Grant entitlement} for ownership records and grant attributes.
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
 * Removes a user's ownership of an item or feature, named by `sku`. If the user does not own
 * it, this returns a `NOT_ENTITLED` rejection rather than throwing. Otherwise it drops the
 * ownership record. No money moves either way, because ownership has no balance.
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

// Validates that the userId and sku are non-blank. Entitlements move no money, so they post
// to no accounts. The central blank-owner guard only inspects wallet accounts an operation
// posts to, so it never sees these fields. They are checked here instead. A blank or
// whitespace userId records ownership against a phantom user. A blank sku records ownership
// of nothing. Both are malformed requests, not a normal "no", so each throws a fault.
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

// Validates the grant attributes. These come off the wire, so a number field can arrive as
// NaN, Infinity, or a fraction. Only the two fields whose meaning breaks under those values
// are checked. `expiresAt` is an instant and must be finite when present, where null means
// "never expires". `quantity` is a count and must be a positive integer when present. A
// malformed value is a client or programming error, so it throws a fault rather than rejecting.
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

// Holds the attributes for a grant with no details, such as no quantity or version. It
// records the ownership fact without inventing defaults the caller never gave.
const EMPTY_ATTRS: EntitlementAttrs = {};

// Builds the transaction for an operation that changes ownership but moves no money. A
// committed result must include a Transaction. This one is a receipt with a fresh id and a
// commit time, but with empty leg and link lists, because nothing was posted to the ledger.
function lifecycleMarker(ctx: Ctx): Transaction {
  return {
    id: ctx.ids.next('txn'),
    postedAt: ctx.clock.now(),
    legs: [],
    links: [],
  };
}

// Builds the fault for a handler that received the wrong operation kind. Each handler is
// registered to one kind, so a wrong kind means the dispatch tables are miswired. The handler
// throws this fault rather than process an operation it cannot handle.
function kindMismatch(operation: Operation): ReturnType<typeof fault> {
  return fault(
    ERROR_CODES.MALFORMED_OPERATION,
    `entitlement handler received the wrong operation kind: ${operation.kind}.`,
    { detail: { kind: operation.kind } },
  );
}
