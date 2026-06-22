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
 * The result of one backing check: how much real USD the platform must hold against
 * users' spendable credits, how much it actually holds, and whether that's enough.
 *
 * "Backing" means every spendable credit a user holds is covered by real USD set aside
 * in trust. The platform promises that it always holds at least enough cash to redeem
 * every spendable credit at the fixed credit-to-USD conversion rate (called the "par"
 * rate); this type records whether that promise currently holds.
 */
export type BackingPosition = {
  // Total credits the platform actually owes its users and must hold real USD against:
  // every user's spendable balance plus the credits held in escrow for pending purchases
  // (the HELD accounts). These are the only balances that count toward the cash the
  // platform must hold; revenue it has earned, promotional grants, and payout reserves are
  // deliberately left out, because none of those are credits a user can spend.
  custodialCredit: Amount;

  // The USD that must be held to back `custodialCredit`: the credit total converted to
  // USD at the fixed credit-to-USD conversion rate (the "par" rate), rounded down.
  required: Amount;

  // The USD actually held in trust right now (the TRUST_CASH account's balance).
  trustCash: Amount;

  // The amount of USD the platform is short, i.e. `required − trustCash` when it holds
  // too little, otherwise zero.
  shortfall: Amount;

  // True when the held cash covers the requirement (shortfall is zero).
  backed: boolean;
};

/**
 * What one run of the treasury sweep produced. Each run does exactly one backing check,
 * so at most one entry lands in each of the lists below. The lists separate a detected
 * under-backing from an error that happened while checking, so the worker can re-run only
 * the cases worth retrying. This mirrors the summary shape the other worker sweeps return.
 */
export type TreasurySummary = {
  // The backing check's result, or null if the check could not complete (an error was
  // thrown before it finished).
  position: BackingPosition | null;

  // Recorded once when the platform is under-backed: the USD gap, the USD required, and
  // the USD actually held, each as a text amount.
  breaches: ReadonlyArray<{
    shortfall: string;
    required: string;
    held: string;
  }>;

  // Errors that look transient (e.g. a temporary store failure) and so are worth a retry
  // on the next sweep. `code` is the error's classification code.
  retrying: ReadonlyArray<{ code: string }>;

  // Errors that are permanent and not worth retrying, recorded so they're visible.
  failed: ReadonlyArray<{ code: string }>;
};

// The mutable form of TreasurySummary the sweep builds up as it runs, before returning
// it as the read-only summary above.
type TreasuryTally = {
  position: BackingPosition | null;
  breaches: Array<{ shortfall: string; required: string; held: string }>;
  retrying: Array<{ code: string }>;
  failed: Array<{ code: string }>;
};

/**
 * Check that the platform holds enough real USD to back every spendable credit, and
 * report the result. Run periodically by the background worker (not inside a user
 * request). If the cash held falls short, that is logged as an error and counted, but
 * nothing is posted to the ledger — the check only measures and reports.
 *
 * Any error thrown while checking is caught and turned into an entry in the returned
 * summary instead of propagating, so one bad run can never crash the worker loop.
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

// Run the single backing check and record its outcome into the tally. The whole thing
// is wrapped in one try/catch: if an error is thrown, it is classified once — a transient
// error (e.g. a temporary store failure) goes to `retrying` so the next sweep retries it,
// and any other error goes to `failed`. Either way nothing is re-thrown, so one bad read
// never crashes the worker loop.
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

// Compute the backing position. Walk every account in the ledger, add up the balances of
// the ones that must be backed (users' spendable balances and the escrow funded from
// them, HELD — these are the accounts `classify` calls 'custodial'), convert that credit
// total to the USD it requires at the par rate, and compare against the USD actually held
// in TRUST_CASH. Using `classify` here means earned, promo, and payout-reserve balances
// are never counted, exactly as in the deep integrity check.
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

// Convert a credit amount to the USD needed to back it, rounding down: multiply by the
// par rate and divide out its scale. The rate is stored as a whole number scaled by
// 10^scale, so dividing by 10^scale recovers the real multiplier. This is the same
// conversion the integrity check and the top-up/payout paths use.
function requiredBackingMinor(custodialCreditMinor: bigint, par: Rate): bigint {
  return (custodialCreditMinor * par.rate) / 10n ** BigInt(par.scale);
}

// Emit the position as metrics and a debug log on every run, so the credit total, cash
// held, and any shortfall are visible over time. This logs at `debug`, not `error`,
// because a normal run is not an incident and should not show up on the error dashboard;
// an actual shortfall is logged separately at `error` by `raiseBreach`.
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

// Record a detected shortfall: add it to the tally, bump a counter, and log it at
// `error` so it is surfaced loudly rather than passed over. A shortfall is exactly the
// failure the backing guarantee exists to prevent. Nothing is posted to the ledger to
// fix it — there is no ledger entry that could move USD into the trust account, and that
// gap is settled elsewhere (from platform revenue), so raising this signal is all this
// function does. Operators and the payout path act on it.
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

// Convert a bigint minor-unit amount to a number for the metrics API, which only accepts
// numbers. A credit total at platform scale can exceed what a number represents exactly
// (about 2^53), so this conversion can lose precision. That is acceptable for a metric,
// but the result must never flow back into a ledger entry, a hash, or a trace, where the
// exact value matters.
function toNumber(minor: bigint): number {
  return Number(minor);
}

// --- Fee sweep: realizing earned platform fees as cash ----------------------------

/**
 * What one fee sweep produced. Each sweep carries an idempotency key — a value that makes a
 * retried request take effect only once. `duplicate` is true when that key was already
 * claimed by an earlier run, meaning this run is a retry: nothing was posted and `swept` is
 * zero. On a fresh run `swept` is the CREDIT amount turned into cash and `transaction` is
 * the CREDIT posting that did it.
 */
