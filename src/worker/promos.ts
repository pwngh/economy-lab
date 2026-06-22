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
 * Result of one promo-expiry sweep. A promo grant gives a user credits that expire; on expiry
 * the unspent part is clawed back. Each due grant lands in one of two lists, keyed by grant id:
 *
 * - `reversed`: processed successfully. The unspent part moved back to `SYSTEM.PROMO_FLOAT` (0
 *   if fully spent) and the grant was flagged so later sweeps skip it. `amount` is what moved.
 *
 * - `failed`: processing raised an error, so the grant was skipped for a later sweep or operator.
 *   The error code is recorded. The grant stays eligible: the transaction that would have flagged
 *   it reversed was rolled back along with the failed money movement.
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

// Take back one grant's unspent credits inside a single database transaction. First lock the
// user's promo account (so no concurrent spend changes the balance mid-reversal), then read
// its current balance. The amount to take back is the smaller of the original grant amount and
// that balance: that is the unspent remainder, since any spending has already lowered the
// balance below the original grant. If that amount is more than zero, record a ledger entry
// that exactly undoes the original grant — take the credits out of the user's promo account
// and put them back into PROMO_FLOAT (see postReversal). A grant the user spent in full takes
// back zero and records no entry. Either way, flag the grant as reversed in this same
// transaction, so that if the ledger entry is undone the grant stays eligible to retry.
// Returns how much was actually taken back.
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

// Record the reversal as one ledger entry that moves the unspent credits out of the user's
// promo account and back into the platform's promo-funding account, PROMO_FLOAT. The entry has
// two sides that must net to zero (the accounting rule that no money is created or destroyed, a
// "balanced" entry): a debit takes the credits off the user's promo account and a credit adds
// the same amount to PROMO_FLOAT. This is the exact mirror image of the original grant, which
// debited PROMO_FLOAT and credited the user's promo account, so grant and reversal cancel out.
// The grant id is stored on the entry's metadata (tag fields) so the reversal can later be
// traced back to the grant it undid.
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

// Report what one sweep did, using the logger and the metrics recorder (`meter`) supplied on
// the worker's context. It writes one info-level log line carrying the two counts and the ids
// that failed, then adds to the metrics counter twice — once with the number reversed and once
// with the number that failed — so each can be tracked on its own. Reversing an expired grant
// is internal worker housekeeping, not a change the rest of the system needs to react to, so
// nothing is published onto the event stream other code subscribes to.
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
