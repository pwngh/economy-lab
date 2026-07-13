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
import { assertKind, lifecycleMarker } from '#src/operations/guards.ts';

import type {
  EntitlementAttrs,
  Ctx,
  Operation,
  Outcome,
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
 *   const outcome = await grantEntitlement(
 *     { kind: 'grantEntitlement', idempotencyKey: 'idem_0',
 *       actor: { kind: 'system', service: 'fulfillment' }, userId: 'usr_owner', sku: 'wrld_pass' },
 *     unit, ctx,
 *   );
 *   // outcome.status === 'committed'; unit.entitlements.owns('usr_owner', 'wrld_pass') === true.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/grant-entitlement/
 *   Grant entitlement} for ownership records and grant attributes.
 */
export async function grantEntitlement(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'grantEntitlement');

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
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/operations/revoke-entitlement/
 *   Revoke entitlement} for the revoke flow and the `NOT_ENTITLED` rejection.
 */
export async function revokeEntitlement(
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
): Promise<Outcome> {
  assertKind(operation, 'revokeEntitlement');

  assertIdentified(operation.userId, operation.sku);

  const owns = await unit.entitlements.owns(operation.userId, operation.sku);
  if (!owns) {
    return rejected('NOT_ENTITLED', {
      userId: operation.userId,
      sku: operation.sku,
    });
  }

  await unit.entitlements.revoke(operation.userId, operation.sku);

  return { status: 'committed', transaction: lifecycleMarker(ctx) };
}

// Entitlements post to no accounts, so the central blank-owner guard (which only inspects wallet
// accounts) never sees these fields; they are checked here.
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

// Wire input: a number field can arrive as NaN, Infinity, or a fraction. `expiresAt` must be
// finite when present (null means "never expires"); `quantity` a positive integer when present.
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

const EMPTY_ATTRS: EntitlementAttrs = {};
