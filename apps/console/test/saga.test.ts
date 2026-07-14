/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The saga drill and the operator reversePayout, through the facade and the reverse action.
 */

import { expect, it } from 'vitest';

import type { ConsoleEngine } from '../app/economy';
import { getEngine } from '../app/engine';
import type { Flash } from '../app/flash';
import { takeFlash } from '../app/flash';
import { clientAction as reverse } from '../app/routes/actions.reverse';
import { formPost, fresh } from './support';

async function runReverse(body: Record<string, string>): Promise<Flash | null> {
  await formPost(reverse, body);
  return takeFlash();
}

it('the drill lists a saga and its ledger postings', async () => {
  const { eco } = await fresh();
  const payouts = await eco.payouts({ offset: 0, limit: 50 });
  // A failed payout is terminal (not reversible) and carries both its reserve and reversal legs.
  const failed = payouts.rows.find((p) => p.state === 'FAILED');
  if (!failed) {
    throw new Error('seed has no failed payout');
  }
  const detail = await eco.sagaDetail(failed.id);
  expect(detail?.saga.id).toBe(failed.id);
  expect((detail?.postings ?? []).length).toBeGreaterThan(0);
  expect(detail?.reversible).toBe(false);
  expect(await eco.sagaDetail('pay_nope')).toBeNull();
});

it('settleSubmitted settles the submitted payouts and pays the seller', async () => {
  const { eco } = await fresh();
  const submitted = (await eco.payouts({ offset: 0, limit: 50 })).rows.filter(
    (p) => p.state === 'SUBMITTED',
  );
  if (submitted.length === 0) {
    throw new Error('seed has no submitted payout');
  }

  const { settled } = await eco.settleSubmitted();
  expect(settled).toBe(submitted.length);

  const after = (await eco.payouts({ offset: 0, limit: 50 })).rows;
  const settledRows = after.filter((p) => p.state === 'SETTLED');
  // Every submitted payout is now settled with a recorded USD payout, and none are still submitted.
  expect(settledRows.length).toBeGreaterThanOrEqual(submitted.length);
  expect(settledRows.every((p) => p.payoutUsd !== null)).toBe(true);
  expect(after.some((p) => p.state === 'SUBMITTED')).toBe(false);

  // A re-run settles nothing new.
  expect((await eco.settleSubmitted()).settled).toBe(0);
});

it('reversing a reserved payout returns the reserve to the seller', async () => {
  const { eco } = await fresh();
  const payouts = await eco.payouts({ offset: 0, limit: 50 });
  const reserved = payouts.rows.find((p) => p.state === 'RESERVED');
  if (!reserved) {
    throw new Error('seed has no reserved payout');
  }

  const before = await eco.wallet(reserved.userId);
  if (before === null) {
    throw new Error('reserved payout has no seller wallet');
  }

  const flash = await runReverse({
    sagaId: reserved.id,
    userId: reserved.userId,
    back: '/payouts',
  });
  expect(flash?.kind).toBe('notice');

  const after = await eco.wallet(reserved.userId);
  expect(after?.earned).toBeCloseTo(before.earned + reserved.reserveCredits, 2);

  const detail = await eco.sagaDetail(reserved.id);
  expect(detail?.saga.state).toBe('FAILED');
  expect(detail?.reversible).toBe(false);
});

it('reversing an already-terminal payout reports no change, not a fresh reversal', async () => {
  const { eco } = await fresh();
  const payouts = await eco.payouts({ offset: 0, limit: 50 });
  const failed = payouts.rows.find((p) => p.state === 'FAILED');
  if (!failed) {
    throw new Error('seed has no failed payout');
  }
  const before = await eco.wallet(failed.userId);

  const flash = await runReverse({
    sagaId: failed.id,
    userId: failed.userId,
    back: '/payouts',
  });
  expect(flash?.kind).toBe('notice');
  if (flash?.kind !== 'notice') {
    throw new Error('expected a notice');
  }
  expect(flash.message).toContain('already reversed');

  // Nothing moved this run: the seller's earned balance is unchanged.
  const after = await eco.wallet(failed.userId);
  expect(after?.earned).toBeCloseTo(before?.earned ?? 0, 2);
});

it('a reverse with blank fields is rejected before the engine is touched', async () => {
  await fresh();
  const flash = await runReverse({
    sagaId: '',
    userId: '',
    back: '/payouts',
  });
  expect(flash?.kind).toBe('invalid');
  if (flash?.kind !== 'invalid') {
    throw new Error('expected an invalid flash');
  }
  expect(flash.fields).toHaveProperty('sagaId');
});

it('reversing a live submitted payout is refused with its reason code', async () => {
  const { eco } = await fresh();
  const payouts = await eco.payouts({ offset: 0, limit: 50 });
  const submitted = payouts.rows.find((p) => p.state === 'SUBMITTED');
  if (!submitted) {
    throw new Error('seed has no submitted payout');
  }
  const flash = await runReverse({
    sagaId: submitted.id,
    userId: submitted.userId,
    back: '/payouts',
  });
  expect(flash).toMatchObject({
    kind: 'outcome',
    code: 'SAGA.INVALID_TRANSITION',
  });
});
