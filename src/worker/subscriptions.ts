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
import { compare, toAmount } from '#src/money.ts';
import { spendable, earned, SYSTEM } from '#src/accounts.ts';
import { feeForPrice } from '#src/pricing.ts';

import type { Transaction, WorkerCtx } from '#src/contract.ts';
import type {
  EconomyEvent,
  Leg,
  Store,
  Subscription,
  Unit,
} from '#src/ports.ts';

/**
 * The outcome of running the renewal sweep once. Each due subscription lands in exactly one
 * of these lists, by id:
 *
 * - `charged` — the renewal was funded and posted, and the next due date advanced.
 * - `lapsed` — the buyer couldn't cover the price, so the subscription was marked LAPSED
 *   and nothing was charged.
 * - `deadLettered` — billing this one threw an error that won't get better on retry, so it
 *   was given up on (with the reason recorded).
 * - `retrying` — billing threw a temporary infrastructure error, so it's left untouched for
 *   the next sweep to try again (with the error code recorded).
 *
 * This is the same shape worker/payouts.ts returns from its own sweep, so every worker sweep
 * reports results the same way.
 */
export type SweepSummary = {
  charged: ReadonlyArray<string>;
  lapsed: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

// The mutable version of SweepSummary that the sweep fills in as it goes. Each helper pushes
// the id it handled onto the matching list; the finished tally is returned as the summary.
type SweepTally = {
  charged: string[];
  lapsed: string[];
  deadLettered: Array<{ id: string; reason: string }>;
  retrying: Array<{ id: string; code: string }>;
};

/**
 * Bill every subscription whose next renewal is due, one at a time. For each one: if the buyer
 * can afford it, charge the renewal and move its due date one period forward; if they can't,
 * mark it lapsed and charge nothing. Each subscription is billed inside its own try/catch, so
 * an error on one never stops the rest of the batch — it gets recorded and the sweep moves on.
 *
 * `now` is the current time in epoch milliseconds; `limit` caps how many due subscriptions
 * this run will claim.
 */
export async function sweepDueSubscriptions(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<SweepSummary> {
  let due = await store.subscriptions.claimDue(input.now, input.limit);
  let tally: SweepTally = {
    charged: [],
    lapsed: [],
    deadLettered: [],
    retrying: [],
  };

  for (let sub of due) {
    await billOne(store, ctx, sub, tally);
  }

  return tally;
}

// Bill one subscription, catching any error so it can't break the batch. The error decides
// what happens next:
//
// - A temporary infrastructure error (flagged `retryable`) is normally left for the next
//   sweep to try again, but only up to a point: each retryable failure bumps the row's
//   `attempts` counter, and once that count would reach the configured cap the sweep stops
//   retrying and LAPSES the subscription instead of re-billing a row that keeps failing
//   forever. Below the cap, the bumped count is persisted (via an `open` upsert) so it
//   survives to the next sweep, and the row is recorded under `retrying`.
// - Any other error is permanent, so the subscription is given up on (dead-lettered) right
//   away — retrying can't help.
//
// The cap test is `next >= cap`, where `next` is the failure count after this failure
// (`attempts + 1`). So with the default cap of 10, the 10th failure in a row is the one that
// gives up and lapses the row.
async function billOne(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  try {
    await renew(store, ctx, sub, tally);
  } catch (error) {
    let normalized = normalizeError(error);
    if (normalized.retryable) {
      await recordRetry({ store, ctx, sub, code: normalized.code, tally });
      return;
    }
    await deadLetter({ store, ctx, sub, reason: normalized.code, tally });
  }
}

// Handle a retryable billing failure that is still below the attempt cap. Raise the failure
// count `attempts` to `next`. If that reaches the cap, this latest failure is the last one
// allowed, so give up: flip the subscription from ACTIVE to LAPSED to stop the sweep from
// re-billing a row that keeps failing forever, and record it under `lapsed`. Otherwise save the
// raised count so it carries into the next sweep -- `open` writes the subscription row, inserting
// it or overwriting the existing one with the same id, which is how the new `attempts` value is
// stored back -- and record the row under `retrying` to be tried again next sweep. A successful
// renewal resets `attempts` back to 0 via `markBilled`, so the cap only counts failures that
// happen back to back with no success in between.
async function recordRetry(args: {
  store: Store;
  ctx: WorkerCtx;
  sub: Subscription;
  code: string;
  tally: SweepTally;
}): Promise<void> {
  let { store, ctx, sub, code, tally } = args;
  let next = sub.attempts + 1;
  if (next >= ctx.config.maxSubscriptionAttempts) {
    await lapse(store, ctx, sub, tally);
    return;
  }
  await store.subscriptions.open({ ...sub, attempts: next });
  tally.retrying.push({ id: sub.id, code });
}

// Give up on a renewal that failed with a permanent error. A subscription has no dedicated
// "failed" state, so the closest thing is to mark it LAPSED (ACTIVE -> LAPSED), which stops
// the sweep from re-billing this broken row. The reason is recorded on the summary so the
// failure is visible rather than silently swallowed.
async function deadLetter(args: {
  store: Store;
  ctx: WorkerCtx;
  sub: Subscription;
  reason: string;
  tally: SweepTally;
}): Promise<void> {
  let { store, ctx, sub, reason, tally } = args;
  // Revoke the buyer's perk and announce the lapse in the same transaction as the state flip
  // to LAPSED, so a given-up subscription never leaves the buyer holding a perk they are no
  // longer being billed for. Recorded under `deadLettered`, not `lapsed`.
  await lapseAtomically(store, ctx, sub);
  tally.deadLettered.push({ id: sub.id, reason });
}

// Lapse a subscription and record it under `lapsed`. This is the shared exit used both when the
// buyer can't afford the charge and when the retry cap is hit. Revoking the perk and emitting the
// lapsed event happen in the same transaction as the flip to LAPSED.
async function lapse(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  await lapseAtomically(store, ctx, sub);
  tally.lapsed.push(sub.id);
}

// Flip a subscription to LAPSED, revoke its perk, and queue the economy.subscription.lapsed
// event -- all in one database transaction so the three either all take effect or none do. The
// three calls are wrapped in store.transaction (which runs them against a single transaction,
// the `unit` handle) so the revoke and the event can't land without the lapse, or vice versa.
// This lapse path is reached three ways: the buyer can't afford a renewal, the retry cap is
// hit, or a renewal failed with a permanent error (dead-letter).
async function lapseAtomically(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
): Promise<void> {
  await store.transaction(async (unit) => {
    await unit.subscriptions.markLapsed(sub.id);
    await unit.entitlements.revoke(sub.userId, sub.sku);
    await unit.outbox.enqueue({
      id: ctx.ids.next('obx'),
      event: lapsedEvent(ctx, sub),
      status: 'pending',
      attempts: 0,
    });
  });
}

// Renew one due subscription inside a single database transaction. Read the buyer's spendable
// balance (real money they topped up). If it can't cover the price, mark the subscription
// lapsed and charge nothing. Otherwise post the renewal charge and advance the next due date
// together, so a billed period always ends up with both recorded, or neither. `markBilled`
// also resets the row's retryable-failure `attempts` counter to 0, so a renewal that finally
// succeeds clears any earlier strikes and the cap only ever counts *consecutive* failures.
async function renew(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  // The revoke + lapsed event need their own transaction, and they run only after this renewal
  // transaction has already committed the underfunded outcome (one transaction can't both post a
  // charge and revoke a perk), so remember the underfunded result here and lapse afterward.
  let lapsed = false;
  await store.transaction(async (unit) => {
    // Lock the buyer's account before reading its balance, so two sweeps running at once take
    // turns on this account instead of both reading the same pre-charge balance and both charging.
    await unit.ledger.lock(spendable(sub.userId));
    let have = await unit.ledger.balance(spendable(sub.userId));
    if (compare(have, sub.price) < 0) {
      lapsed = true;
      return;
    }

    // Make sure this period is charged at most once, no matter how the due-date timing lines up.
    // The key combines the subscription id and the period being billed; claiming it inside the
    // transaction (after the balance check) reserves that period for this sweep. If the claim is
    // lost, another sweep already billed this period, so stop and post nothing. period+1 is the
    // period this renewal bills into (the period counter is bumped as part of billing).
    let key = 'sub:' + sub.id + ':p' + (sub.period + 1);
    let claim = await unit.idempotency.claim(key);
    if (!claim.claimed) {
      return;
    }

    // markBilled advances the due date, but only if the row still has the due date this sweep
    // started from -- it compares the stored due date and updates it in one step, returning false
    // if it had already changed. A false return means another sweep already advanced this row, so
    // stop. Do this BEFORE posting the charge: if we lost the race, returning from the callback
    // without throwing commits the transaction, and we want that commit to contain no charge. The
    // period claim above already prevents a double charge; this is the second, independent guard.
    let newDueAt = sub.nextDueAt + sub.periodMs;
    let billed = await unit.subscriptions.markBilled(
      sub.id,
      newDueAt,
      sub.nextDueAt,
    );
    if (!billed) {
      return;
    }

    let transaction = await postRenewal(unit, ctx, sub);
    await unit.idempotency.record(key, transaction);

    // Re-grant the perk through the new period end (re-granting clears any earlier revoke) and
    // announce the renewal -- both inside the renewal transaction so they commit together with the
    // charge. The grant's source is the subscription id so a later cancel or lapse can find and
    // revoke this exact grant.
    await unit.entitlements.grant(sub.userId, sub.sku, {
      expiresAt: newDueAt,
      source: sub.id,
    });
    await unit.outbox.enqueue({
      id: ctx.ids.next('obx'),
      event: renewedEvent(ctx, sub),
      status: 'pending',
      attempts: 0,
    });
    tally.charged.push(sub.id);
  });

  // The buyer couldn't afford the renewal: lapse it (revoke the perk, emit the lapsed event) in
  // its own transaction, now that the renewal transaction above has closed without posting.
  if (lapsed) {
    await lapse(store, ctx, sub, tally);
  }
}

// Build the economy.subscription.renewed event, which tells the buyer their subscription billed
// for a new period. The event names the buyer (subject) and is meant for their app (audience
// 'client'). Its data carries the ids the receiver needs so it doesn't have to look them up --
// the new period being entered is sub.period + 1.
function renewedEvent(ctx: WorkerCtx, sub: Subscription): EconomyEvent {
  return {
    id: ctx.ids.next('evt'),
    type: 'economy.subscription.renewed',
    version: 1,
    occurredAt: ctx.clock.now(),
    subject: sub.userId,
    audience: 'client',
    data: {
      subscriptionId: sub.id,
      userId: sub.userId,
      sku: sub.sku,
      period: sub.period + 1,
    },
  };
}

// Build the economy.subscription.lapsed event, which tells the buyer their subscription stopped
// (they couldn't afford it, the retry cap was hit, or a permanent failure). The event names the
// buyer (subject) and is meant for their app (audience 'client').
function lapsedEvent(ctx: WorkerCtx, sub: Subscription): EconomyEvent {
  return {
    id: ctx.ids.next('evt'),
    type: 'economy.subscription.lapsed',
    version: 1,
    occurredAt: ctx.clock.now(),
    subject: sub.userId,
    audience: 'client',
    data: {
      subscriptionId: sub.id,
      userId: sub.userId,
      sku: sub.sku,
      period: sub.period,
    },
  };
}

// Post the renewal charge as one balanced ledger entry, made of three debit/credit lines
// (legs) that add up to zero. Take the full price out of the buyer's spendable account, give
// the seller the amount left after the platform fee, and give the platform's revenue account
// the fee. Net plus fee equal the price exactly, so no money is created or lost. Renewals are
// paid only from spendable (real) money — unlike the first month, none of the charge is paid
// from the buyer's promo grant.
async function postRenewal(
  unit: Unit,
  ctx: WorkerCtx,
  sub: Subscription,
): Promise<Transaction> {
  // `feeForPrice` (pricing.ts) is the single source of truth for the transaction fee: it rounds
  // the exact basis-point fee UP to a whole credit (VRChat's documented rule), capped at the
  // charge. Spend, the first month (operations/subscribe.ts), and every renewal all call it, so
  // they compute the fee identically.
  let feeMinor = feeForPrice(sub.price.minor, ctx.config.platformFeeBps);
  let netMinor = sub.price.minor - feeMinor;
  let legs: Leg[] = [
    debit(spendable(sub.userId), sub.price),
    credit(earned(sub.sellerId), toAmount('CREDIT', netMinor)),
    credit(SYSTEM.REVENUE, toAmount('CREDIT', feeMinor)),
  ];
  return postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: {
      kind: 'subscribe.renew',
      subscriptionId: sub.id,
      sku: sub.sku,
      sellerId: sub.sellerId,
    },
  });
}
