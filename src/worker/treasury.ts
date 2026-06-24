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
 * One backing check: USD required against users' spendable credits, USD held, and whether
 * that covers it. Backing = every spendable credit redeemable at the fixed credit-to-USD
 * "par" rate from cash held in trust.
 */
export type BackingPosition = {
  // Credits the platform owes users and must hold USD against: every user's spendable
  // balance plus escrow for pending purchases (HELD accounts). Excludes earned revenue,
  // promo grants, and payout reserves, none of which a user can spend.
  custodialCredit: Amount;

  // USD required to back `custodialCredit`: the credit total converted to USD at par,
  // rounded down.
  required: Amount;

  // USD held in trust right now (TRUST_CASH balance).
  trustCash: Amount;

  // USD short: `required − trustCash` when underheld, else zero.
  shortfall: Amount;

  // Held cash covers the requirement (shortfall is zero).
  backed: boolean;
};

/**
 * One treasury sweep run. A run does one backing check, so each list below holds at most one
 * entry. Lists separate a detected under-backing from a check-time error so the worker
 * re-runs only retryable cases. Mirrors the other worker sweep summaries.
 */
export type TreasurySummary = {
  // Backing check result, or null if the check threw before finishing.
  position: BackingPosition | null;

  // Recorded once when under-backed: USD gap, USD required, USD held, as text amounts.
  breaches: ReadonlyArray<{
    shortfall: string;
    required: string;
    held: string;
  }>;

  // Transient errors (e.g. a temporary store failure) worth retrying next sweep. `code` is
  // the classification code.
  retrying: ReadonlyArray<{ code: string }>;

  // Permanent errors, not retried, recorded for visibility.
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

// Run the backing check and record its outcome. One try/catch: a thrown error is classified
// once; transient (e.g. a temporary store failure) goes to `retrying`, anything else to
// `failed`. Nothing is re-thrown.
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

// Compute the backing position. Walk every ledger account, sum the balances that must be
// backed (custodial CREDIT accounts: users' spendable balances and HELD escrow funded from
// them), convert to required USD at par, compare against TRUST_CASH. Keying on `classify`
// excludes earned, promo, and payout-reserve balances, same as the deep integrity check.
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

// Credit amount to backing USD, rounding down: multiply by par.rate, divide by 10^scale
// (the rate is stored scaled by 10^scale). Same conversion as the integrity check and the
// top-up/payout paths.
function requiredBackingMinor(custodialCreditMinor: bigint, par: Rate): bigint {
  return (custodialCreditMinor * par.rate) / 10n ** BigInt(par.scale);
}

// Emit the position as metrics plus a debug log every run, so credit total, cash held, and
// shortfall are visible over time. Logs at `debug`, not `error`: a normal run isn't an
// incident. An actual shortfall is logged at `error` by `raiseBreach`.
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

// Record a detected shortfall: add to the tally, bump a counter, log at `error`. Nothing is
// posted to fix it; no ledger entry moves USD into the trust account. That gap is settled
// elsewhere (from platform revenue); operators and the payout path act on this signal.
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

// bigint minor units to number for the metrics API (numbers only). A platform-scale credit
// total can exceed 2^53, so this can lose precision. Fine for a metric; the result must
// never flow back into a ledger entry, hash, or trace.
function toNumber(minor: bigint): number {
  return Number(minor);
}

// --- Fee sweep: realizing earned platform fees as cash ----------------------------

/**
 * One fee sweep. Each sweep carries an idempotency key so a retried request takes effect
 * once. `duplicate` is true when the key was already claimed by an earlier run (a retry:
 * nothing posted, `swept` zero). On a fresh run `swept` is the CREDIT turned into cash and
 * `transaction` is the CREDIT posting that did it.
 */
export type FeeSweepResult =
  | { duplicate: true; swept: Amount }
  | { duplicate: false; swept: Amount; transaction: Transaction };

// Before posting, enforce that the platform takes only its own money: `amount` may not exceed
// `sweepable` (smaller of cash surplus and matured revenue). Taking more would pull trust-cash
// below what is owed users. Throws COMMINGLING (a hard error, not a returned "no"), so the
// worker loop marks the run failed rather than leaving users under-backed.
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
 * Realize earned platform fees as platform cash: move `amount` of CREDIT out of REVENUE and
 * the matching USD out of the trust account holding users' money. Only path that converts
 * accrued fees into cash the platform keeps. Read-write counterpart to {@link sweepTreasury},
 * which only checks backing.
 *
 * Three checks gate the posting, all inside one DB transaction with the touched accounts
 * locked, so a concurrent sweep can't move the numbers between check and post:
 *
 *  - Don't dip into users' money: take only the surplus, cash held beyond what is owed users.
 *    That liability is every user's spendable balance plus HELD escrow, converted to USD at
 *    par. A draw pushing trust-cash below it throws COMMINGLING and posts nothing.
 *  - Refund window not yet closed: a fee on a still-refundable sale isn't yet the platform's,
 *    so the take is also capped at the matured portion of REVENUE (`maturedBalance(REVENUE)`).
 *  - Run at most once: an idempotency key is claimed inside the transaction, so a re-run does
 *    nothing.
 *
 * REVENUE is CREDIT and trust-cash is USD, and a single entry can't mix currencies, so the
 * move splits into two coupled entries (same as a payout settle): one CREDIT entry retires
 * the swept amount from REVENUE (offset against STORED_VALUE, total credit ever issued), one
 * USD entry moves the cash from trust into clearing. The two share a rate id recording the
 * conversion rate.
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

    // Convert swept credits to USD at par, the peg trust-cash is held against and the rate the
    // surplus check uses, so the cash and credit sides stay reconciled. (The payout rate is for
    // paying sellers, not for realizing the platform's surplus.) Keep the rate so the CREDIT and
    // USD entries below can be matched as one move.
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
    });

    return { duplicate: false, swept: amount, transaction };
  });
}

