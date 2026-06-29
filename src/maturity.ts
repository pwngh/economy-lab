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
 * Bundled into one parameter to stay under the param-count limit while still
 * passing the caller's AbortSignal through to the ledger's balance read.
 */
export type MaturityOptions = { config: Config; signal?: AbortSignal };

/**
 * {@link maturedAtLeast}'s options: the maturity config (and optional signal) plus the `amount` the
 * cashable balance must reach. `amount` rides in the options object rather than as its own argument
 * so the call stays parallel to {@link maturedBalance}'s `(ledger, account, now, options)` and under
 * the param-count limit.
 */
export type MaturedAtLeastOptions = MaturityOptions & { amount: Amount };

// Horizon lookup key for an unrecognized funding source. The 'default' horizon is
// configured independently (MATURITY_HORIZON_DEFAULT_MS), only coinciding with the card
// horizon under the shipped defaults, so an unknown source settles on its own conservative wait.
let DEFAULT_SOURCE: string = 'default';

/**
 * Wait (ms) before credits from a funding source can be cashed out, covering the
 * window in which the payment could still be reversed (e.g. a card chargeback).
 * Sources not in the config fall back to the 'default' horizon, so an unknown or
 * misspelled source is treated cautiously rather than instantly available.
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
 * Moment (epoch ms) a lot becomes cashable: top-up time plus the source's required wait.
 * A lot is one batch of credits from a single top-up, tagged with when it was added and
 * its funding source. Wait is computed here from `source` rather than read from the lot's
 * own `maturesAt`, since a top-up may record the source without a maturity time.
 */
export function lotMaturesAt(lot: Lot, config: Config): number {
  return lot.toppedUpAt + maturityHorizonMs(lot.source, config);
}

/**
 * Whether a lot is cashable as of `now`. Inclusive: cashable the moment the wait elapses.
 */
export function isMatured(lot: Lot, now: number, config: Config): boolean {
  return lotMaturesAt(lot, config) <= now;
}

// How many lots to read from the ledger per bounded page. Most balances are covered by the newest
// lot or two, so the first page almost always suffices; a wider tail (many small unspent top-ups)
// just pulls the next page. Sized to keep the common case to one round-trip while bounding memory.
let TAIL_PAGE = 64;

/**
 * Cashable part of an account's balance as of `now`: how much a cash-out may draw without
 * dipping into funds still in their settlement wait.
 *
 * Spends draw oldest-first (FIFO), so what's left is the newest run of lots summing to the live
 * balance. Rather than scan the whole history to find that run (the old O(account history) path,
 * preserved as {@link maturedBalanceFullScan} for the differential test), read lots NEWEST-first
 * and stop the instant they cover the balance: that is the identical tail, computed from the new
 * end, never touching the already-spent history. Sum the matured ones as we go. The oldest lot in
 * the tail is split by the drain; only its unspent remainder (`remaining`) counts, exactly as the
 * old `fifoTail` split it.
 *
 * Currency-agnostic, so the same call covers spendable credits and a seller's earned balance.
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
  // Zero or negative balance: no remaining lots, nothing cashable.
  if (live.minor <= 0n) {
    return zero(unit);
  }

  let remaining = live.minor;
  let matured = 0n;
  // Walk the newest lots first, a bounded page at a time. The ledger pushes the `order desc
  // limit/offset` down to the engine, so each page is bounded DB work and we stop paging the
  // moment `remaining` hits zero.
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (let lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      // The boundary lot contributes only what's left to cover; a fully-included lot contributes
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
    // The page returned no lots, so the history is exhausted before the balance was covered
    // (only possible if a balance row outran its lots); stop rather than loop forever.
    if (drained === 0) {
      break;
    }
  }
  return toAmount(unit, matured);
}

/**
 * Whether an account has at least `amount` of cashable balance as of `now`, without computing the
 * full matured total. The callers that gate on maturity (requestPayout's payable-funds check,
 * spend's spendable-funds check) only ask "is matured >= amount?", so this answers exactly that and
 * stops the instant it can.
 *
 * Reads the same newest-first FIFO tail as {@link maturedBalance} — the newest run of lots summing
 * to the live balance — accumulating each lot's matured contribution, and returns `true` the moment
 * that running sum reaches `amount`. If the tail is exhausted first (the matured part never covers
 * `amount`), returns `false`. So a request well within cleared funds stops after a lot or two
 * (O(amount-worth-of-lots)); the worst case is the maturity horizon's window, never the full
 * history. By construction this equals `maturedBalance(...).minor >= amount.minor` for every input:
 * identical lots, identical per-lot maturity, just stopped as soon as the answer is settled.
 *
 * `amount` and the account share a currency (the callers pass a CREDIT amount against a CREDIT
 * balance); only the minor units are compared. A non-positive `amount` is trivially covered.
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
      // Same FIFO-tail split as maturedBalance: the boundary lot contributes only what's left to
      // cover the live balance, a fully-included lot its whole amount. Only matured lots count.
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
 * The original full-history implementation, kept verbatim as the oracle the differential test
 * checks the bounded {@link maturedBalance} against. Reads every lot oldest-first, derives the
 * spent amount from the total, keeps the FIFO tail, then sums the matured ones. Correct but
 * O(account history) — the very cost the bounded path removes — so it lives here only for tests,
 * never on the production read path.
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
 * Part of an account's balance still in its settlement wait as of `now`. Cashable and
 * still-waiting amounts sum to the current balance.
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

// A lot trimmed to the two fields the calculation needs: amount and the moment it
// becomes cashable. Keeps each helper simple and maturity computed in one place.
type Settled = { minor: bigint; maturesAt: number };

// Read every lot for the account, oldest first, reduced to Settled. The ledger only
// turns balance-increasing entries into lots, so each amount is positive. Maturity is
// computed from the funding source, not taken from the lot's own maturesAt.
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

// Return the most recent run of lots summing to the current balance. Spends drain
// oldest-first, so spent = (sum of all lots) - (current balance). Walk oldest-first,
// skip the spent amount (splitting the lot spending stopped partway through), keep the rest.
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

// Add up the remaining lots whose wait has elapsed by `now` to get the cashable balance.
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
// The ledger fills a lot's `source` from the original posting's funding info, defaulting
// to the source value 'unknown' when missing, which resolves through the 'default' horizon
// entry (configurable via MATURITY_HORIZON_DEFAULT_MS, and equal to the card horizon only
// under the shipped defaults). So any handler issuing spendable credits must record the
// funding source on the posting (the top-up handler already does), or its credits fall back
// to the default horizon: still safe (never instantly cashable), just less precise than the
// real source.
//
// Maturity is computed as (top-up time) + (source's required wait). We deliberately
// don't trust the lot's own `maturesAt`, which the ledger defaults to the top-up time
// (immediately cashable) when the posting recorded no maturity. Correctness depends only
// on the funding source and top-up time, not on a precomputed maturity time.
