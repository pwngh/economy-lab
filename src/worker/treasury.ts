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

import {
  ERROR_CODES,
  fault,
  normalizePortError,
  normalizeError,
} from '#src/errors.ts';
import { convertFloor, encodeAmount, mulDiv, toAmount } from '#src/money.ts';
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import {
  backingRequiredMinor,
  backingShortfallMinor,
  backingTotals,
} from '#src/integrity.ts';
import { maturedBalance } from '#src/maturity.ts';
import { pendingOutbox } from '#src/outbox.ts';
import { SYSTEM, shardsOf } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Transaction, WorkerCtx } from '#src/contract.ts';
import type { Leg, CallOptions, Rate, Store, Unit } from '#src/ports.ts';

/**
 * Result of one backing check. A credit is backed when it can be redeemed from cash held in
 * trust at the fixed CREDIT-to-USD "par" rate.
 */
export type BackingPosition = {
  // Every user's spendable balance — excludes earned revenue, promo grants, and payout
  // reserves, none of which a user can spend.
  custodialCredit: Amount;

  // USD to back `custodialCredit`: converted at par, rounded down.
  required: Amount;

  // USD held in trust right now: the TRUST_CASH balance, summed over its shard rows.
  trustCash: Amount;

  // USD short. This is `required - trustCash` when cash is underheld, otherwise zero.
  shortfall: Amount;

  backed: boolean;
};

/**
 * One treasury sweep run. A run does one backing check, so each list below holds at most one
 * entry.
 */
export type TreasurySummary = {
  // Backing check result, or null if the check threw before finishing.
  position: BackingPosition | null;

  breaches: ReadonlyArray<{
    shortfall: string;
    required: string;
    held: string;
  }>;

  retrying: ReadonlyArray<{ code: string }>;

  failed: ReadonlyArray<{ code: string }>;
};

type TreasuryTally = {
  position: BackingPosition | null;
  breaches: Array<{ shortfall: string; required: string; held: string }>;
  retrying: Array<{ code: string }>;
  failed: Array<{ code: string }>;
};

/**
 * Check that held USD backs every spendable credit. Measure only: a shortfall is logged and
 * counted, nothing is posted. Errors are caught into the summary rather than propagated, so
 * one bad run can't crash the worker loop.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background
 *   worker} for how the treasury sweep checks backing on a schedule.
 */
export async function sweepTreasury(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number },
): Promise<TreasurySummary> {
  const tally: TreasuryTally = {
    position: null,
    breaches: [],
    retrying: [],
    failed: [],
  };

  try {
    const position = await measureBacking(store, ctx);
    tally.position = position;
    record(ctx, position, input.now);
    if (!position.backed) {
      raiseBreach(ctx, position, input.now, tally);
    }
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
    } else {
      tally.failed.push({ code: normalized.code });
    }
  }

  return tally;
}

// Uses the same custodial-vs-owned classification as the deep integrity check (`backingTotals`).
async function measureBacking(
  store: Store,
  ctx: WorkerCtx,
): Promise<BackingPosition> {
  const { custodialCreditMinor, trustCashMinor } = await backingTotals(
    store.ledger.heads(),
    (account) => store.ledger.balance(account),
  );

  const par = ctx.rates.par('CREDIT');
  const requiredMinor = backingRequiredMinor(custodialCreditMinor, par);
  const shortfallMinor = backingShortfallMinor(requiredMinor, trustCashMinor);

  return {
    custodialCredit: toAmount('CREDIT', custodialCreditMinor),
    required: toAmount('USD', requiredMinor),
    trustCash: toAmount('USD', trustCashMinor),
    shortfall: toAmount('USD', shortfallMinor),
    backed: shortfallMinor === 0n,
  };
}

// Logs at `debug`: a normal run is not an incident. A shortfall is logged at `error` by
// `raiseBreach`.
function record(ctx: WorkerCtx, position: BackingPosition, now: number): void {
  ctx.meter.observe(
    'worker.treasury.custodial_credit',
    toNumber(position.custodialCredit.minor),
  );
  ctx.meter.observe(
    'worker.treasury.trust_cash',
    toNumber(position.trustCash.minor),
  );
  ctx.meter.observe(
    'worker.treasury.shortfall',
    toNumber(position.shortfall.minor),
  );
  ctx.logger.log('debug', 'worker.treasury.swept', {
    backed: position.backed,
    at: now,
  });
}

