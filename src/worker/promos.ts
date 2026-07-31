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

import { ERROR_CODES, fault, normalizeError } from '#src/errors.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { verifiedPosting } from '#src/chain.ts';
import { toAmount } from '#src/money.ts';
import { promo, SYSTEM } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { CallOptions, PromoGrant, Store, Unit } from '#src/ports.ts';

const SWEEP_METRIC = 'worker.promos.expired';
const SURPLUS_METRIC = 'worker.promos.surplus';

/**
 * Result of one promo-expiry sweep.
 * - `reversed`: the grant's unspent share moved back to `SYSTEM.PROMO_FLOAT` (0 if fully spent).
 *   The grant is flagged so later sweeps skip it.
 * - `failed`: the reversal threw. The whole transaction rolled back, so the grant stays
 *   eligible for retry.
 * - `surplus`: what the second pass did with pooled credit no live grant claims.
 */
export type PromoExpirySummary = {
  reversed: ReadonlyArray<{ id: string; amount: Amount }>;
  failed: ReadonlyArray<{ id: string; code: string }>;
  surplus: PromoSurplusSummary;
};

/**
 * Result of one promo-surplus pass.
 * - `scanned`: promo holders examined. A pass that burns nothing still reports what it looked at.
 * - `burned`: pooled credit above the user's live grant faces, moved to `SYSTEM.PROMO_FLOAT`.
 * - `failed`: the burn threw, so the pool is untouched and the next pass retries.
 */
export type PromoSurplusSummary = {
  scanned: number;
  burned: ReadonlyArray<{ userId: string; amount: Amount }>;
  failed: ReadonlyArray<{ userId: string; code: string }>;
};

type PromoExpiryTally = {
  reversed: Array<{ id: string; amount: Amount }>;
  failed: Array<{ id: string; code: string }>;
  surplus: {
    scanned: number;
    burned: Array<{ userId: string; amount: Amount }>;
    failed: Array<{ userId: string; code: string }>;
  };
};

