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

// Metrics counter for the sweep (periodic pass that reverses expired promo grants). Bumped
// twice per run, once per outcome ("reversed", "failed"), so each can be graphed separately.
let SWEEP_METRIC = 'economy.worker.promo.expiry';

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
 * Claw back the unspent part of every expired promo grant, one at a time.
 *
 * For each grant, read the user's current promo balance and take back min(grant amount, balance):
 * that is the unspent remainder, since spending lowers the balance. Reading the balance fresh per
 * grant stops two grants for the same user from clawing back too much, since the first reversal
 * lowers the balance the second sees.
 *
 * Each grant runs in its own transaction so the money movement and the "mark reversed" write
 * commit or roll back together. If undone, the grant stays eligible for retry rather than being
 * flagged reversed with no money moved. A fully-spent grant moves nothing but is still flagged.
 * Errors on a single grant are caught and recorded so they can't halt the rest.
 *
 * `now` is epoch milliseconds. `limit` caps how many grants this run picks up.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how scheduled sweeps reverse expired promo grants.
 */
export async function sweepExpiredPromos(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
  options?: Options,
): Promise<PromoExpirySummary> {
  let due = await store.promos.claimDue(input.now, input.limit, options);
  let tally: PromoExpiryTally = { reversed: [], failed: [] };

  for (let grant of due) {
    await reverseOne({ store, ctx, grant, tally, options });
  }

  tally2(ctx, tally);
  return tally;
}

// Process one expired grant, catching errors so one bad grant can't break the run. On success
// the amount taken back goes under `reversed`. On error, normalizeError maps it to a standard
// code and the grant id plus code go under `failed`. Either way the grant stays eligible for a
// later sweep, since the transaction was rolled back along with the money movement; no cleanup
// needed here.
async function reverseOne(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  tally: PromoExpiryTally;
  options?: Options;
}): Promise<void> {
  let { grant, tally } = args;
  try {
    let reversed = await settle(args);
    tally.reversed.push({ id: grant.id, amount: reversed });
  } catch (error) {
    let normalized = normalizeError(error);
    tally.failed.push({ id: grant.id, code: normalized.code });
  }
}

// Claw back one grant's unspent credits in a single transaction. Lock the user's promo account
// (so no concurrent spend shifts the balance mid-reversal), read its balance, take back
// min(grant amount, balance) (the unspent remainder). If positive, post a ledger entry undoing
// the original grant: credits out of the user's promo account, back into PROMO_FLOAT (see
// postReversal). A fully-spent grant takes back zero and posts no entry. Either way flag the
// grant reversed in this same transaction, so if the entry is undone the grant stays eligible to
// retry. Returns the amount taken back.
async function settle(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  options?: Options;
}): Promise<Amount> {
  let { store, ctx, grant, options } = args;
  return store.transaction(async (unit) => {
    await unit.ledger.lock(promo(grant.userId), options);
    let bal = await unit.ledger.balance(promo(grant.userId), options);
    let reverseMinor =
      bal.minor < grant.amount.minor ? bal.minor : grant.amount.minor;
    let reversed = toAmount('CREDIT', reverseMinor);
    if (reverseMinor > 0n) {
      await postReversal({ unit, ctx, grant, amount: reversed, options });
    }
    await unit.promos.markReversed(grant.id, options);
    return reversed;
  }, options);
}

// Post the reversal as one balanced ledger entry (debit and credit net to zero): debit the
// user's promo account, credit PROMO_FLOAT. This mirrors the original grant (which debited
// PROMO_FLOAT and credited the user), so grant and reversal cancel out. The grant id goes on the
// entry metadata so the reversal can be traced back to the grant it undid.
async function postReversal(args: {
  unit: Unit;
  ctx: WorkerCtx;
  grant: PromoGrant;
  amount: Amount;
  options?: Options;
}): Promise<void> {
  let { unit, ctx, grant, amount, options } = args;
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

// Report one sweep via the context logger and meter. Writes one info log line with the two
// counts and the failed ids, then bumps the counter twice (reversed count, failed count) so each
// is tracked separately. Expiry reversal is internal worker housekeeping, so nothing is published
// to the event stream.
function tally2(ctx: WorkerCtx, summary: PromoExpirySummary): void {
  ctx.logger.log('info', 'worker.promo.expiry', {
    reversed: summary.reversed.length,
    failed: summary.failed.length,
    failedIds: summary.failed.map((f) => f.id),
  });
  ctx.meter.count(SWEEP_METRIC, summary.reversed.length, {
    outcome: 'reversed',
  });
  ctx.meter.count(SWEEP_METRIC, summary.failed.length, { outcome: 'failed' });
}
