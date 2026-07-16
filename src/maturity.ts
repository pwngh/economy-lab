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

/** The maturity config plus an optional AbortSignal passed through to the ledger's balance read. */
export type MaturityOptions = { config: Config; signal?: AbortSignal };

/**
 * {@link MaturityOptions} plus the `amount` the matured balance must reach. A caller that already
 * has the balance can pass it as `live` to avoid re-reading it; the spend handler does, with the
 * balance read under the lock.
 */
export type MaturedAtLeastOptions = MaturityOptions & {
  amount: Amount;
  live?: Amount;
};

// Horizon lookup key for an unrecognized funding source. The 'default' horizon is configured
// independently through MATURITY_HORIZON_DEFAULT_MS. It coincides with the card horizon only under
// the shipped defaults, so an unknown source settles on its own conservative wait.
const DEFAULT_SOURCE: string = 'default';

/**
 * Returns the wait in milliseconds before credits from a funding source can be cashed out. The wait
 * covers the window in which the payment could still be reversed, such as a card chargeback. A
 * source not in the config falls back to the 'default' horizon, so an unknown or misspelled source
 * is treated cautiously rather than as instantly available.
 */
export function maturityHorizonMs(source: string, config: Config): number {
  const horizons = config.maturityHorizonMs;
  const exact = horizons[source];
  if (exact !== undefined) {
    return exact;
  }
  return horizons[DEFAULT_SOURCE] ?? horizons.card ?? 0;
}

/**
 * Returns the moment in epoch milliseconds a lot matures: the top-up time plus the source's
 * required wait. The wait is computed from `source` rather than read from the lot's own
 * `maturesAt`, because a top-up may record the source without a maturity time. This depends on a
 * caller rule: any handler issuing spendable credits records the funding source on the posting (a
 * missing source falls back to the 'default' horizon, just less precisely).
 */
export function lotMaturesAt(lot: Lot, config: Config): number {
  return lot.toppedUpAt + maturityHorizonMs(lot.source, config);
}

/**
 * Reports whether a lot has matured as of `now`. The boundary is inclusive, so the lot is matured
 * the moment its wait elapses.
 */
export function isMatured(lot: Lot, now: number, config: Config): boolean {
  return lotMaturesAt(lot, config) <= now;
}

// Lots per bounded page. The newest lot or two usually cover the balance, so the common case is
// one round-trip; a wider tail just pulls the next page.
const TAIL_PAGE = 64;

// One slice of the FIFO tail: how much of the live balance a lot covers, whether that slice
// has matured by `now`, and when it does.
type TailSlice = { take: bigint; matured: boolean; maturesAt: number };

// Walks the newest lots first, a bounded page at a time, yielding each lot's slice of the FIFO
// tail until the live balance is covered. The boundary lot contributes only what is left to
// cover; a fully-included lot contributes its whole amount. The ledger pushes the `order desc
// limit/offset` down to the engine, so each page is bounded DB work. An empty page means the
// history ran out before the balance was covered, only possible if a balance row outran its
// lots, so the walk stops rather than loop forever. Both matured-balance reads consume this one
// walker; each applies its own stop rule.
async function* tailSlices(
  ledger: Ledger,
  account: AccountRef,
  liveMinor: bigint,
  options: { now: number; config: Config },
): AsyncGenerator<TailSlice> {
  let remaining = liveMinor;
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (const lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      const take = lot.amount.minor < remaining ? lot.amount.minor : remaining;
      const maturesAt = lotMaturesAt(lot, options.config);
      yield { take, matured: maturesAt <= options.now, maturesAt };
      remaining -= take;
      if (remaining === 0n) {
        return;
      }
    }
    if (drained === 0) {
      return;
    }
  }
}

/**
 * When `amount` would be fully matured, assuming no further postings: the latest matures-at
 * among the earliest-maturing slices that cover it. Null when the live balance cannot cover
 * the amount at all, since maturity is not what blocks it then. Runs only on the
 * FUNDS_IMMATURE rejection path, so walking the whole tail is acceptable.
 */