// Nothing is posted to fix the gap; it is settled elsewhere, from platform revenue, and
// operators act on this signal.
function raiseBreach(
  ctx: WorkerCtx,
  position: BackingPosition,
  now: number,
  tally: TreasuryTally,
): void {
  const breach = {
    shortfall: encodeAmount(position.shortfall),
    required: encodeAmount(position.required),
    held: encodeAmount(position.trustCash),
  };
  tally.breaches.push(breach);
  ctx.meter.count('worker.treasury.breach', 1);
  ctx.logger.log('error', 'worker.treasury.under_backed', {
    ...breach,
    at: now,
  });
}

// Converts bigint minor units to a number for the metrics API, which takes numbers only. A
// platform-scale credit total can exceed 2^53, so this can lose precision. That is fine for a
// metric, but the result must never flow back into a ledger entry, hash, or trace.
function toNumber(minor: bigint): number {
  return Number(minor);
}

// --- Float coverage: the external half of the treasury tie-out --------------------

export type FloatFeed = {
  balance(options?: CallOptions): Promise<Amount>;
};

export type FloatPosition = {
  float: Amount;
  obligations: Amount;
  shortfall: Amount;
  covered: boolean;
};

export type FloatSummary = {
  position: FloatPosition | null;
  breaches: ReadonlyArray<{
    shortfall: string;
    obligations: string;
    float: string;
  }>;
  retrying: ReadonlyArray<{ code: string }>;
  failed: ReadonlyArray<{ code: string }>;
};

export async function sweepFloatCoverage(
  store: Store,
  ctx: WorkerCtx,
  feed: FloatFeed,
  input: { now: number },
): Promise<FloatSummary> {
  const tally: {
    position: FloatPosition | null;
    breaches: Array<{ shortfall: string; obligations: string; float: string }>;
    retrying: Array<{ code: string }>;
    failed: Array<{ code: string }>;
  } = { position: null, breaches: [], retrying: [], failed: [] };
  try {
    const position = await measureFloat(store, ctx, feed, input.now);
    tally.position = position;
    ctx.meter.observe('worker.treasury.float', toNumber(position.float.minor));
    ctx.meter.observe(
      'worker.treasury.float_obligations',
      toNumber(position.obligations.minor),
    );
    ctx.logger.log('debug', 'worker.treasury.float_swept', {
      covered: position.covered,
      at: input.now,
    });
    if (!position.covered) {
      const breach = {
        shortfall: encodeAmount(position.shortfall),
        obligations: encodeAmount(position.obligations),
        float: encodeAmount(position.float),
      };
      tally.breaches.push(breach);
      ctx.meter.count('worker.treasury.float_breach', 1);
      ctx.logger.log('error', 'worker.treasury.float_uncovered', {
        ...breach,
        at: input.now,
      });
    }
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
    } else {
      tally.failed.push({ code: normalized.code });
    }
  }
  return tally;
}

async function measureFloat(
  store: Store,
  ctx: WorkerCtx,
  feed: FloatFeed,
  now: number,
): Promise<FloatPosition> {
  const rate = await ctx.rates.payout('CREDIT', 'USD', now);
  let obligationsMinor = 0n;
  for await (const saga of store.sagas.list()) {
    if (saga.state === 'RESERVED' || saga.state === 'SUBMITTED') {
      // The stored quote is the USD this payout will actually disburse; only rows opened
      // before pricing-at-request are valued at the current rate instead.
      obligationsMinor += (
        saga.payoutUsd ?? convertFloor(saga.reserve, rate, 'USD')
      ).minor;
    }
  }
  // The feed is the injected port; the store and rate reads around it keep their own codes.
  const float = await feed.balance().catch((error) => {
    throw normalizePortError(error);
  });
  const shortfallMinor =
    float.minor < obligationsMinor ? obligationsMinor - float.minor : 0n;
  return {
    float,
    obligations: toAmount('USD', obligationsMinor),
    shortfall: toAmount('USD', shortfallMinor),
    covered: shortfallMinor === 0n,
  };
}

// --- Fee sweep: realizing earned platform fees as cash ----------------------------

/**
 * Outcome of one fee sweep. A duplicate (an earlier run claimed the key) posts nothing and
 * reports `swept` as zero; a fresh run reports the CREDIT realized and the posting that did it.
 */
export type FeeSweepResult =
  | { duplicate: true; swept: Amount }
  | { duplicate: false; swept: Amount; transaction: Transaction };

// A draw over `sweepable` throws COMMINGLING — a hard fault, not a returned value, so the worker
// loop marks the run failed.
// See https://economy-lab-docs.pages.dev/economy/concepts/solvency/ for why a sweep may take only
// the surplus and never users' money.
function assertWithinSweepable(amount: Amount, sweepable: bigint): void {
  if (amount.minor <= sweepable) {
    return;
  }
  throw fault(
    ERROR_CODES.COMMINGLING,
    `Sweeping ${encodeAmount(amount)} exceeds the sweepable revenue ${encodeAmount(
      toAmount('CREDIT', sweepable),
    )}.`,
    {
      detail: {
        amount: encodeAmount(amount),
        sweepable: encodeAmount(toAmount('CREDIT', sweepable)),
      },
    },
  );
}

