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

import { normalizeError } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { toAmount } from '#src/money.ts';
import { promo, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { CallOptions, PromoGrant, Store, Unit } from '#src/ports.ts';

const SWEEP_METRIC = 'worker.promos.expired';

/**
 * Result of one promo-expiry sweep.
 * - `reversed`: unspent part moved back to `SYSTEM.PROMO_FLOAT` (0 if fully spent); grant flagged
 *   so later sweeps skip it.
 * - `failed`: threw; the whole transaction rolled back, so the grant stays eligible for retry.
 */
export type PromoExpirySummary = {
  reversed: ReadonlyArray<{ id: string; amount: Amount }>;
  failed: ReadonlyArray<{ id: string; code: string }>;
};

type PromoExpiryTally = {
  reversed: Array<{ id: string; amount: Amount }>;
  failed: Array<{ id: string; code: string }>;
};

/**
 * Claw back the unspent part of every expired promo grant. Per grant, take back
 * min(grant amount, balance) read fresh, so two grants for the same user can't over-claw.
 *
 * Each grant runs in its own transaction: the money movement and the "mark reversed" write
 * commit or roll back together, so a failed grant stays eligible for retry.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how scheduled sweeps reverse expired promo grants.
 */
export async function sweepExpiredPromos(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
  options?: CallOptions,
): Promise<PromoExpirySummary> {
  const due = await store.promos.claimDue(input.now, input.limit, options);
  const tally: PromoExpiryTally = { reversed: [], failed: [] };

  for (const grant of due) {
    await reverseOne({ store, ctx, grant, tally, options });
  }

  reportSweep(ctx, tally);
  return tally;
}

async function reverseOne(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  tally: PromoExpiryTally;
  options?: CallOptions;
}): Promise<void> {
  const { grant, tally } = args;
  try {
    const reversed = await settle(args);
    tally.reversed.push({ id: grant.id, amount: reversed });
  } catch (error) {
    const normalized = normalizeError(error);
    tally.failed.push({ id: grant.id, code: normalized.code });
  }
}

// Locks the user's promo account so no concurrent spend shifts the balance between the read and
// the reversal. A fully spent grant posts nothing but is still flagged reversed.
async function settle(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  options?: CallOptions;
}): Promise<Amount> {
  const { store, ctx, grant, options } = args;
  return store.transaction(async (unit) => {
    await unit.ledger.lock(promo(grant.userId), options);
    const bal = await unit.ledger.balance(promo(grant.userId), options);
    const reverseMinor =
      bal.minor < grant.amount.minor ? bal.minor : grant.amount.minor;
    const reversed = toAmount('CREDIT', reverseMinor);
    if (reverseMinor > 0n) {
      await postReversal({ unit, ctx, grant, amount: reversed, options });
    }
    await unit.promos.markReversed(grant.id, options);
    return reversed;
  }, options);
}

// Mirrors the original grant (which debited PROMO_FLOAT and credited the user), so grant and
// reversal cancel out. The grant id on the metadata ties the reversal back to its grant.
async function postReversal(args: {
  unit: Unit;
  ctx: WorkerCtx;
  grant: PromoGrant;
  amount: Amount;
  options?: CallOptions;
}): Promise<void> {
  const { unit, ctx, grant, amount, options } = args;
  await postEntry(
    unit.ledger,
    {
      txnId: ctx.ids.next('txn'),
      legs: [
        debit(promo(grant.userId), amount),
        credit(SYSTEM.PROMO_FLOAT, amount),
      ],
      meta: { kind: 'promos.expiry', grantId: grant.id },
    },
    options,
  );
}

// Internal housekeeping: logged and metered, never published to the event stream.
function reportSweep(ctx: WorkerCtx, summary: PromoExpirySummary): void {
  ctx.logger.log('info', 'worker.promos.swept', {
    reversed: summary.reversed.length,
    failed: summary.failed.length,
    failedIds: summary.failed.map((f) => f.id),
  });
  ctx.meter.count(SWEEP_METRIC, summary.reversed.length, {
    outcome: 'reversed',
  });
  ctx.meter.count(SWEEP_METRIC, summary.failed.length, { outcome: 'failed' });
}
