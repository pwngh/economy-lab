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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  grantEntitlement,
  revokeEntitlement,
} from '#src/operations/entitlements.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  fixedClock,
  seededDigest,
  makeCtx,
} from '#test/support/capabilities.ts';
import {
  grantEntitlement as grantEntitlementOp,
  revokeEntitlement as revokeEntitlementOp,
} from '#test/support/builders.ts';

import type { Ctx, Operation, Outcome } from '#src/contract.ts';
import type { Store, Unit } from '#src/ports.ts';

type EntitlementHandler = (
  operation: Operation,
  unit: Unit,
  ctx: Ctx,
) => Promise<Outcome>;

function makeStore(): Store {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  return memoryStore({ digest, clock });
}

function apply(
  store: Store,
  ctx: Ctx,
  handler: EntitlementHandler,
  operation: Operation,
): Promise<Outcome> {
  return store.transaction((unit) => handler(operation, unit, ctx));
}

describe('grantEntitlement', () => {
  test('establishes ownership of a sku', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    const outcome = await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_owner', 'wrld_pass'), true);
  });

  test('commits a marker transaction with no debit/credit lines and no hash-chain links', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    const outcome = await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.deepEqual(
      outcome.status === 'committed' ? outcome.transaction.legs : null,
      [],
    );
    assert.deepEqual(
      outcome.status === 'committed' ? outcome.transaction.links : null,
      [],
    );
  });

  test('overwrites prior ownership without an ownership precondition', async () => {
    const store = makeStore();
    const ctx = makeCtx();
    await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({
        userId: 'usr_owner',
        sku: 'wrld_pass',
        attrs: { quantity: 1 },
      }),
    );

    const outcome = await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({
        userId: 'usr_owner',
        sku: 'wrld_pass',
        attrs: { quantity: 3 },
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_owner', 'wrld_pass'), true);
  });

  test('throws MALFORMED_OPERATION on the wrong operation kind', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        grantEntitlement,
        revokeEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });

  test('throws MALFORMED_OPERATION on a blank userId', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        grantEntitlement,
        grantEntitlementOp({ userId: '   ', sku: 'wrld_pass' }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });

  test('throws MALFORMED_OPERATION on a blank sku', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        grantEntitlement,
        grantEntitlementOp({ userId: 'usr_owner', sku: '' }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });

  test('throws MALFORMED_OPERATION when attrs.expiresAt is not finite', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        grantEntitlement,
        grantEntitlementOp({
          userId: 'usr_owner',
          sku: 'wrld_pass',
          attrs: { expiresAt: Number.POSITIVE_INFINITY },
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });

  test('allows a null attrs.expiresAt (never expires)', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    const outcome = await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({
        userId: 'usr_owner',
        sku: 'wrld_pass',
        attrs: { expiresAt: null },
      }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_owner', 'wrld_pass'), true);
  });

  test('throws MALFORMED_OPERATION when attrs.quantity is not a positive integer', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        grantEntitlement,
        grantEntitlementOp({
          userId: 'usr_owner',
          sku: 'wrld_pass',
          attrs: { quantity: 0 },
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );

    await assert.rejects(
      apply(
        store,
        ctx,
        grantEntitlement,
        grantEntitlementOp({
          userId: 'usr_owner',
          sku: 'wrld_pass',
          attrs: { quantity: 1.5 },
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });
});

describe('revokeEntitlement', () => {
  test('removes ownership of a held sku', async () => {
    const store = makeStore();
    const ctx = makeCtx();
    await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
    );

    const outcome = await apply(
      store,
      ctx,
      revokeEntitlement,
      revokeEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(
      await store.entitlements.owns('usr_owner', 'wrld_pass'),
      false,
    );
  });

  test('rejects NOT_ENTITLED when the user does not own the sku', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    const outcome = await apply(
      store,
      ctx,
      revokeEntitlement,
      revokeEntitlementOp({ userId: 'usr_stranger', sku: 'wrld_pass' }),
    );

    assert.equal(outcome.status, 'rejected');
    assert.equal(
      outcome.status === 'rejected' ? outcome.reason : null,
      'NOT_ENTITLED',
    );
  });

  test('throws MALFORMED_OPERATION on the wrong operation kind', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        revokeEntitlement,
        grantEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });

  test('throws MALFORMED_OPERATION on a blank userId', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        revokeEntitlement,
        revokeEntitlementOp({ userId: '   ', sku: 'wrld_pass' }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });

  test('throws MALFORMED_OPERATION on a blank sku', async () => {
    const store = makeStore();
    const ctx = makeCtx();

    await assert.rejects(
      apply(
        store,
        ctx,
        revokeEntitlement,
        revokeEntitlementOp({ userId: 'usr_owner', sku: '' }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'OP.MALFORMED',
    );
  });
});