/**
 * Realizes earned platform fees as platform cash, the only path that converts accrued fees into
 * cash the platform keeps. The read-write counterpart to {@link sweepTreasury}, which only checks.
 *
 * The surplus check, refund-window cap, and idempotency claim all run inside one DB transaction
 * with the touched accounts locked, so a concurrent sweep can't move the numbers between check and
 * post (TOCTOU). REVENUE is CREDIT and trust-cash is USD, and one entry can't mix currencies, so
 * the move splits into two coupled entries that share a rate id, the same as a payout settle.
 *
 * @throws {EconomyError} INVALID_AMOUNT for a non-positive `amount`; COMMINGLING when the
 *   draw would exceed the surplus the platform is allowed to take.
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/solvency/ Solvency} for why a
 *   sweep may take only the surplus.
 */
export async function sweepFees(
  store: Store,
  ctx: WorkerCtx,
  input: { amount: Amount; key?: string },
): Promise<FeeSweepResult> {
  const { amount, key } = input;
  if (amount.minor <= 0n) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'A fee sweep amount must be positive.',
      { detail: { amount: encodeAmount(amount) } },
    );
  }

  return store.transaction(async (unit) => {
    // Claim before any read or posting, so a retry stops here.
    if (key !== undefined) {
      const claim = await unit.idempotency.claim(`sweep:${key}`);
      if (!claim.claimed) {
        return { duplicate: true, swept: toAmount('CREDIT', 0n) };
      }
    }

    // Lock every account the surplus check reads and the posting writes, so a concurrent
    // sweep, payout settle, or top-up can't move the numbers between check and post. Every
    // REVENUE shard is in the set, since the drain may debit any shard. `lockAll` keeps the
    // deadlock-free global order the submit paths use; a hand-rolled order would deadlock.
    await lockAll(unit.ledger, [
      SYSTEM.TRUST_CASH,
      SYSTEM.USD_CLEARING,
      ...shardsOf(SYSTEM.REVENUE, ctx.config.platformShards),
      SYSTEM.STORED_VALUE,
    ]);

    assertWithinSweepable(amount, await sweepableCredit(store, ctx, unit));

    // Use par, not the payout rate: par is the peg trust-cash is held against, so the cash and
    // credit sides stay reconciled. Keep the rate so the two entries below match as one move.
    const rate = ctx.rates.par('CREDIT');
    const usd = convertFloor(amount, rate, 'USD');

    // The drain debits per REVENUE shard, since each shard holds only its own matured balance.
    // The offsetting STORED_VALUE credit and the cash posting below stay on the bare rows: the
    // sweep runs at worker cadence, so those rows see no contention worth spreading.
    const transaction = await postEntry(unit.ledger, {
      txnId: ctx.ids.next('txn'),
      legs: [
        ...(await revenueDrainLegs(ctx, unit, amount)),
        credit(SYSTEM.STORED_VALUE, amount),
      ],
      meta: {
        kind: 'treasury.fee_sweep',
        amount: encodeAmount(amount),
        rateId: rate.rateId,
      },
    });
    await postEntry(unit.ledger, {
      txnId: ctx.ids.next('txn'),
      legs: [debit(SYSTEM.USD_CLEARING, usd), credit(SYSTEM.TRUST_CASH, usd)],
      meta: {
        kind: 'treasury.fee_sweep.cash',
        amount: encodeAmount(usd),
        rateId: rate.rateId,
      },
    });

    // Record the claim against the posting so a replay resolves to a no-op. Recorded inside the
    // unit, so it takes effect only if the postings commit; a rolled-back sweep never burns its
    // key.
    if (key !== undefined) {
      await unit.idempotency.record(`sweep:${key}`, transaction);
    }

    // Enqueued in this same transaction, so event, postings, and idempotency record commit
    // together or not at all. Subject is the CREDIT posting's txn id so a reader can tie the
    // event back to its ledger entry.
    await unit.outbox.enqueue(
      pendingOutbox(ctx.ids, {
        id: ctx.ids.next('evt'),
        type: 'economy.fees.swept',
        version: 1,
        occurredAt: ctx.clock.now(),
        subject: transaction.id,
        audience: 'internal',
        data: { swept: encodeAmount(amount) },
      }),
    );

    return { duplicate: false, swept: amount, transaction };
  });
}

