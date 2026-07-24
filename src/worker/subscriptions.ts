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
import { pendingOutbox } from '#src/outbox.ts';
import { maturedAtLeast } from '#src/maturity.ts';
import { spendable, earned, routePlatformLegs, SYSTEM } from '#src/accounts.ts';
import {
  accrualRowsOf,
  parkEarnedLegs,
  sharesMeta,
} from '#src/operations/accrual.ts';
import { assertSubscriptionAnchored } from '#src/operations/guards.ts';
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
 * - `retrying`: billing threw a temporary error, so the row was left for the next sweep and the
 * code recorded.
 */
export type SweepSummary = {
  charged: ReadonlyArray<string>;
  lapsed: ReadonlyArray<string>;
  deadLettered: ReadonlyArray<{ id: string; reason: string }>;
  retrying: ReadonlyArray<{ id: string; code: string }>;
};

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
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how this sweep claims, bills, and advances due subscriptions.
 */
export async function sweepDueSubscriptions(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number; limit: number },
): Promise<SweepSummary> {
  const due = await store.subscriptions.claimDue(input.now, input.limit);
  const tally: SweepTally = {
    charged: [],
    lapsed: [],
    deadLettered: [],
    retrying: [],
  };

  for (const sub of due) {
    await billOne(store, ctx, sub, tally);
  }

  return tally;
}

// Bills one subscription and catches any error so a single failure cannot break the batch. A
// retryable error bumps `attempts` and retries next sweep until the cap, where the row LAPSES rather
// than re-billing forever; any other error dead-letters the row right away.
// See https://economy-lab-docs.pages.dev/economy/concepts/subscriptions/ for the subscription states
// and the retry-cap-to-lapse rule.
async function billOne(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  try {
    await renew(store, ctx, sub, tally);
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.retryable) {
      await recordRetry({ store, ctx, sub, code: normalized.code, tally });
      return;
    }
    await deadLetter({ store, ctx, sub, reason: normalized.code, tally });
  }
}

// Raises `attempts` to `next`; at the cap the sweep gives up and lapses the row. A successful
// renewal resets `attempts` to 0 via `markBilled`, so the cap only counts consecutive failures.
async function recordRetry(args: {
  store: Store;
  ctx: WorkerCtx;
  sub: Subscription;
  code: string;
  tally: SweepTally;
}): Promise<void> {
  const { store, ctx, sub, code, tally } = args;
  const next = sub.attempts + 1;
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
  const { store, ctx, sub, reason, tally } = args;
  await lapseAtomically(store, ctx, sub);
  // Error-level like the other workers' dead-letters: visible without unpacking the sweep summary.
  ctx.logger.log('error', 'worker.subscriptions.dead_lettered', {
    subscriptionId: sub.id,
    userId: sub.userId,
    reason,
  });
  tally.deadLettered.push({ id: sub.id, reason });
}

// Lapses a subscription and records it under `lapsed`: the shared exit for the unaffordable-charge
// and retry-cap cases.
async function lapse(
  store: Store,
  ctx: WorkerCtx,
  sub: Subscription,
  tally: SweepTally,
): Promise<void> {
  await lapseAtomically(store, ctx, sub);
  // A lapse is an expected business outcome (the buyer couldn't cover the renewal), so it logs at
  // warn rather than error.
  ctx.logger.log('warn', 'worker.subscriptions.lapsed', {
    subscriptionId: sub.id,
    userId: sub.userId,
  });
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
    await unit.outbox.enqueue(pendingOutbox(ctx.ids, lapsedEvent(ctx, sub)));
  });
}

