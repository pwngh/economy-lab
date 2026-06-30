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
  sequentialIds,
  seededDigest,
  seededSigner,
  fixedRates,
  testLogger,
  noopMeter,
  fakeProcessor,
  defaultPricing,
  testConfig,
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

// Builds the Ctx of shared services passed to every handler. Every service is a
// deterministic fake, so each run produces the same result.
function makeCtx(): Ctx {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  return {
    clock,
    ids: sequentialIds(),
    digest,
    signer: seededSigner(1),
    processor: fakeProcessor(),
    config: testConfig(),
    pricing: defaultPricing(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
  };
}

function makeStore(): Store {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  return memoryStore({ digest, clock });
}

// Runs one handler inside a store transaction, exactly as production does, so its writes
// commit or roll back together. Returns the Outcome, which is committed, rejected, or a
// thrown error bubbled out.
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
    let store = makeStore();
    let ctx = makeCtx();

    let outcome = await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
    );

    assert.equal(outcome.status, 'committed');
    assert.equal(await store.entitlements.owns('usr_owner', 'wrld_pass'), true);
  });

  test('commits a marker transaction with no debit/credit lines and no hash-chain links', async () => {
    let store = makeStore();
    let ctx = makeCtx();

    let outcome = await apply(
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
    let store = makeStore();
    let ctx = makeCtx();
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

    let outcome = await apply(
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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();

    let outcome = await apply(
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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();
    await apply(
      store,
      ctx,
      grantEntitlement,
      grantEntitlementOp({ userId: 'usr_owner', sku: 'wrld_pass' }),
    );

    let outcome = await apply(
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
    let store = makeStore();
    let ctx = makeCtx();

    let outcome = await apply(
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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();

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
    let store = makeStore();
    let ctx = makeCtx();

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