/**
 * Summarizes one fee-realization sweep over a worker cycle. `swept` is the CREDIT realized this
 * cycle. It reads `'CREDIT:0.00'` when there was no sweepable surplus or when an overlapping run
 * already claimed the per-cycle key. `skipped` is true when the available surplus was zero, so
 * nothing was posted or emitted.
 */
export type FeeRealizationSummary = {
  swept: string;
  skipped: boolean;
  duplicate: boolean;
};

/**
 * Realizes fees on a schedule, the write that {@link sweepTreasury} does not do. Each run takes the
 * full amount currently allowed (the smaller of cash surplus and matured revenue) and skips cleanly
 * when there is nothing.
 *
 * The amount is read once, then {@link sweepFees} re-checks the surplus and refund-window math under
 * its own locks at post time. The key is this run's timestamp (`fees:<run time>`), so a retry does
 * nothing.
 */
export async function realizeFees(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number },
): Promise<FeeRealizationSummary> {
  const available = await store.transaction((unit) =>
    sweepableCredit(store, ctx, unit),
  );
  if (available <= 0n) {
    return {
      swept: encodeAmount(toAmount('CREDIT', 0n)),
      skipped: true,
      duplicate: false,
    };
  }

  const result = await sweepFees(store, ctx, {
    amount: toAmount('CREDIT', available),
    key: `fees:${input.now}`,
  });
  return {
    swept: encodeAmount(result.swept),
    skipped: false,
    duplicate: result.duplicate,
  };
}

// The smaller of two ceilings: the cash surplus (in CREDIT at par) and the matured revenue
// summed over the REVENUE shards. Taking the smaller keeps a fee on a still-refundable sale
// off-limits until that sale can't be undone.
async function sweepableCredit(
  store: Store,
  ctx: WorkerCtx,
  unit: Unit,
): Promise<bigint> {
  const surplus = await surplusCredit(store, ctx, unit);
  let settledMinor = 0n;
  for (const { maturedMinor } of await maturedRevenueByShard(ctx, unit)) {
    settledMinor += maturedMinor;
  }
  const ceiling = surplus < settledMinor ? surplus : settledMinor;
  return ceiling < 0n ? 0n : ceiling;
}

// Shared by the cap (sweepableCredit) and the drain (revenueDrainLegs), so both agree on where
// the matured revenue sits.
async function maturedRevenueByShard(
  ctx: WorkerCtx,
  unit: Unit,
): Promise<Array<{ shard: AccountRef; maturedMinor: bigint }>> {
  const byShard: Array<{ shard: AccountRef; maturedMinor: bigint }> = [];
  for (const shard of shardsOf(SYSTEM.REVENUE, ctx.config.platformShards)) {
    const matured = await maturedBalance(unit.ledger, shard, ctx.clock.now(), {
      config: ctx.config,
    });
    byShard.push({ shard, maturedMinor: matured.minor });
  }
  return byShard;
}

// The draw was capped at the same per-shard sum and matured balances only grow, so the legs
// always cover it.
async function revenueDrainLegs(
  ctx: WorkerCtx,
  unit: Unit,
  amount: Amount,
): Promise<Leg[]> {
  const legs: Leg[] = [];
  let remaining = amount.minor;
  for (const { shard, maturedMinor } of await maturedRevenueByShard(
    ctx,
    unit,
  )) {
    if (remaining === 0n) {
      break;
    }
    const take = maturedMinor < remaining ? maturedMinor : remaining;
    if (take > 0n) {
      legs.push(debit(shard, toAmount(amount.currency, take)));
      remaining -= take;
    }
  }
  return legs;
}

// Surplus in CREDIT: trust cash at par minus what is owed to users, counting the same custodial
// accounts as the backing check above.
// See https://economy-lab-docs.pages.dev/economy/concepts/solvency/ for what surplus is and which
// credits count toward the backing total.
async function surplusCredit(
  store: Store,
  ctx: WorkerCtx,
  unit: Unit,
): Promise<bigint> {
  // Balances read through the unit, so the sums see this transaction's view under its locks.
  const { custodialCreditMinor, trustCashMinor } = await backingTotals(
    store.ledger.heads(),
    (account) => unit.ledger.balance(account),
  );
  const par = ctx.rates.par('CREDIT');
  const trustInCredit = usdToCredit(trustCashMinor, par);
  return trustInCredit - custodialCreditMinor;
}

// Reverses `backingRequiredMinor`, converting USD back to CREDIT at par. Both round down, so
// converting credits to USD and back lands at or below where it started.
function usdToCredit(usdMinor: bigint, par: Rate): bigint {
  const factor = par.rate;
  if (factor === 0n) {
    return 0n;
  }
  return mulDiv(usdMinor, 10n ** BigInt(par.scale), factor, 'floor');
}