// Renew one due subscription in a single transaction. Read the buyer's spendable balance (real
// topped-up money). If it can't cover the price, lapse and charge nothing. Otherwise post the
// charge and advance the due date together, so a billed period records both or neither.
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
  let immature = false;
  await store.transaction(async (unit) => {
    // Lock the buyer's account before reading its balance, so concurrent sweeps take turns instead
    // of both reading the same pre-charge balance and both charging.
    await unit.ledger.lock(spendable(sub.userId));
    const have = await unit.ledger.balance(spendable(sub.userId));
    if (compare(have, sub.price) < 0) {
      lapsed = true;
      return;
    }
    // Renewals honor the same maturity gate as spend and the first charge. Credits that exist
    // but have not cleared defer the renewal to a later sweep rather than lapse it: the money
    // is temporally, not terminally, missing. The attempt cap still bounds the deferrals.
    const cleared = await maturedAtLeast(
      unit.ledger,
      spendable(sub.userId),
      ctx.clock.now(),
      { config: ctx.config, amount: sub.price, live: have },
    );
    if (!cleared) {
      immature = true;
      return;
    }

    // Charge this period at most once. The key combines the subscription id and the period being
    // billed. Claiming it inside the transaction, after the balance check, reserves the period for
    // this sweep. A lost claim means another sweep already billed it, so stop and post nothing. The
    // key uses period + 1 because that is the period this renewal bills into, since the period
    // counter bumps as part of billing.
    const key = 'sub:' + sub.id + ':p' + (sub.period + 1);
    const claim = await unit.idempotency.claim(key);
    if (!claim.claimed) {
      return;
    }

    // markBilled advances the due date only if the row still holds the due date this sweep started
    // from: it compares and updates in one step, returning false if it already changed. A false
    // return means another sweep advanced this row, so stop. Do this before posting the charge: if
    // we lost the race, returning without throwing commits the transaction, and that commit must
    // contain no charge. The period claim above already blocks a double charge; this is a second,
    // independent guard.
    const newDueAt = sub.nextDueAt + sub.periodMs;
    const billed = await unit.subscriptions.markBilled(
      sub.id,
      newDueAt,
      sub.nextDueAt,
    );
    if (!billed) {
      return;
    }

    // The row about to be charged by is unhashed: re-prove it against the first-charge posting
    // its txnId anchors before a leg derives from it.
    await assertSubscriptionAnchored(
      { ledger: unit.ledger, digest: ctx.digest },
      sub,
    );
    const transaction = await postRenewal(unit, ctx, sub, key);
    await unit.idempotency.record(key, transaction);

    // Re-grant the perk through the new period end (clears any earlier revoke) and emit the
    // renewal, both inside the renewal transaction so they commit with the charge. The grant's
    // source is the subscription id so a later cancel or lapse can find and revoke this grant.
    await unit.entitlements.grant(sub.userId, sub.sku, {
      expiresAt: newDueAt,
      source: sub.id,
    });
    await unit.outbox.enqueue(pendingOutbox(ctx.ids, renewedEvent(ctx, sub)));
    tally.charged.push(sub.id);
  });

  if (immature) {
    await recordRetry({ store, ctx, sub, code: 'FUNDS_IMMATURE', tally });
    return;
  }
  if (lapsed) {
    await lapse(store, ctx, sub, tally);
  }
}

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

// Posts the renewal charge: the buyer pays the full price, the seller gets the post-fee net, and
// platform revenue gets the fee. Renewals draw only from spendable (real) money — unlike the first
// month, none comes from the buyer's promo grant.
async function postRenewal(
  unit: Unit,
  ctx: WorkerCtx,
  sub: Subscription,
  billingKey: string,
): Promise<Transaction> {
  // `feeForPrice` (pricing.ts) owns the fee rounding rule. Spend, the first month
  // (operations/subscribe.ts), and every renewal call it, so the fee is identical.
  const feeMinor = feeForPrice(sub.price.minor, ctx.config.platformFeeBps);
  const netMinor = sub.price.minor - feeMinor;
  const built: Leg[] = [
    debit(spendable(sub.userId), sub.price),
    credit(earned(sub.sellerId), toAmount('CREDIT', netMinor)),
    credit(SYSTEM.REVENUE, toAmount('CREDIT', feeMinor)),
  ];

  // Renewals charge through the same accrual redirect as subscribe, keyed by the billing period's
  // idempotency key, so the drain stays the earned rows' only writer across the whole surface.
  const parked = ctx.config.accrualDrain ? parkEarnedLegs(built) : null;
  const legs =
    parked === null
      ? built
      : routePlatformLegs(parked.legs, billingKey, ctx.config.platformShards);

  const transaction = await postEntry(unit.ledger, {
    txnId: ctx.ids.next('txn'),
    legs,
    meta: {
      kind: 'subscriptions.renew',
      subscriptionId: sub.id,
      sku: sub.sku,
      sellerId: sub.sellerId,
      // Sealed into the chain hash: the share map the accrual rows below must match.
      ...(parked === null ? {} : { shares: sharesMeta(parked.shares) }),
    },
  });
  if (parked !== null) {
    await unit.accruals.put(
      accrualRowsOf({
        orderId: transaction.id,
        shares: parked.shares,
        routeKey: billingKey,
        shards: ctx.config.platformShards,
        txnId: transaction.id,
        recordedAt: transaction.postedAt,
      }),
    );
  }
  return transaction;
}