/**
 * Claw back the unspent part of every expired promo grant, then burn whatever the pool holds
 * that no live grant claims.
 *
 * A user's grants all pool into one promo account, so the balance alone cannot say which grant
 * paid for a spend. The rule is that a spend draws down the grant that expires soonest, so what
 * an expiring grant may take back is whatever the pool holds above what later-expiring grants
 * still claim.
 *
 * A refund raises the pooled balance by the promo part of the sale it reverses, and it does so
 * whether or not the grant that funded the sale is still open. Credit restored above the total
 * face of the user's live grants therefore belongs to no grant: the per-grant clawback caps at a
 * face and can never take it, and once the last grant is reversed `claimDue` never visits the
 * user again. Granted credit is the platform's marketing spend, so that surplus goes back to
 * `SYSTEM.PROMO_FLOAT` rather than staying spendable forever.
 *
 * Each grant and each burn runs in its own transaction: the money movement and the "mark
 * reversed" write commit or roll back together, so a failed grant stays eligible for retry.
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
  const tally: PromoExpiryTally = {
    reversed: [],
    failed: [],
    surplus: { scanned: 0, burned: [], failed: [] },
  };

  for (const grant of due) {
    await reverseOne({ store, ctx, grant, tally, options });
  }
  // Second, so a grant this run just closed hands its user's leftover to the same pass.
  await burnSurplus({ store, ctx, limit: input.limit, tally, options });

  reportSweep(ctx, tally);
  return tally;
}

// Walks every promo holder each run and burns what no live grant claims. It is the whole set
// because a holder becomes a candidate through a refund, which marks no grant row; the per-holder
// cost is one balance read, and only a pool holding something is locked and re-derived. `limit`
// caps burns rather than holders scanned: a burned pool no longer exceeds its live faces, so
// restarting the walk at the top next run drains the backlog instead of starving it.
async function burnSurplus(args: {
  store: Store;
  ctx: WorkerCtx;
  limit: number;
  tally: PromoExpiryTally;
  options?: CallOptions;
}): Promise<void> {
  const { store, ctx, limit, tally, options } = args;
  for await (const userId of store.promos.holders(options)) {
    tally.surplus.scanned += 1;
    const pooled = await store.ledger.balance(promo(userId), options);
    if (pooled.minor <= 0n) {
      continue;
    }
    await burnOne({ store, ctx, userId, tally, options });
    if (tally.surplus.burned.length >= limit) {
      return;
    }
  }
}

async function burnOne(args: {
  store: Store;
  ctx: WorkerCtx;
  userId: string;
  tally: PromoExpiryTally;
  options?: CallOptions;
}): Promise<void> {
  const { userId, tally } = args;
  try {
    const burned = await settleSurplus(args);
    if (burned.minor > 0n) {
      tally.surplus.burned.push({ userId, amount: burned });
    }
  } catch (error) {
    const normalized = normalizeError(error);
    tally.surplus.failed.push({ userId, code: normalized.code });
  }
}

// Takes the same lock the expiry reversal and every spend take, so the balance cannot move
// between the reads and the burn. Every live face is re-proved on the same terms an expiring
// grant's is: a row that does not re-derive refuses the burn rather than widening it.
async function settleSurplus(args: {
  store: Store;
  ctx: WorkerCtx;
  userId: string;
  options?: CallOptions;
}): Promise<Amount> {
  const { store, ctx, userId, options } = args;
  return store.transaction(async (unit) => {
    await unit.ledger.lock(promo(userId), options);
    const live = await unit.promos.liveFor(userId, options);
    let claimed = 0n;
    for (const grant of live) {
      const face = await verifiedFace({ unit, ctx, grant });
      claimed += face.minor;
    }
    const bal = await unit.ledger.balance(promo(userId), options);
    const over = bal.minor - claimed;
    const burned = toAmount('CREDIT', over > 0n ? over : 0n);
    if (burned.minor > 0n) {
      await postBurn({ unit, ctx, userId, amount: burned, options });
    }
    return burned;
  }, options);
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

// Locks the user's promo account so no concurrent spend or grant shifts the balance between the
// reads and the reversal. A fully spent grant posts nothing but is still flagged reversed.
async function settle(args: {
  store: Store;
  ctx: WorkerCtx;
  grant: PromoGrant;
  options?: CallOptions;
}): Promise<Amount> {
  const { store, ctx, grant, options } = args;
  return store.transaction(async (unit) => {
    await unit.ledger.lock(promo(grant.userId), options);
    const face = await verifiedFace({ unit, ctx, grant });
    const held = await laterClaims({ unit, ctx, grant, options });
    const bal = await unit.ledger.balance(promo(grant.userId), options);
    const reversed = toAmount('CREDIT', shareOf(bal.minor, held, face.minor));
    if (reversed.minor > 0n) {
      await postReversal({ unit, ctx, grant, amount: reversed, options });
    }
    await unit.promos.markReversed(grant.id, options);
    return reversed;
  }, options);
}

// What this grant may take back: the pooled balance less everything the later-expiring grants
// still claim, capped at its own face and floored at zero. A grant drawn down past its face by
// earlier spending takes back nothing rather than reaching into the rest of the pool.
function shareOf(
  balanceMinor: bigint,
  laterMinor: bigint,
  face: bigint,
): bigint {
  const unclaimed = balanceMinor - laterMinor;
  if (unclaimed <= 0n) {
    return 0n;
  }
  return unclaimed < face ? unclaimed : face;
}

// Spend draws the soonest-expiring grant first, so a grant's claim on the pool sits behind every
// grant that outlives it. Ties on `expiresAt` break by id, so the same pool splits the same way
// however the rows come back and whichever of the tied grants is swept first.
function outlives(other: PromoGrant, grant: PromoGrant): boolean {
  return (
    other.expiresAt > grant.expiresAt ||
    (other.expiresAt === grant.expiresAt && other.id > grant.id)
  );
}

// Every face that enters the arithmetic is re-proved, not just this grant's: an edited sibling row
// moves the cut line just as an edited own row would.
async function laterClaims(args: {
  unit: Unit;
  ctx: WorkerCtx;
  grant: PromoGrant;
  options?: CallOptions;
}): Promise<bigint> {
  const { unit, ctx, grant, options } = args;
  const live = await unit.promos.liveFor(grant.userId, options);
  let total = 0n;
  for (const other of live) {
    if (!outlives(other, grant)) {
      continue;
    }
    const face = await verifiedFace({ unit, ctx, grant: other });
    total += face.minor;
  }
  return total;
}

// A grant row is unhashed but shares its id with the granting posting. Re-prove that posting, then
// match the row's amount and expiry against the sealed leg and metadata before clawing by it. An
// edited expiry would otherwise reclaim unspent promo off schedule.
async function verifiedFace(args: {
  unit: Unit;
  ctx: WorkerCtx;
  grant: PromoGrant;
}): Promise<Amount> {
  const { unit, ctx, grant } = args;
  const posting = await verifiedPosting(
    { ledger: unit.ledger, digest: ctx.digest },
    grant.id,
  );
  const promoLeg = posting?.legs.find(
    (leg) => leg.account === promo(grant.userId),
  );
  if (
    posting === null ||
    promoLeg === undefined ||
    -promoLeg.amount.minor !== grant.amount.minor ||
    posting.meta.expiresAt !== grant.expiresAt
  ) {
    throw fault(
      ERROR_CODES.CHAIN_BROKEN,
      'A promo grant does not re-derive from its granting posting; refusing to reverse by an unverifiable row.',
      { retryable: false, detail: { id: grant.id, userId: grant.userId } },
    );
  }
  return grant.amount;
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

// Same money movement as a grant reversal, under its own `kind` so history tells the two apart:
// this one answers to no grant id, which is the whole reason it exists.
async function postBurn(args: {
  unit: Unit;
  ctx: WorkerCtx;
  userId: string;
  amount: Amount;
  options?: CallOptions;
}): Promise<void> {
  const { unit, ctx, userId, amount, options } = args;
  await postEntry(
    unit.ledger,
    {
      txnId: ctx.ids.next('txn'),
      legs: [debit(promo(userId), amount), credit(SYSTEM.PROMO_FLOAT, amount)],
      meta: { kind: 'promos.surplus', userId },
    },
    options,
  );
}

// The sweep report is internal housekeeping. It is logged and metered, never published to the
// event stream.
function reportSweep(ctx: WorkerCtx, summary: PromoExpirySummary): void {
  ctx.logger.log('info', 'worker.promos.swept', {
    reversed: summary.reversed.length,
    failed: summary.failed.length,
    failedIds: summary.failed.map((f) => f.id),
    scanned: summary.surplus.scanned,
    burned: summary.surplus.burned.length,
    burnFailedIds: summary.surplus.failed.map((f) => f.userId),
  });
  ctx.meter.count(SWEEP_METRIC, summary.reversed.length, {
    outcome: 'reversed',
  });
  ctx.meter.count(SWEEP_METRIC, summary.failed.length, { outcome: 'failed' });
  ctx.meter.count(SURPLUS_METRIC, summary.surplus.scanned, {
    outcome: 'scanned',
  });
  ctx.meter.count(SURPLUS_METRIC, summary.surplus.burned.length, {
    outcome: 'burned',
  });
  ctx.meter.count(SURPLUS_METRIC, summary.surplus.failed.length, {
    outcome: 'failed',
  });
}
