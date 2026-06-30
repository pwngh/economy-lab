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
 * Result of one renewal sweep. Each due subscription appears in exactly one list, by id.
 *
 * - `charged`: the renewal was funded and posted, and the due date advanced.
 * - `lapsed`: the buyer could not cover the price, so the row was marked LAPSED and nothing was charged.
 * - `deadLettered`: billing threw a non-retryable error, so the row was given up on and the reason recorded.
 * - `retrying`: billing threw a temporary error, so the row was left for the next sweep and the code recorded.
 *
 * worker/payouts.ts returns the same shape from its own sweep.
 */
export type SweepSummary = {
  charged: ReadonlyArray<string>;
  lapsed: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

// Mutable version of SweepSummary that the sweep fills in. Each helper pushes the id it handled
// onto the matching list, and the finished tally is returned as the summary.
type SweepTally = {
  charged: string[];
  lapsed: string[];
  deadLettered: Array<{ id: string; reason: string }>;
  retrying: Array<{ id: string; code: string }>;
};

/**
 * Bill every due subscription, one at a time. If the buyer can afford it, charge and advance the
 * due date one period; if not, mark lapsed and charge nothing. Each is billed in its own try/catch
 * so an error on one is recorded and the sweep moves on.
 *
 * `now` is epoch ms; `limit` caps how many due subscriptions this run claims.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how this sweep claims, bills, and advances due subscriptions.
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

// Bills one subscription and catches any error so a single failure cannot break the batch. A
// retryable error bumps `attempts` and retries next sweep until the cap, where the row LAPSES rather
// than re-billing forever; any other error dead-letters the row right away.
// See https://economy-lab-docs.pages.dev/economy/concepts/lifecycles/ for the subscription states and the retry-cap-to-lapse rule.
//
// The cap test is `next >= cap`, where `next` is `attempts + 1`. With the default cap of 10, the
// 10th consecutive failure lapses the row.
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

// Handles a retryable failure by raising `attempts` to `next`. If that reaches the cap, the sweep
// gives up: it flips the row from ACTIVE to LAPSED and records it under `lapsed`. Otherwise it
// persists the raised count, where `open` upserts the row by id and stores the new `attempts`, and
// records the row under `retrying`. A successful renewal resets `attempts` to 0 via `markBilled`,
// so the cap only counts consecutive failures.
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

// Gives up on a renewal that failed with a permanent error. No dedicated "failed" state exists, so
// the row is flipped from ACTIVE to LAPSED to stop re-billing the broken row. The reason is
// recorded on the summary.
async function deadLetter(args: {
  store: Store;
  ctx: WorkerCtx;
  sub: Subscription;
  reason: string;
  tally: SweepTally;
}): Promise<void> {
  let { store, ctx, sub, reason, tally } = args;
  // Revoke the perk and emit the lapse in the same transaction as the flip to LAPSED, so a
  // given-up subscription doesn't leave the buyer holding an unbilled perk. Recorded under
  // `deadLettered`, not `lapsed`.
  await lapseAtomically(store, ctx, sub);
  tally.deadLettered.push({ id: sub.id, reason });
}

// Lapses a subscription and records it under `lapsed`. This is the shared exit for both the
// unaffordable charge and the retry-cap cases. The revoke and the lapsed event share the
// transaction with the flip to LAPSED.
async function lapse(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  await lapseAtomically(store, ctx, sub);
  tally.lapsed.push(sub.id);
}

// Flips the row to LAPSED, revokes the perk, and queues the economy.subscription.lapsed event in
// one transaction (the `unit` handle) so all three take effect or none do. This runs in three
// cases: the buyer cannot afford a renewal, the retry cap is hit, or a renewal failed permanently
// and is dead-lettered.
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
      reason: null,
    });
  });
}

// Renew one due subscription in a single transaction. Read the buyer's spendable balance (real
// topped-up money). If it can't cover the price, lapse and charge nothing. Otherwise post the
// charge and advance the due date together, so a billed period records both or neither.
// `markBilled` also resets the `attempts` counter to 0, so a successful renewal clears earlier
// strikes and the cap only counts consecutive failures.
async function renew(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  // The revoke + lapsed event need their own transaction, run only after this renewal transaction
  // commits the underfunded outcome (one transaction can't both post a charge and revoke a perk).
  // Remember the underfunded result here and lapse afterward.
  let lapsed = false;
  await store.transaction(async (unit) => {
    // Lock the buyer's account before reading its balance, so concurrent sweeps take turns instead
    // of both reading the same pre-charge balance and both charging.
    await unit.ledger.lock(spendable(sub.userId));
    let have = await unit.ledger.balance(spendable(sub.userId));
    if (compare(have, sub.price) < 0) {
      lapsed = true;
      return;
    }

    // Charge this period at most once. The key combines the subscription id and the period being
    // billed. Claiming it inside the transaction, after the balance check, reserves the period for
    // this sweep. A lost claim means another sweep already billed it, so stop and post nothing. The
    // key uses period + 1 because that is the period this renewal bills into, since the period
    // counter bumps as part of billing.
    let key = 'sub:' + sub.id + ':p' + (sub.period + 1);
    let claim = await unit.idempotency.claim(key);
    if (!claim.claimed) {
      return;
    }

    // markBilled advances the due date only if the row still holds the due date this sweep started
    // from: it compares and updates in one step, returning false if it already changed. A false
    // return means another sweep advanced this row, so stop. Do this before posting the charge: if
    // we lost the race, returning without throwing commits the transaction, and that commit must
    // contain no charge. The period claim above already blocks a double charge; this is a second,
    // independent guard.
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

    // Re-grant the perk through the new period end (clears any earlier revoke) and emit the
    // renewal, both inside the renewal transaction so they commit with the charge. The grant's
    // source is the subscription id so a later cancel or lapse can find and revoke this grant.
    await unit.entitlements.grant(sub.userId, sub.sku, {
      expiresAt: newDueAt,
      source: sub.id,
    });
    await unit.outbox.enqueue({
      id: ctx.ids.next('obx'),
      event: renewedEvent(ctx, sub),
      status: 'pending',
      attempts: 0,
      reason: null,
    });
    tally.charged.push(sub.id);
  });

  // Buyer couldn't afford the renewal: lapse it (revoke perk, emit lapsed event) in its own
  // transaction, now that the renewal transaction above closed without posting.
  if (lapsed) {
    await lapse(store, ctx, sub, tally);
  }
}

// Builds the economy.subscription.renewed event, which signals that a subscription was billed for a
// new period. The subject is the buyer and the audience is 'client'. The data carries the ids the
// receiver needs, and the new period entered is sub.period + 1.
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

// Builds the economy.subscription.lapsed event, which signals that a subscription stopped because
// the buyer could not afford it, the retry cap was hit, or a renewal failed permanently. The
// subject is the buyer and the audience is 'client'.
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

// Posts the renewal charge as one balanced ledger entry of three legs that sum to zero. It debits
// the full price from the buyer's spendable account, credits the seller the post-fee net, and
// credits the platform revenue account the fee. Net plus fee equals the price exactly. Renewals
// draw only from spendable (real) money. Unlike the first month, none comes from the buyer's promo
// grant.
async function postRenewal(
  unit: Unit,
  ctx: WorkerCtx,
  sub: Subscription,
): Promise<Transaction> {
  // `feeForPrice` (pricing.ts) is the single source of truth for the fee: rounds the exact
  // basis-point fee up to a whole credit (credits are the indivisible billing unit), capped at the
  // charge. Spend, the first month (operations/subscribe.ts), and every renewal call it, so the fee
  // is identical.
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
