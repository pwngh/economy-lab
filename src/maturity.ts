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

import { add, toAmount, zero } from '#src/money.ts';
import { currency } from '#src/accounts.ts';

import type { Amount } from '#src/money.ts';
import type { AccountRef } from '#src/accounts.ts';
import type { Config } from '#src/config.ts';
import type { Ledger, Lot } from '#src/ports.ts';

/**
 * Bundles the maturity config and an optional signal into one parameter. Bundling keeps the
 * functions under the param-count limit while still passing the caller's AbortSignal through to the
 * ledger's balance read.
 */
export type MaturityOptions = { config: Config; signal?: AbortSignal };

/**
 * Carries {@link maturedAtLeast}'s options. It extends {@link MaturityOptions} with the `amount` the
 * cashable balance must reach. The `amount` rides in the options object rather than as its own
 * argument so the call stays parallel to {@link maturedBalance}'s `(ledger, account, now, options)`
 * and under the param-count limit.
 */
export type MaturedAtLeastOptions = MaturityOptions & { amount: Amount };

// Horizon lookup key for an unrecognized funding source. The 'default' horizon is configured
// independently through MATURITY_HORIZON_DEFAULT_MS. It coincides with the card horizon only under
// the shipped defaults, so an unknown source settles on its own conservative wait.
let DEFAULT_SOURCE: string = 'default';

/**
 * Returns the wait in milliseconds before credits from a funding source can be cashed out. The wait
 * covers the window in which the payment could still be reversed, such as a card chargeback. A
 * source not in the config falls back to the 'default' horizon, so an unknown or misspelled source
 * is treated cautiously rather than as instantly available.
 */
export function maturityHorizonMs(source: string, config: Config): number {
  let horizons = config.maturityHorizonMs;
  let exact = horizons[source];
  if (exact !== undefined) {
    return exact;
  }
  return horizons[DEFAULT_SOURCE] ?? horizons.card ?? 0;
}

/**
 * Returns the moment in epoch milliseconds a lot becomes cashable, which is the top-up time plus the
 * source's required wait. A lot is one batch of credits from a single top-up, tagged with when it
 * was added and its funding source. The wait is computed here from `source` rather than read from
 * the lot's own `maturesAt`, because a top-up may record the source without a maturity time.
 */
export function lotMaturesAt(lot: Lot, config: Config): number {
  return lot.toppedUpAt + maturityHorizonMs(lot.source, config);
}

/**
 * Reports whether a lot is cashable as of `now`. The boundary is inclusive, so the lot is cashable
 * the moment its wait elapses.
 */
export function isMatured(lot: Lot, now: number, config: Config): boolean {
  return lotMaturesAt(lot, config) <= now;
}

// How many lots to read from the ledger per bounded page. Most balances are covered by the newest
// lot or two, so the first page almost always suffices. A wider tail, such as many small unspent
// top-ups, just pulls the next page. The size keeps the common case to one round-trip while
// bounding memory.
let TAIL_PAGE = 64;

/**
 * Returns the cashable part of an account's balance as of `now`. This is how much a cash-out may
 * draw without dipping into funds still in their settlement wait.
 *
 * Spends draw oldest-first (FIFO), so what is left is the newest run of lots summing to the live
 * balance. Finding that run by scanning the whole history is the old O(account history) path, kept
 * as {@link maturedBalanceFullScan} for the differential test. Instead, read lots NEWEST-first and
 * stop the instant they cover the balance. That yields the identical tail computed from the new end,
 * never touching the already-spent history. Sum the matured lots as we go. The drain splits the
 * oldest lot in the tail, so only its unspent remainder (`remaining`) counts, exactly as the old
 * `fifoTail` split it.
 *
 * This is currency-agnostic, so the same call covers spendable credits and a seller's earned
 * balance.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/lifecycles/ Lifecycles} for the
 * settlement window and chargeback maturity model these cleared-funds checks gate on.
 */
export async function maturedBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  let live = await ledger.balance(account, { signal: options.signal });
  let unit = currency(account);
  // A zero or negative balance has no remaining lots, so nothing is cashable.
  if (live.minor <= 0n) {
    return zero(unit);
  }

  let remaining = live.minor;
  let matured = 0n;
  // Walk the newest lots first, a bounded page at a time. The ledger pushes the `order desc
  // limit/offset` down to the engine, so each page is bounded DB work. Paging stops the moment
  // `remaining` hits zero.
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (let lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      // The boundary lot contributes only what is left to cover. A fully-included lot contributes
      // its whole amount.
      let take = lot.amount.minor < remaining ? lot.amount.minor : remaining;
      if (lotMaturesAt(lot, options.config) <= now) {
        matured += take;
      }
      remaining -= take;
      if (remaining === 0n) {
        break;
      }
    }
    // The page returned no lots, so the history is exhausted before the balance was covered. This is
    // only possible if a balance row outran its lots. Stop here rather than loop forever.
    if (drained === 0) {
      break;
    }
  }
  return toAmount(unit, matured);
}

/**
 * Reports whether an account has at least `amount` of cashable balance as of `now`, without
 * computing the full matured total. The callers that gate on maturity (requestPayout's payable-funds
 * check and spend's spendable-funds check) only ask whether matured is at least `amount`, so this
 * answers exactly that and stops the instant it can.
 *
 * It reads the same newest-first FIFO tail as {@link maturedBalance}, the newest run of lots summing
 * to the live balance. It accumulates each lot's matured contribution and returns `true` the moment
 * that running sum reaches `amount`. If the tail is exhausted first, the matured part never covers
 * `amount`, so it returns `false`. A request well within cleared funds therefore stops after a lot
 * or two, at cost O(amount-worth-of-lots). The worst case is the maturity horizon's window, never
 * the full history. By construction this equals `maturedBalance(...).minor >= amount.minor` for
 * every input: identical lots and identical per-lot maturity, just stopped as soon as the answer is
 * settled.
 *
 * The `amount` and the account share a currency, since the callers pass a CREDIT amount against a
 * CREDIT balance, so only the minor units are compared. A non-positive `amount` is trivially
 * covered.
 */