export type FeeSweepResult =
  | { duplicate: true; swept: Amount }
  | { duplicate: false; swept: Amount; transaction: Transaction };

/**
 * Turn earned platform fees into spendable cash for the platform: move `amount` of CREDIT
 * out of the platform's REVENUE account and move the matching USD out of the trust account
 * that holds users' money. This is the only path that converts the platform's accrued fees
 * into cash it can keep. It is the read-and-write counterpart to {@link sweepTreasury},
 * which only checks backing and never posts anything.
 *
 * Three checks stand between the request and the posting. They all run inside one database
 * transaction with the touched accounts locked, so another sweep running at the same time
 * can never change the numbers between the check and the post:
 *
 *  - No dipping into users' money: the platform may only ever take its own surplus — the
 *    cash it holds beyond what it currently owes users. That liability is every user's
 *    spendable balance plus everything in escrow (the HELD accounts), converted to USD at
 *    the par rate. A draw that would push the trust-cash account below that liability throws
 *    COMMINGLING (the error code for mixing the platform's money with users') and posts
 *    nothing.
 *  - Refund window not yet passed: a fee earned on a sale that can still be refunded is not
 *    yet the platform's to keep, so the amount it may take is also capped at the portion of
 *    REVENUE whose refund windows have already closed (`maturedBalance(REVENUE)`).
 *  - Run at most once: an idempotency key is claimed inside the transaction, so a re-run of
 *    the same sweep does nothing instead of posting a second time.
 *
 * Because REVENUE is denominated in CREDIT and the trust-cash account in USD, the two
 * sides cannot sit in one ledger entry — a single entry mixing currencies would be
 * rejected. So the move is split into two coupled entries, the same way a payout settles:
 * one CREDIT entry retires the swept amount out of REVENUE (offsetting it against
 * STORED_VALUE, the account that tracks total credit ever issued), and one USD entry moves
 * the matching cash out of the trust account into the clearing account. The two entries are
 * tied together by a shared rate id recording the conversion rate used.
 *
 * @throws {EconomyError} INVALID_AMOUNT for a non-positive `amount`; COMMINGLING when the
 *   draw would exceed the surplus the platform is allowed to take.
 */
