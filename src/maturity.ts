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
 * Bundled into a single parameter so the read functions below stay within the
 * project's limit on parameter count while still being able to pass the caller's
 * AbortSignal through to the ledger's balance read.
 */
export type MaturityOptions = { config: Config; signal?: AbortSignal };

// The key used to look up the horizon for a funding source we don't recognize.
// loadConfig sets the 'default' entry to the same (long) horizon as a card, so an
// unknown source is never treated as settling faster than a card would.
let DEFAULT_SOURCE: string = 'default';

/**
 * How long (in milliseconds) credits from a given funding source must wait before
 * they can be cashed out. The wait covers the window in which that payment could
 * still be reversed (for example, a card chargeback). If the source isn't in the
 * config, fall back to the 'default' (card) horizon, so an unknown or misspelled
 * source is treated cautiously rather than as instantly available.
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
 * The moment (epoch ms) a lot becomes cashable. A lot is one batch of credits created by
 * a single top-up, tagged with when it was added and which funding source paid for it.
 * A lot matures at the time it was topped up plus the wait its funding source requires.
 * The wait is computed here from the lot's
 * `source` rather than read from the lot's own `maturesAt` field, because a top-up may
 * record the source without filling in a maturity time. Computing it here means the lot
 * still gets the correct, cautious settlement time.
 */
export function lotMaturesAt(lot: Lot, config: Config): number {
  return lot.toppedUpAt + maturityHorizonMs(lot.source, config);
}

/**
 * Whether a lot has become cashable as of `now`. The comparison is inclusive: credits
 * are cashable the exact moment their wait elapses, not a millisecond after.
 */
export function isMatured(lot: Lot, now: number, config: Config): boolean {
  return lotMaturesAt(lot, config) <= now;
}

/**
 * The cashable part of an account's balance as of `now` — how much a cash-out may draw
 * without dipping into funds that are still in their settlement wait.
 *
 * Earlier spends always drew from the oldest credits first (FIFO), so whatever is left
 * in the account is the most recent run of lots. This works out that most-recent run,
 * then adds up only the lots whose wait has already elapsed. It works for any currency,
 * so the same call covers both spendable credits and a seller's earned balance.
 */
export async function maturedBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  let live = await ledger.balance(account, { signal: options.signal });
  let unit = currency(account);
  // A zero or negative balance leaves no remaining lots, so nothing can be cashed out.
  if (live.minor <= 0n) {
    return zero(unit);
  }

  let lots = await collectLots(ledger, account, options.config);
  let tail = fifoTail(lots, live.minor);
  return sumMatured(tail, now, unit);
}

/**
 * The part of an account's balance that is still in its settlement wait as of `now`,
 * reported alongside the cashable part. The cashable and still-waiting amounts always
 * add up to the account's current balance.
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

// --- Working out which lots are left, then which have matured --------------------

// A lot trimmed down to just the two fields the calculation needs: its amount and the
// moment it becomes cashable. Working with this small shape (instead of the full Lot)
// keeps each helper simple and means maturity is computed in exactly one place.
type Settled = { minor: bigint; maturesAt: number };

// Read every lot for the account, oldest first, and reduce each to the small Settled
// shape. The ledger only turns balance-increasing entries into lots, so each amount is
// positive. The maturity time is computed here from the lot's funding source, not taken
// from the lot's own maturesAt field.
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

// Return the most recent run of lots that adds up to the current balance. Spends always
// drained the oldest lots first, so the amount already spent is (sum of all lots) minus
// (current balance). Walk the lots oldest first, skip over that spent amount — splitting
// the one lot the spending stopped partway through — and keep what remains.
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
// The ledger fills in a lot's `source` from the funding info stored on the original
// posting, defaulting to 'unknown' (which maps to the card horizon) when it's missing.
// So any handler that issues spendable credits MUST record the funding source on the
// posting — as the top-up handler already does — or its credits fall back to the card
// horizon: still safe (never instantly cashable), just less precise than the real
// source would give.
//
// This module computes maturity as (top-up time) + (the source's required wait). It
// deliberately does NOT trust the lot's own `maturesAt` field — the ledger defaults that
// field to the top-up time itself (i.e. immediately cashable) when the posting recorded
// no maturity. Correctness here depends only on the funding source and the top-up time,
// never on a handler having also filled in a precomputed maturity time.
