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

// Horizon lookup key for an unrecognized funding source. loadConfig sets 'default'
// to the same (long) horizon as a card, so an unknown source never settles faster
// than a card.
let DEFAULT_SOURCE: string = 'default';

/**
 * Wait (ms) before credits from a funding source can be cashed out, covering the
 * window in which the payment could still be reversed (e.g. a card chargeback).
 * Sources not in the config fall back to the 'default' (card) horizon, so an
 * unknown or misspelled source is treated cautiously rather than instantly available.
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

/**
 * Cashable part of an account's balance as of `now`: how much a cash-out may draw without
 * dipping into funds still in their settlement wait.
 *
 * Spends draw oldest-first (FIFO), so what's left is the most recent run of lots. Work out
 * that run, then sum only the lots whose wait has elapsed. Currency-agnostic, so the same
 * call covers spendable credits and a seller's earned balance.
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