// Enforce, before a sweep posts, that the platform takes only its own money: the amount may
// never exceed `sweepable` — the most it is allowed to take, which is the smaller of its cash
// surplus and the revenue whose refund windows have closed. Taking more would pull the
// trust-cash account below what the platform owes users. This throws COMMINGLING as a hard
// error (not a normal "no" returned to the caller), so the worker loop sets the run aside as
// failed rather than quietly leaving users under-backed.
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
    // Claim the idempotency key first, before any read or posting, so a retry of the same sweep
    // stops right here. Failing to claim it means another run already swept this same request.
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

    // Convert the swept credits to USD at the par rate — the peg the trust-cash account is held
    // against, and the same rate the surplus check above uses, so the cash side and the credit
    // side stay reconciled. (The payout rate is for paying sellers out, not for the platform
    // realizing its own surplus.) Remember which rate was used so the CREDIT entry and the USD
    // entry below can be matched up as one move later.
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

    // Record the claim against the realizing posting so a replay of this window resolves to a
    // no-op. Recorded inside the unit, so it only takes effect if the postings commit — a
    // rolled-back sweep never burns its key.
    if (key !== undefined) {
      await unit.idempotency.record(`sweep:${key}`, transaction);
    }

    // Queue the "fees swept" event on the outbox inside this same transaction, so the event,
    // the two postings, and the idempotency record all commit together or not at all. A
    // rolled-back sweep leaves no stray event; a committed one is guaranteed to have queued
    // exactly one. Audience is `internal` — this is a treasury/operator concern, not something
    // pushed to a client. The subject is the CREDIT posting's transaction id, so whatever reads
    // the event can tie it back to the ledger entry it came from.
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
 * What one fee-realization sweep produced over a worker cycle. `swept` is the CREDIT amount
 * realized this cycle (`'CREDIT:0.00'` when there was no sweepable surplus, or when the
 * per-cycle key was already claimed by an earlier overlapping run). `skipped` is true when the
 * available surplus was zero, so nothing was posted or emitted.
 */
export type FeeRealizationSummary = {
  swept: string;
  skipped: boolean;
  duplicate: boolean;
};

/**
 * The action {@link sweepTreasury} cannot take, since that one only measures: on each
 * scheduled worker run, turn the full amount the platform is currently allowed to take into
 * cash. That amount is the smaller of two figures — the platform's cash surplus, and the
 * revenue whose refund windows have already closed — and this realizes all of it.
 *
 * The policy is simply: take everything available, and skip cleanly when there is nothing.
 * The available amount is read once inside a transaction (the same surplus and refund-window
 * math {@link sweepFees} re-checks while holding its locks). A zero read stops before any
 * write; a positive read passes the exact amount to {@link sweepFees}, whose own checks are
 * the real gate at the moment of posting. The key passed to that call is built from this
 * run's timestamp (`fees:<run time>`), so a retry of the same run does nothing the second
 * time.
 */
export async function realizeFees(
  store: Store,
  ctx: WorkerCtx,
  input: { now: number },
): Promise<FeeRealizationSummary> {
  // Read the available sweepable surplus first, outside the posting path: if it is zero there
  // is nothing to realize this cycle, so skip without claiming a key or posting an entry.
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

// The most credits the platform may turn into cash on this run: the smaller of two ceilings.
// One is the cash surplus — the cash it holds beyond what it owes users — converted into
// CREDIT at the par rate so both ceilings are in the same units. The other is the revenue
// whose refund windows have already closed. Taking the smaller of the two keeps a fee earned
// on a sale that could still be refunded off-limits until that sale can no longer be undone.
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

// The platform's surplus, expressed in CREDIT: take the trust cash it holds, convert it to
// CREDIT at the par rate, and subtract what it owes users — every user's spendable balance
// plus everything in escrow (the HELD accounts), added up. A positive result is cash the
// platform holds beyond what it owes; only that much may ever be turned into its own cash.
// The "what it owes" total here counts exactly the same accounts as the backing check above,
// so revenue, promotional grants, and payout reserves are never counted as owed to users.
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

// Convert a CREDIT amount to USD at the given rate, rounding down. The rate is stored as a
// whole number scaled up by a power of ten (its `scale`), so multiply by that number and then
// divide by ten-to-the-scale to undo the scaling and get the true conversion.
function convertToUsd(amount: Amount, rate: Rate): Amount {
  return toAmount(
    'USD',
    (amount.minor * rate.rate) / 10n ** BigInt(rate.scale),
  );
}

// Convert a USD amount back into CREDIT at the par rate, rounding down — the reverse of
// `requiredBackingMinor`, which goes from CREDIT to USD. Because both round down, a round trip
// (credits to USD and back) can only ever land at or below where it started, never above.
function usdToCredit(usdMinor: bigint, par: Rate): bigint {
  let factor = par.rate;
  if (factor === 0n) {
    return 0n;
  }
  return (usdMinor * 10n ** BigInt(par.scale)) / factor;
}
