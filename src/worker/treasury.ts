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
import { encodeAmount, toAmount } from '#src/money.ts';
import { credit, debit, postEntry } from '#src/ledger.ts';
import { maturedBalance } from '#src/maturity.ts';
import { SYSTEM, classify, currency } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { Transaction, WorkerCtx } from '#src/contract.ts';
import type { Rate, Store, Unit } from '#src/ports.ts';

/**
 * Holds the result of one backing check. The fields report the USD required against users'
 * spendable credits, the USD held, and whether the held cash covers the requirement. A credit
 * is backed when it can be redeemed from cash held in trust at the fixed credit-to-USD "par"
 * rate.
 */
export type BackingPosition = {
  // Credits the platform owes users and must hold USD against. This sums every user's spendable
  // balance plus the escrow for pending purchases in HELD accounts. It excludes earned revenue,
  // promo grants, and payout reserves, none of which a user can spend.
  custodialCredit: Amount;

  // USD required to back `custodialCredit`. This is the credit total converted to USD at par
  // and rounded down.
  required: Amount;

  // USD held in trust right now (TRUST_CASH balance).
  trustCash: Amount;

  // USD short. This is `required - trustCash` when cash is underheld, otherwise zero.
  shortfall: Amount;

  // True when the held cash covers the requirement, which means the shortfall is zero.
  backed: boolean;
};

/**
 * Summarizes one treasury sweep run. A run does one backing check, so each list below holds at
 * most one entry. The lists separate a detected under-backing from a check-time error, so the
 * worker re-runs only retryable cases. The shape mirrors the other worker sweep summaries.
 */
export type TreasurySummary = {
  // Backing check result, or null if the check threw before finishing.
  position: BackingPosition | null;

  // Holds one entry, recorded when the check is under-backed. Each entry carries the USD gap,
  // the USD required, and the USD held, all as text amounts.
  breaches: ReadonlyArray<{
    shortfall: string;
    required: string;
    held: string;
  }>;

  // Transient errors, such as a temporary store failure, worth retrying on the next sweep.
  // `code` is the classification code.
  retrying: ReadonlyArray<{ code: string }>;

  // Permanent errors. These are not retried and are recorded only for visibility.
  failed: ReadonlyArray<{ code: string }>;
};

// Mutable form of TreasurySummary built up during the sweep, returned as the read-only
// summary above.
type TreasuryTally = {
  position: BackingPosition | null;
  breaches: Array<{ shortfall: string; required: string; held: string }>;
  retrying: Array<{ code: string }>;
  failed: Array<{ code: string }>;
};

/**
 * Check that held USD backs every spendable credit and report the result. Run periodically
 * by the background worker, not inside a user request. A shortfall is logged at error and
 * counted; nothing is posted (measure only).
 *
 * Errors thrown while checking are caught into the summary rather than propagated, so one bad
 * run can't crash the worker loop.
 *
 * @example
 *   let summary = await sweepTreasury(store, ctx, { now: ctx.clock.now() });
 *   summary.position?.backed === true; // every spendable credit is fully cash-backed
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/reference/background-worker/ Background worker} for how the treasury sweep checks backing on a schedule.
 */
export async function sweepTreasury(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number },
): Promise<TreasurySummary> {
  let tally: TreasuryTally = {
    position: null,
    breaches: [],
    retrying: [],
    failed: [],
  };

  await assess(store, ctx, input.now, tally);

  return tally;
}

// Runs the backing check and records its outcome. A single try/catch classifies any thrown
// error once. A transient error, such as a temporary store failure, goes to `retrying`, and
// anything else goes to `failed`. Nothing is re-thrown.
async function assess(
  store: Store,
  ctx: WorkerCtx,
  now: number,
  tally: TreasuryTally,
): Promise<void> {
  try {
    let position = await measureBacking(store, ctx);
    tally.position = position;
    record(ctx, position, now);
    if (!position.backed) {
      raiseBreach(ctx, position, now, tally);
    }
  } catch (error) {
    let normalized = normalizeError(error);
    if (normalized.retryable) {
      tally.retrying.push({ code: normalized.code });
      return;
    }
    tally.failed.push({ code: normalized.code });
  }
}