export async function maturedAvailableAt(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturedAtLeastOptions,
): Promise<number | null> {
  const need = options.amount.minor;
  if (need <= 0n) {
    return now;
  }
  const live =
    options.live ?? (await ledger.balance(account, { signal: options.signal }));
  if (live.minor < need) {
    return null;
  }
  const slices: Array<{ take: bigint; maturesAt: number }> = [];
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    slices.push(slice);
  }
  slices.sort((a, b) => a.maturesAt - b.maturesAt);
  let covered = 0n;
  for (const slice of slices) {
    covered += slice.take;
    if (covered >= need) {
      return slice.maturesAt;
    }
  }
  return null;
}

/**
 * Returns the matured part of an account's balance as of `now`: how much a cash-out may draw
 * without dipping into funds still in their settlement wait. It reads the newest-first FIFO tail and
 * stops the instant the lots cover the live balance, so it never scans the already-spent history.
 * {@link maturedBalanceFullScan} keeps the naive O(account history) version for the differential
 * test. The computation is currency-agnostic, so it covers spendable credits and earned balances
 * alike.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/ Credit maturity}
 * for the dated-lot model, the FIFO tail, and why only the matured run may be drawn.
 */
export async function maturedBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  const live = await ledger.balance(account, { signal: options.signal });
  const unit = currency(account);

  if (live.minor <= 0n) {
    return zero(unit);
  }

  let matured = 0n;
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    if (slice.matured) {
      matured += slice.take;
    }
  }
  return toAmount(unit, matured);
}

/**
 * Reports whether an account has at least `amount` of matured balance as of `now`, short-circuiting
 * once the matured running sum reaches `amount`. Equals `maturedBalance(...).minor >= amount.minor`
 * but stops early, so a request well within cleared funds costs O(amount-worth-of-lots). A
 * non-positive `amount` is trivially covered.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/concepts/credit-maturity/ Credit maturity}
 *   for the dated-lot model behind the running sum.
 */
export async function maturedAtLeast(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturedAtLeastOptions,
): Promise<boolean> {
  const need = options.amount.minor;
  if (need <= 0n) {
    return true;
  }
  const live =
    options.live ?? (await ledger.balance(account, { signal: options.signal }));
  if (live.minor <= 0n) {
    return false;
  }

  // The same walk as maturedBalance, but the running sum stops the walk the moment it covers
  // `need` — returning ends the generator, so no further page is read.
  let matured = 0n;
  for await (const slice of tailSlices(ledger, account, live.minor, {
    now,
    config: options.config,
  })) {
    if (slice.matured) {
      matured += slice.take;
      if (matured >= need) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Computes the matured balance by scanning the full history: kept verbatim as the oracle the
 * differential test checks the bounded {@link maturedBalance} against. Correct but O(account
 * history), so it lives here only for tests and never on the production read path.
 */
export async function maturedBalanceFullScan(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  const live = await ledger.balance(account, { signal: options.signal });
  const unit = currency(account);
  if (live.minor <= 0n) {
    return zero(unit);
  }

  const lots = await collectLots(ledger, account, options.config);
  const tail = fifoTail(lots, live.minor);
  return sumMatured(tail, now, unit);
}

/**
 * Returns the part of an account's balance still in its settlement wait as of `now`. The matured
 * and still-waiting amounts sum to the current balance.
 */
export async function immatureBalance(
  ledger: Ledger,
  account: AccountRef,
  now: number,
  options: MaturityOptions,
): Promise<Amount> {
  const live = await ledger.balance(account, { signal: options.signal });
  const matured = await maturedBalance(ledger, account, now, options);
  return toAmount(currency(account), live.minor - matured.minor);
}

// --- Which lots are left, then which have matured --------------------

type Settled = { minor: bigint; maturesAt: number };

// Reads every lot for the account, oldest first. The ledger only turns balance-increasing entries
// into lots, so each amount is positive.
async function collectLots(
  ledger: Ledger,
  account: AccountRef,
  config: Config,
): Promise<Settled[]> {
  const lots: Settled[] = [];
  for await (const lot of ledger.timeline(account)) {
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
  const total = lots.reduce((sum, lot) => sum + lot.minor, 0n);
  let toDrain = total - balanceMinor;
  if (toDrain <= 0n) {
    return [...lots];
  }
  const tail: Settled[] = [];
  for (const lot of lots) {
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

function sumMatured(
  tail: ReadonlyArray<Settled>,
  now: number,
  unit: Amount['currency'],
): Amount {
  let matured = zero(unit);
  for (const lot of tail) {
    if (lot.maturesAt <= now) {
      matured = add(matured, toAmount(unit, lot.minor));
    }
  }
  return matured;
}
