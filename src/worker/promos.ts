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

// Name of the metrics counter this background job adds to after each run. The job is a
// "sweep": a periodic pass that scans for expired promo grants and reverses them. After a
// run it bumps this counter twice, once for each outcome ("reversed", "failed"), so a
// dashboard can graph the two numbers separately.
let SWEEP_METRIC = 'economy.worker.promo.expiry';

/**
 * Result of running the promo-expiry sweep once. A promo grant gives a user free credits that
 * expire; when they expire, the credits the user never spent are taken back. Each grant that
 * was due this run ends up in exactly one of these two lists, keyed by grant id:
 *
 * - `reversed` — the grant was processed successfully. Whatever the user had NOT already spent
 *   was moved back to the platform's promo-funding account `SYSTEM.PROMO_FLOAT` (or nothing
 *   moved, if the user had already spent it all), and the grant was flagged so a later sweep
 *   skips it. The recorded `amount` is how much actually moved back (0 for a fully-spent grant).
 *
 * - `failed` — processing this grant raised an error, so it was skipped and left for a later
 *   sweep or a human operator. The error code is recorded so logs can show why. The grant is
 *   still eligible to be picked up again, because the database transaction that would have
 *   flagged it as reversed was rolled back (undone) together with the failed money movement.
 */
export type PromoExpirySummary = {
  reversed: ReadonlyArray<{ id: string; amount: Amount }>;
  failed: ReadonlyArray<{ id: string; code: string }>;
};

// The writable counterpart of PromoExpirySummary that the sweep builds up as it runs. Each
// grant is appended to whichever list matches its outcome; the finished object is returned
// as the (read-only) summary.
type PromoExpiryTally = {
  reversed: Array<{ id: string; amount: Amount }>;
  failed: Array<{ id: string; code: string }>;
};

/**
 * Take back the unspent part of every promo grant that has expired, handling them one at a time.
 *
 * When a grant is created it adds free credits to the user's promo account up front; until the
 * grant expires the user may spend any part of those credits. Once it expires, only the part
 * they did NOT spend should be clawed back. For each expired grant this reads the user's
 * CURRENT promo balance and takes back the smaller of the original grant amount and that
 * balance — that smaller number is the unspent remainder, since spending lowers the balance.
 * Reading the balance fresh for each grant is what stops two grants for the same user from
 * taking back too much: the first grant's reversal lowers the balance the second one then sees.
 *
 * Each grant is handled in its own database transaction so that the money movement and the
 * "mark this grant reversed" write either both commit or both undo together. If the money
 * movement is undone, the grant stays eligible and a later sweep can retry it, rather than
 * being flagged reversed with no money having moved. A grant the user already spent in full has
 * nothing to take back, so it moves no money but is still flagged reversed so it stops getting
 * picked up. An error on any single grant is caught and recorded, so it can't halt the rest.
 *
 * `now` is the current time in epoch milliseconds (milliseconds since 1970). `limit` caps how
 * many expired grants this one run will pick up.
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

// Process one expired grant, catching any error so a single bad grant can't break the whole
// run. On success the amount taken back is recorded under `reversed`. On error, the error is
// passed through `normalizeError` (which maps it to one of our standard error codes) and the
// grant id plus that code go under `failed`. Either way the grant is simply left eligible for
// a later sweep: the transaction that would have flagged it reversed was undone along with the
// money movement, so there is no separate cleanup to do here.
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