// Computes the backing position. It walks every ledger account and sums the balances that must
// be backed: the custodial CREDIT accounts, which are users' spendable balances and the HELD
// escrow funded from them. It converts that sum to required USD at par and compares it against
// TRUST_CASH. Keying on `classify` excludes earned, promo, and payout-reserve balances, the
// same as the deep integrity check.
async function measureBacking(
  store: Store,
  ctx: WorkerCtx,
): Promise<BackingPosition> {
  let custodialCreditMinor = 0n;
  for await (let [account] of store.ledger.heads()) {
    if (classify(account) === 'custodial' && currency(account) === 'CREDIT') {
      let balance = await store.ledger.balance(account);
      custodialCreditMinor += balance.minor;
    }
  }

  let par = ctx.rates.par('CREDIT');
  let requiredMinor = requiredBackingMinor(custodialCreditMinor, par);
  let trustCash = await store.ledger.balance(SYSTEM.TRUST_CASH);
  let shortfallMinor =
    trustCash.minor < requiredMinor ? requiredMinor - trustCash.minor : 0n;

  return {
    custodialCredit: toAmount('CREDIT', custodialCreditMinor),
    required: toAmount('USD', requiredMinor),
    trustCash,
    shortfall: toAmount('USD', shortfallMinor),
    backed: shortfallMinor === 0n,
  };
}

// Converts a credit amount to its backing USD, rounding down. The rate is stored scaled by
// 10^scale, so this multiplies by par.rate and then divides by 10^scale to undo the scaling.
// This is the same conversion as the integrity check and the top-up and payout paths.
function requiredBackingMinor(custodialCreditMinor: bigint, par: Rate): bigint {
  return (custodialCreditMinor * par.rate) / 10n ** BigInt(par.scale);
}

// Emits the position as metrics plus a debug log on every run, so the credit total, the cash
// held, and the shortfall stay visible over time. It logs at `debug` rather than `error`
// because a normal run is not an incident. An actual shortfall is logged at `error` by
// `raiseBreach`.
function record(ctx: WorkerCtx, position: BackingPosition, now: number): void {
  ctx.meter.observe(
    'economy.treasury.custodial_credit',
    toNumber(position.custodialCredit.minor),
  );
  ctx.meter.observe(
    'economy.treasury.trust_cash',
    toNumber(position.trustCash.minor),
  );
  ctx.meter.observe(
    'economy.treasury.shortfall',
    toNumber(position.shortfall.minor),
  );
  ctx.logger.log('debug', 'economy.treasury.swept', {
    backed: position.backed,
    at: now,
  });
}