/**
 * One fee-realization sweep over a worker cycle. `swept` is the CREDIT realized this cycle
 * (`'CREDIT:0.00'` when no sweepable surplus, or the per-cycle key was already claimed by an
 * overlapping run). `skipped` is true when available surplus was zero, so nothing posted or
 * emitted.
 */
export type FeeRealizationSummary = {
  swept: string;
  skipped: boolean;
  duplicate: boolean;
};

/**
 * The write {@link sweepTreasury} doesn't do: on each scheduled run, realize the full amount
 * the platform is currently allowed to take, the smaller of its cash surplus and matured
 * revenue.
 *
 * Policy: take everything available, skip cleanly when there's nothing. The amount is read
 * once inside a transaction ({@link sweepFees} re-checks the surplus and refund-window math
 * under its locks). A zero read stops before any write; a positive read passes the exact
 * amount to {@link sweepFees}, whose checks gate at post time. The key is built from this
 * run's timestamp (`fees:<run time>`), so a retry does nothing.
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

// Most credits realizable this run: smaller of two ceilings. One is the cash surplus (cash
// held beyond what is owed users), converted to CREDIT at par so both ceilings share units.
// The other is revenue whose refund windows have closed. The smaller keeps a fee on a
// still-refundable sale off-limits until that sale can't be undone.
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

// Platform surplus in CREDIT: trust cash converted to CREDIT at par, minus what is owed users
// (every user's spendable balance plus HELD escrow). A positive result is cash held beyond
// what is owed; only that much may be realized. The owed total counts the same accounts as the
// backing check above, so revenue, promo grants, and payout reserves aren't counted as owed.
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

// CREDIT to USD at the given rate, rounding down. The rate is stored scaled by 10^scale, so
// multiply by rate.rate then divide by 10^scale to undo the scaling.
function convertToUsd(amount: Amount, rate: Rate): Amount {
  return toAmount(
    'USD',
    (amount.minor * rate.rate) / 10n ** BigInt(rate.scale),
  );
}

// USD back to CREDIT at par, rounding down. Reverse of `requiredBackingMinor` (CREDIT to USD).
// Both round down, so a round trip (credits to USD and back) lands at or below where it
// started.
function usdToCredit(usdMinor: bigint, par: Rate): bigint {
  let factor = par.rate;
  if (factor === 0n) {
    return 0n;
  }
  return (usdMinor * 10n ** BigInt(par.scale)) / factor;
}