export async function maturedAtLeast(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturedAtLeastOptions,
): Promise<boolean> {
  let need = options.amount.minor;
  if (need <= 0n) {
    return true;
  }
  let live = await ledger.balance(account, { signal: options.signal });
  if (live.minor <= 0n) {
    return false;
  }

  let remaining = live.minor;
  let matured = 0n;
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (let lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      // This is the same FIFO-tail split as maturedBalance. The boundary lot contributes only what
      // is left to cover the live balance, and a fully-included lot contributes its whole amount.
      // Only matured lots count.
      let take = lot.amount.minor < remaining ? lot.amount.minor : remaining;
      if (lotMaturesAt(lot, options.config) <= now) {
        matured += take;
        if (matured >= need) {
          return true;
        }
      }
      remaining -= take;
      if (remaining === 0n) {
        break;
      }
    }
    if (drained === 0) {
      break;
    }
  }
  return false;
}

/**
 * Computes the cashable balance by scanning the full history. This is the original implementation,
 * kept verbatim as the oracle the differential test checks the bounded {@link maturedBalance}
 * against. It reads every lot oldest-first, derives the spent amount from the total, keeps the FIFO
 * tail, then sums the matured ones. It is correct but O(account history), which is the very cost the
 * bounded path removes, so it lives here only for tests and never on the production read path.
 */
export async function maturedBalanceFullScan(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  let live = await ledger.balance(account, { signal: options.signal });
  let unit = currency(account);
  if (live.minor <= 0n) {
    return zero(unit);
  }

  let lots = await collectLots(ledger, account, options.config);
  let tail = fifoTail(lots, live.minor);
  return sumMatured(tail, now, unit);
}

/**
 * Returns the part of an account's balance still in its settlement wait as of `now`. The cashable
 * and still-waiting amounts sum to the current balance.
 */
export async function immatureBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  let live = await ledger.balance(account, { signal: options.signal });
  let matured = await maturedBalance(ledger, account, now, options);
  return toAmount(currency(account), live.minor - matured.minor);
}

// --- Which lots are left, then which have matured --------------------

// A lot trimmed to the two fields the calculation needs: the amount and the moment it becomes
// cashable. Trimming keeps each helper simple and computes maturity in one place.
type Settled = { minor: bigint; maturesAt: number };

// Reads every lot for the account, oldest first, reduced to Settled. The ledger only turns
// balance-increasing entries into lots, so each amount is positive. Maturity is computed from the
// funding source, not taken from the lot's own maturesAt.
async function collectLots(
  ledger: Ledger,
  account: AccountRef,
  config: Config,
): Promise<Settled[]> {
  let lots: Settled[] = [];
  for await (let lot of ledger.timeline(account)) {
    lots.push({
      minor: lot.amount.minor,
      maturesAt: lotMaturesAt(lot, config),
    });
  }
  return lots;
}

// Returns the most recent run of lots summing to the current balance. Spends drain oldest-first, so
// spent = (sum of all lots) - (current balance). The walk goes oldest-first and skips the spent
// amount, splitting the lot that spending stopped partway through, then keeps the rest.
function fifoTail(
  lots: ReadonlyArray<Settled>,
  balanceMinor: bigint,
): Settled[] {
  let total = lots.reduce((sum, lot) => sum + lot.minor, 0n);
  let toDrain = total - balanceMinor;
  if (toDrain <= 0n) {
    return [...lots];
  }
  let tail: Settled[] = [];
  for (let lot of lots) {
    if (toDrain <= 0n) {
      tail.push(lot);
      continue;
    }
    if (toDrain >= lot.minor) {
      toDrain -= lot.minor;
      continue;
    }
    tail.push({ minor: lot.minor - toDrain, maturesAt: lot.maturesAt });
    toDrain = 0n;
  }
  return tail;
}

// Adds up the remaining lots whose wait has elapsed by `now` to get the cashable balance.
function sumMatured(
  tail: ReadonlyArray<Settled>,
  now: number,
  unit: Amount['currency'],
): Amount {
  let matured = zero(unit);
  for (let lot of tail) {
    if (lot.maturesAt <= now) {
      matured = add(matured, toAmount(unit, lot.minor));
    }
  }
  return matured;
}

// --- Why this module computes maturity instead of trusting the lot ----------------
//
// The ledger fills a lot's `source` from the original posting's funding info. When that info is
// missing it defaults to the source value 'unknown', which resolves through the 'default' horizon
// entry (configurable via MATURITY_HORIZON_DEFAULT_MS, and equal to the card horizon only under the
// shipped defaults). So any handler issuing spendable credits must record the funding source on the
// posting, as the top-up handler already does. Otherwise its credits fall back to the default
// horizon. That fallback is still safe, never instantly cashable, just less precise than the real
// source.
//
// Maturity is computed as (top-up time) + (source's required wait). We deliberately do not trust
// the lot's own `maturesAt`, which the ledger defaults to the top-up time (immediately cashable)
// when the posting recorded no maturity. Correctness depends only on the funding source and top-up
// time, not on a precomputed maturity time.