// Records a detected shortfall by adding it to the tally, bumping a counter, and logging at
// `error`. Nothing is posted to fix it, and no ledger entry moves USD into the trust account.
// That gap is settled elsewhere, from platform revenue, and operators and the payout path act
// on this signal.
function raiseBreach(
  ctx: WorkerCtx,
  position: BackingPosition,
  now: number,
  tally: TreasuryTally,
): void {
  let breach = {
    shortfall: encodeAmount(position.shortfall),
    required: encodeAmount(position.required),
    held: encodeAmount(position.trustCash),
  };
  tally.breaches.push(breach);
  ctx.meter.count('economy.treasury.breach', 1);
  ctx.logger.log('error', 'economy.treasury.under_backed', {
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

// --- Fee sweep: realizing earned platform fees as cash ----------------------------

/**
 * Reports the outcome of one fee sweep. Each sweep carries an idempotency key, so a retried
 * request takes effect once. `duplicate` is true when an earlier run already claimed the key.
 * A duplicate posts nothing and reports `swept` as zero. A fresh run reports the CREDIT turned
 * into cash in `swept` and the CREDIT posting that did it in `transaction`.
 */
export type FeeSweepResult =
  | { duplicate: true; swept: Amount }
  | { duplicate: false; swept: Amount; transaction: Transaction };

// Enforces that the platform takes only its own money before posting. The `amount` may not
// exceed `sweepable`, the smaller of the cash surplus and matured revenue. Taking more would
// pull trust-cash below what is owed to users. A draw over the limit throws COMMINGLING, a hard
// error rather than a returned "no", so the worker loop marks the run failed instead of leaving
// users under-backed.
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
 * Realizes earned platform fees as platform cash. It moves `amount` of CREDIT out of REVENUE
 * and the matching USD out of the trust account that holds users' money. This is the only path
 * that converts accrued fees into cash the platform keeps. It is the read-write counterpart to
 * {@link sweepTreasury}, which only checks backing.
 *
 * The surplus check, the refund-window cap, and the idempotency claim all run inside one DB
 * transaction with the touched accounts locked, so a concurrent sweep can't move the numbers
 * between the check and the post (TOCTOU). A draw past the surplus throws COMMINGLING. Revenue
 * still inside its refund window is excluded via `maturedBalance(REVENUE)`. A re-run with the
 * same key is a no-op.
 *
 * REVENUE is CREDIT, trust-cash is USD, and one entry can't mix currencies, so the move splits
 * into two coupled entries that share a rate id, the same as a payout settle. A CREDIT entry
 * retires REVENUE against STORED_VALUE, and a USD entry moves cash from trust into clearing.
 *
 * @throws {EconomyError} INVALID_AMOUNT for a non-positive `amount`; COMMINGLING when the
 *   draw would exceed the surplus the platform is allowed to take.
 */
export async function sweepFees(
  store: Store,
  ctx: WorkerCtx,
  input: { amount: Amount; key?: string },
): Promise<FeeSweepResult> {
  let { amount, key } = input;
  if (amount.minor <= 0n) {
    throw fault(
      ERROR_CODES.INVALID_AMOUNT,
      'A fee sweep amount must be strictly positive.',
      { detail: { amount: encodeAmount(amount) } },
    );
  }

  return store.transaction(async (unit) => {
    // Claim the idempotency key before any read or posting, so a retry stops here. A failed
    // claim means another run already swept this request.
    if (key !== undefined) {
      let claim = await unit.idempotency.claim(`sweep:${key}`);
      if (!claim.claimed) {
        return { duplicate: true, swept: toAmount('CREDIT', 0n) };
      }
    }

    // Lock every account the surplus check reads and the posting writes, so a concurrent
    // sweep, payout settle, or top-up can't move the liability or custody cash between the
    // check and the post.
    await unit.ledger.lock(SYSTEM.TRUST_CASH);
    await unit.ledger.lock(SYSTEM.USD_CLEARING);
    await unit.ledger.lock(SYSTEM.REVENUE);
    await unit.ledger.lock(SYSTEM.STORED_VALUE);

    assertWithinSweepable(amount, await sweepableCredit(store, ctx, unit));

    // Convert swept credits to USD at par. Par is the peg that trust-cash is held against and
    // the rate the surplus check uses, so the cash and credit sides stay reconciled. The payout
    // rate is for paying sellers, not for realizing the platform's surplus, so it is not used
    // here. Keep the rate so the CREDIT and USD entries below can be matched as one move.
    let rate = ctx.rates.par('CREDIT');
    let usd = convertToUsd(amount, rate);

    let transaction = await postEntry(unit.ledger, {
      txnId: ctx.ids.next('txn'),
      legs: [
        debit(SYSTEM.REVENUE, amount),
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

    // Queue the "fees swept" event on the outbox in this same transaction, so event, postings,
    // and idempotency record commit together or not at all. Audience `internal`: a
    // treasury/operator concern, not pushed to a client. Subject is the CREDIT posting's txn id
    // so a reader can tie the event back to its ledger entry.
    await unit.outbox.enqueue({
      id: ctx.ids.next('obx'),
      event: {
        id: ctx.ids.next('evt'),
        type: 'economy.fees.swept',
        version: 1,
        occurredAt: ctx.clock.now(),
        subject: transaction.id,
        audience: 'internal',
        data: { swept: encodeAmount(amount) },
      },
      status: 'pending',
      attempts: 0,
      reason: null,
    });

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
 * Realizes fees on a schedule, the write that {@link sweepTreasury} does not do. On each
 * scheduled run it realizes the full amount the platform is currently allowed to take, the
 * smaller of its cash surplus and its matured revenue.
 *
 * The policy is to take everything available and skip cleanly when there is nothing. The amount
 * is read once inside a transaction, and {@link sweepFees} re-checks the surplus and
 * refund-window math under its own locks. A zero read stops before any write. A positive read
 * passes the exact amount to {@link sweepFees}, whose checks gate at post time. The key is built
 * from this run's timestamp (`fees:<run time>`), so a retry does nothing.
 */
export async function realizeFees(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number },
): Promise<FeeRealizationSummary> {
  // Read sweepable surplus first, outside the posting path: if zero, skip without claiming a
  // key or posting anything.
  let available = await store.transaction((unit) =>
    sweepableCredit(store, ctx, unit),
  );
  if (available <= 0n) {
    return {
      swept: encodeAmount(toAmount('CREDIT', 0n)),
      skipped: true,
      duplicate: false,
    };
  }

  let result = await sweepFees(store, ctx, {
    amount: toAmount('CREDIT', available),
    key: `fees:${input.now}`,
  });
  return {
    swept: encodeAmount(result.swept),
    skipped: false,
    duplicate: result.duplicate,
  };
}

// Returns the most credits realizable this run, the smaller of two ceilings. The first is the
// cash surplus, the cash held beyond what is owed to users, converted to CREDIT at par so both
// ceilings share units. The second is the revenue whose refund windows have closed. Taking the
// smaller keeps a fee on a still-refundable sale off-limits until that sale can't be undone.
async function sweepableCredit(
  store: Store,
  ctx: WorkerCtx,
  unit: Unit,
): Promise<bigint> {
  let surplus = await surplusCredit(store, ctx, unit);
  let settled = await maturedBalance(
    unit.ledger,
    SYSTEM.REVENUE,
    ctx.clock.now(),
    {
      config: ctx.config,
    },
  );
  let ceiling = surplus < settled.minor ? surplus : settled.minor;
  return ceiling < 0n ? 0n : ceiling;
}

// Returns the platform surplus in CREDIT. This is trust cash converted to CREDIT at par, minus
// what is owed to users: every user's spendable balance plus HELD escrow. A positive result is
// cash held beyond what is owed, and only that much may be realized. The owed total counts the
// same accounts as the backing check above, so revenue, promo grants, and payout reserves are
// not counted as owed.
async function surplusCredit(
  store: Store,
  ctx: WorkerCtx,
  unit: Unit,
): Promise<bigint> {
  let custodialCreditMinor = 0n;
  for await (let [account] of store.ledger.heads()) {
    if (classify(account) === 'custodial' && currency(account) === 'CREDIT') {
      let balance = await unit.ledger.balance(account);
      custodialCreditMinor += balance.minor;
    }
  }
  let par = ctx.rates.par('CREDIT');
  let trustCash = await unit.ledger.balance(SYSTEM.TRUST_CASH);
  let trustInCredit = usdToCredit(trustCash.minor, par);
  return trustInCredit - custodialCreditMinor;
}

// Converts CREDIT to USD at the given rate, rounding down. The rate is stored scaled by
// 10^scale, so this multiplies by rate.rate and then divides by 10^scale to undo the scaling.
function convertToUsd(amount: Amount, rate: Rate): Amount {
  return toAmount(
    'USD',
    (amount.minor * rate.rate) / 10n ** BigInt(rate.scale),
  );
}

// Converts USD back to CREDIT at par, rounding down. This reverses `requiredBackingMinor`,
// which goes from CREDIT to USD. Both round down, so a round trip from credits to USD and back
// lands at or below where it started.
function usdToCredit(usdMinor: bigint, par: Rate): bigint {
  let factor = par.rate;
  if (factor === 0n) {
    return 0n;
  }
  return (usdMinor * 10n ** BigInt(par.scale)) / factor;
}
