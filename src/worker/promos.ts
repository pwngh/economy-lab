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
import type { Options, PromoGrant, Store, Unit } from '#src/ports.ts';

// Metric name for the sweep, the periodic pass that reverses expired promo grants. The sweep
// bumps this counter twice per run, once per outcome ("reversed" and "failed"), so each outcome
// can be graphed separately.
const SWEEP_METRIC = 'worker.promos.expired';

/**
 * Result of one promo-expiry sweep. Each due grant lands in one of two lists, keyed by grant id:
 *
 * - `reversed`: succeeded. The unspent part moved back to `SYSTEM.PROMO_FLOAT` (0 if fully spent)
 *   and the grant was flagged so later sweeps skip it. `amount` is what moved.
 *
 * - `failed`: raised an error; the grant stays eligible because the flag-reversed write was rolled
 *   back along with the money movement. The error code is recorded.
 */
export type PromoExpirySummary = {
  reversed: ReadonlyArray<{ id: string; amount: Amount }>;
  failed: ReadonlyArray<{ id: string; code: string }>;
};

// Writable counterpart of PromoExpirySummary, built up as the sweep runs and returned as the
// read-only summary.
type PromoExpiryTally = {
  reversed: Array<{ id: string; amount: Amount }>;
  failed: Array<{ id: string; code: string }>;
};

/**
 * Claw back the unspent part of every expired promo grant, one at a time. Per grant, take back
 * min(grant amount, balance) read fresh, so two grants for the same user can't over-claw (the first
 * reversal lowers the balance the second sees).
 *
 * Each grant runs in its own transaction so the money movement and the "mark reversed" write commit
 * or roll back together; if undone the grant stays eligible for retry. Errors on one grant are
 * caught so they can't halt the rest.
 *
 * `now` is epoch milliseconds. `limit` caps how many grants this run picks up.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how scheduled sweeps reverse expired promo grants.
 */
export async function sweepExpiredPromos(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
  options?: Options,
): Promise<PromoExpirySummary> {
  const due = await store.promos.claimDue(input.now, input.limit, options);
  const tally: PromoExpiryTally = { reversed: [], failed: [] };

  for (const grant of due) {
    await reverseOne({ store, ctx, grant, tally, options });
  }

  reportSweep(ctx, tally);
  return tally;
}

// Processes one expired grant and catches its errors so a single bad grant cannot break the run.
// On success the amount taken back goes under `reversed`. On error normalizeError maps it to a
// standard code, and the grant id plus that code go under `failed`. A failed grant stays eligible
// for a later sweep because its transaction rolled back along with the money movement, so no
// cleanup is needed here.
async function reverseOne(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  tally: PromoExpiryTally;
  options?: Options;
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

// Claws back one grant's unspent credits in a single transaction. Locks the user's promo account so
// no concurrent spend shifts the balance mid-reversal, then takes back min(grant amount, balance)
// via a reversal entry into PROMO_FLOAT (see postReversal); a fully spent grant posts nothing.
// Either way it flags the grant reversed inside this same transaction, so if the entry rolls back
// the grant stays eligible to retry. Returns the amount taken back.
async function settle(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  options?: Options;
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

// Posts the reversal as one balanced ledger entry whose debit and credit net to zero: it debits
// the user's promo account and credits PROMO_FLOAT. This mirrors the original grant, which debited
// PROMO_FLOAT and credited the user, so the grant and the reversal cancel out. The grant id goes on
// the entry metadata so the reversal can be traced back to the grant it undid.
async function postReversal(args: {
  unit: Unit;
  ctx: WorkerCtx;
  grant: PromoGrant;
  amount: Amount;
  options?: Options;
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
      meta: { kind: 'promoExpiry', grantId: grant.id },
    },
    options,
  );
}

// Reports one sweep through the context logger and meter. It writes one info log line with the two
// counts and the failed ids, then bumps the counter twice, once with the reversed count and once
// with the failed count, so each outcome is tracked separately. Expiry reversal is internal worker
// housekeeping, so nothing is published to the event stream.
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
