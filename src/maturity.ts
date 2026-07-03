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
 * matured balance must reach. The `amount` rides in the options object rather than as its own
 * argument so the call stays parallel to {@link maturedBalance}'s `(ledger, account, now, options)`
 * and under the param-count limit. A caller that already has the balance can pass it as `live` to avoid
 * re-reading it; the spend handler does, with the balance read under the lock.
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
 * Returns the moment in epoch milliseconds a lot matures, which is the top-up time plus the
 * source's required wait. A lot is one batch of credits from a single top-up, tagged with when it
 * was added and its funding source. The wait is computed here from `source` rather than read from
 * the lot's own `maturesAt`, because a top-up may record the source without a maturity time.
 * This depends on a caller rule: any handler issuing spendable credits records the funding source
 * on the posting (a missing source falls back to the 'default' horizon, just less precisely).
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

// How many lots to read from the ledger per bounded page. Most balances are covered by the newest
// lot or two, so the first page almost always suffices. A wider tail, such as many small unspent
// top-ups, just pulls the next page. The size keeps the common case to one round-trip while
// bounding memory.
const TAIL_PAGE = 64;

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

  let remaining = live.minor;
  let matured = 0n;
  // Walk the newest lots first, a bounded page at a time. The ledger pushes the `order desc
  // limit/offset` down to the engine, so each page is bounded DB work. Paging stops the moment
  // `remaining` hits zero.
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (const lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      // The boundary lot contributes only what is left to cover. A fully-included lot contributes
      // its whole amount.
      const take = lot.amount.minor < remaining ? lot.amount.minor : remaining;
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

  let remaining = live.minor;
  let matured = 0n;
  for (let offset = 0; remaining > 0n; offset += TAIL_PAGE) {
    let drained = 0;
    for await (const lot of ledger.timeline(account, {
      order: 'desc',
      limit: TAIL_PAGE,
      offset,
    })) {
      drained += 1;
      // This is the same FIFO-tail split as maturedBalance. The boundary lot contributes only what
      // is left to cover the live balance, and a fully-included lot contributes its whole amount.
      // Only matured lots count.
      const take = lot.amount.minor < remaining ? lot.amount.minor : remaining;
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
 * Computes the matured balance by scanning the full history. This is the original implementation,
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

// Reads every lot for the account, oldest first, reduced to Settled. The ledger only turns
// balance-increasing entries into lots, so each amount is positive. Maturity is computed from the
// funding source, not taken from the lot's own maturesAt.
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

// Adds up the remaining lots whose wait has elapsed by `now` to get the matured balance.
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
